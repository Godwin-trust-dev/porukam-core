"""Подписчик apps.notifications на ВСЕ outbox-события (settings.
OUTBOX_SUBSCRIBERS["*"], common/relay.py) — сам решает, по какому топику и
кому создавать уведомление, через реестры settings.NOTIFICATION_TOPIC_
ADDRESSEE_TEMPLATES / NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES (docs/tasks/
fundament.md ЭФ.4: «подписка на доменные события из outbox → создание
уведомлений по реестру топик → шаблон, данные»; ADR-126 — вторая аудитория,
ADR-178 — первая аудитория сужена до адресных уведомлений, самоуведомление
актора убрано).

Идемпотентность (CLAUDE.md, ADR-064 «at-least-once на уровне события»):
ЕСТЬ, по `Notification.source_event_id`. Раньше её сознательно не было —
дубль уведомления не искажал юрфакт доставки. С ADR-126 одно событие могло
породить до двух уведомлений (адресат + обе стороны), и повторная доставка
(другой подписчик того же топика упал — реле переотдаёт событие ВСЕМ
подписчикам) размножала бы ленту кратно. Две линии защиты, как у
apps.reputation.subscriber: предпроверка `_already_placed` до вызова
place_notification и UniqueConstraint (recipient, template, source_event_id)
в БД — IntegrityError на гонке ловим и считаем успехом, а не сбоем
доставки."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError

from apps.accounts.models import User
from common.models import OutboxEvent

from . import services
from .models import Notification, NotificationTemplate

logger = logging.getLogger(__name__)

# Ключ-фолбэк словарной записи реестра (см. докстринг реестра в base.py).
_ANY_ACTION = "*"

# ADR-156: правки материалов этапа в согласовании. В реестрах топик->шаблон
# их НЕТ намеренно — реестры размещают карточку НА КАЖДОЕ событие, а здесь
# нужна ровно обратная вещь: пачка правок = одна карточка. Поэтому топики
# перехватываются до реестров и уходят в окно схлопывания
# (services.register_materials_change).
_MATERIALS_CHANGE_TOPICS: dict[str, str] = {
    "milestone.material_added": "added",
    "milestone.material_updated": "updated",
    "milestone.material_removed": "removed",
}
# Единственный статус согласования, в котором правка материалов адресована
# второй стороне. В `draft` договор ей ещё не показан (ADR-156): уведомление
# о правке того, чего человек не видел, — шум, а не факт.
_UNDER_REVIEW = "under_review"


def handle_event(event: OutboxEvent) -> None:
    """До двух аудиторий одного события (ADR-126, сужено ADR-178):

    - адресат (`settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES`): получатель
      — ТОЛЬКО явный `payload["notify_user_id"]`, БЕЗ фолбэка на
      `event.actor.user_id` (заявка в объединение адресуется лидеру,
      приглашение — приглашённому; apps.social не может звать
      place_notification напрямую — import-linter «social зависит только от
      accounts»). До ADR-178 фолбэк на actor.user_id был, и вместе с ним
      каждое действие по договору рождало карточку самому актору — жалоба
      владельца 11.09 «уведомления должны приходить только по действиям
      контрагентов, не моих» ровно про это;
    - контрагент (`settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES`):
      стороны договора события КРОМЕ актора; у системных событий без актора
      (дедлайн-свип, авто-исход спора) — обе стороны. Договор — из subject
      (`type=contract` либо `subject.contract_id`), иначе payload.contract_id.
      Актор для исключения — ВСЕГДА `event.actor.user_id` (реальный автор
      действия), а не `notify_user_id`: они разные вещи и в паре с адресным
      реестром никогда не пересекаются одним и тем же топиком.

    Оба реестра — данные (topic -> код шаблона либо action -> код);
    отсутствие строки NotificationTemplate — warning и пропуск, НЕ падение
    реле: иначе одно незасеянное имя шаблона застопорило бы всю очередь
    событий ретраями."""
    materials_change = _MATERIALS_CHANGE_TOPICS.get(event.topic)
    if materials_change is not None:
        _handle_materials_change(event, change=materials_change)
        return

    addressee_templates: dict[str, Any] = getattr(
        settings, "NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES", {}
    )
    counterparty_templates: dict[str, Any] = getattr(
        settings, "NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES", {}
    )
    payload = event.payload or {}
    addressee_code = _resolve_template_code(addressee_templates.get(event.topic), payload)
    counterparty_code = _resolve_template_code(counterparty_templates.get(event.topic), payload)
    if addressee_code is None and counterparty_code is None:
        return

    actor_user_id = str((event.actor or {}).get("user_id") or "")

    if addressee_code is not None:
        addressee_id = str(payload.get("notify_user_id") or "")
        if not addressee_id:
            logger.info(
                "notifications: событие %s (%s) без payload.notify_user_id — "
                "адресату класть некуда",
                event.topic,
                event.event_id,
            )
        else:
            addressee = _load_user(addressee_id, event=event)
            if addressee is not None:
                _place(event, recipient=addressee, template_code=addressee_code)

    if counterparty_code is not None:
        for recipient in _counterparty_recipients(event, actor_id=actor_user_id):
            _place(event, recipient=recipient, template_code=counterparty_code)


def _resolve_template_code(spec: Any, payload: dict[str, Any]) -> str | None:
    """Запись реестра -> код шаблона. Строка — как есть; словарь — выбор по
    дискриминатору с фолбэком на "*". Дискриминатор — `payload["action"]`
    (что сделал актор: `negotiation.revised` — один топик, три разных для
    контрагента факта — правку предложили / приняли / отклонили), иначе
    `payload["cause"]` (почему событие случилось само: `amendment.rejected`
    с `cause=discount_declined` — допник скидки закрыт отказом от скидки).
    Явный `None` под ключом — уведомления по этому варианту НЕТ (о моменте
    уже говорит соседнее событие, ADR-126 §4); отсутствующий ключ — "*"."""
    if spec is None or isinstance(spec, str):
        return spec
    discriminator = str(payload.get("action") or payload.get("cause") or "")
    code = spec[discriminator] if discriminator in spec else spec.get(_ANY_ACTION)
    return str(code) if code else None


def _load_user(user_id: str, *, event: OutboxEvent) -> User | None:
    try:
        return User.objects.get(pk=user_id)
    except (User.DoesNotExist, ValueError, ValidationError):
        logger.warning("notifications: user_id=%s из события %s не найден", user_id, event.event_id)
        return None


def _event_contract_id(event: OutboxEvent) -> UUID | None:
    """Договор события: subject.contract_id (события milestone/dispute/
    evidence кладут его рядом с собственным id), иначе subject.id при
    type=contract, иначе payload.contract_id (события amendment.* — субъект
    там сам допник)."""
    subject = event.subject or {}
    raw = subject.get("contract_id") or (
        subject.get("id") if subject.get("type") == "contract" else None
    )
    raw = raw or (event.payload or {}).get("contract_id")
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except ValueError:
        return None


def _counterparty_recipients(event: OutboxEvent, *, actor_id: str) -> list[User]:
    """Стороны договора события минус актор. Импорт локальный — тот же приём,
    что `services._enrich_payload` (apps.contracts.services сам импортирует
    apps.notifications.services, цикла на уровне модулей не заводим)."""
    from apps.contracts import selectors as contract_selectors

    contract_id = _event_contract_id(event)
    if contract_id is None:
        logger.info(
            "notifications: событие %s (%s) без договора — контрагента не определить",
            event.topic,
            event.event_id,
        )
        return []
    contract = contract_selectors.get_contract(contract_id)
    if contract is None:
        return []
    return [u for u in contract_selectors.party_users(contract) if str(u.id) != actor_id]


def _place(event: OutboxEvent, *, recipient: User, template_code: str) -> None:
    template = NotificationTemplate.objects.filter(code=template_code).first()
    if template is None:
        logger.warning(
            "notifications: для топика %s настроен шаблон %s, но строки"
            " NotificationTemplate нет — уведомление не создано",
            event.topic,
            template_code,
        )
        return
    if Notification.objects.filter(
        recipient=recipient, template=template.code, source_event_id=event.event_id
    ).exists():
        return
    subject = event.subject or {}
    try:
        services.place_notification(
            recipient=recipient,
            template=template.code,
            payload=event.payload,
            legal_significance=template.legal_significance,
            subject_type=subject.get("type"),
            subject_id=subject.get("id"),
            subject_contract_id=subject.get("contract_id"),
            source_event_id=event.event_id,
        )
    except IntegrityError:
        # Гонка с параллельной доставкой того же события: UniqueConstraint
        # отработал вторым эшелоном. place_notification — вложенный atomic
        # (savepoint), поэтому внешняя транзакция реле цела.
        logger.info(
            "notifications: уведомление по событию %s для %s уже размещено (гонка доставки)",
            event.event_id,
            recipient.id,
        )


def _handle_materials_change(event: OutboxEvent, *, change: str) -> None:
    """ADR-156: правка материалов -> строка ожидания у ВТОРОЙ стороны.

    Три условия отсечки, каждое — отдельным ранним выходом:
    - договор не в `under_review` (черновик, либо уже подписан и правка
      прилетела из истории) — молчим;
    - актора нет (событие материалов всегда пользовательское; событие без
      актора — не наш случай, и адресовать «всем сторонам», как это делает
      реестр контрагента для свипов, здесь неверно: непонятно, кто правил);
    - этап не определить — карточка называет этап, без него текста нет."""
    from apps.contracts import selectors as contract_selectors

    contract_id = _event_contract_id(event)
    if contract_id is None:
        return
    contract = contract_selectors.get_contract(contract_id)
    if contract is None or contract.negotiation_status != _UNDER_REVIEW:
        return

    payload = event.payload or {}
    subject = event.subject or {}
    raw_milestone = (
        subject.get("id") if subject.get("type") == "milestone" else payload.get("milestone_id")
    )
    try:
        milestone_id = UUID(str(raw_milestone))
    except (TypeError, ValueError):
        logger.info(
            "notifications: событие %s (%s) без этапа — правку материалов не адресовать",
            event.topic,
            event.event_id,
        )
        return

    actor_raw = str((event.actor or {}).get("user_id") or "")
    try:
        actor_id = UUID(actor_raw)
    except ValueError:
        return

    for recipient in _counterparty_recipients(event, actor_id=actor_raw):
        services.register_materials_change(
            recipient=recipient,
            contract_id=contract.id,
            milestone_id=milestone_id,
            milestone_title=str(payload.get("milestone_title") or ""),
            actor_id=actor_id,
            change=change,
            source_event_id=event.event_id,
        )
