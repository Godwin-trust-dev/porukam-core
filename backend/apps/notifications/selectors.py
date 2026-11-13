"""Read-слой apps.notifications."""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models import Count, Q, QuerySet
from django.shortcuts import get_object_or_404
from django.utils import timezone

from apps.accounts.models import User
from apps.l10n import selectors as l10n_selectors

from .models import (
    MATERIALS_CHANGED_TEMPLATE,
    DeviceToken,
    Notification,
    NotificationTemplate,
    PushSubscription,
)


def list_for_recipient(user: User) -> QuerySet[Notification]:
    """GET /notifications — свои уведомления, новые сверху. Второй ключ
    сортировки (`-id`, uuid7 — монотонный) нужен курсорной пагинации ленты:
    без него порядок внутри одной микросекунды `created_at` не определён и
    страница может потерять или удвоить пункт на границе."""
    return Notification.objects.filter(recipient=user).order_by("-created_at", "-id")


def list_push_subscriptions(user: User) -> QuerySet[PushSubscription]:
    """Все Web Push подписки пользователя (ADR-110) — читает WebPushProvider."""
    return PushSubscription.objects.filter(user=user)


def list_device_tokens(user: User) -> QuerySet[DeviceToken]:
    """Все токены нативных пуш-провайдеров пользователя (ADR-176) — читает
    NativePushProvider. Порядок стабильный (сначала свежие устройства), чтобы
    статус попытки доставки не «прыгал» между одинаковыми прогонами."""
    return DeviceToken.objects.filter(user=user).order_by("-last_seen_at", "-id")


# ── Лента ЛК (DEV-14 §7, отсмотр прода 2026-08-18 №1/№2) ─────────────────────
# Фронт ждёт НЕ сырые записи, а отрезолвленные пункты ленты: type задаёт иконку,
# severity — окраску, группа-канал — вкладки фильтра. Маппинг «шаблон -> пункт»
# живёт здесь (read-слой): шаблон — внутренняя валюта place_notification, фронту
# она не видна. Неизвестный шаблон -> нейтральные переговоры (пункт не теряем:
# лента — юрканал, ADR-057).

_FEED_DEFAULT: tuple[str, str] = ("negotiation", "normal")
_FEED_TEMPLATE_TYPES: dict[str, tuple[str, str]] = {
    "negotiation.sent": ("negotiation", "normal"),
    "negotiation.revised": ("negotiation", "normal"),
    "negotiation.frozen": ("negotiation", "normal"),
    "signature_requested": ("signature", "due"),
    "negotiation.signed": ("signed", "good"),
    "contract.signed": ("signed", "good"),
    "contract.completed": ("accepted", "good"),
    "milestone.started": ("stage_submitted", "normal"),
    "milestone_submitted_for_acceptance": ("stage_submitted", "due"),
    "milestone_acceptance_reminder": ("deadline", "due"),
    "milestone.accepted": ("accepted", "good"),
    "milestone.auto_accepted": ("accepted", "good"),
    "milestone.rejected": ("dispute", "due"),
    "milestone_material_notice": ("stage_submitted", "normal"),
    "evidence_received": ("stage_submitted", "normal"),
    "dispute.opened": ("dispute", "due"),
    "dispute.resolved": ("dispute", "good"),
    # ADR-112: новое сообщение в переписке договора (apps.messaging).
    "message.received": ("message", "normal"),
    # ADR-126 — вторая аудитория события и платёжный контур. Тип "payment"
    # существовал в проекции с самого начала, но НИ ОДИН шаблон на него не
    # ссылался: вкладка «Платежи» ленты была пуста по построению, а тумблер
    # group_payments нечего было глушить (отсмотр 25.08 «уведомления не
    # приходят при действиях по оплате»).
    # ADR-155: топик `milestone.advance_confirmed` больше не публикуется
    # (вид платежа `advance` и способ `prepayment` упразднены), но коды
    # шаблонов ОСТАВЛЕНЫ — по ним проецируется лента УЖЕ размещённых
    # уведомлений: этот реестр ключуется кодом шаблона на строке
    # Notification, а не топиком события.
    "milestone.advance_confirmed": ("payment", "normal"),
    "milestone.advance_confirmed.counterparty": ("payment", "normal"),
    "milestone.payment_confirmed": ("payment", "normal"),
    "milestone.payment_confirmed.counterparty": ("payment", "normal"),
    "milestone.paid": ("payment", "good"),
    # Переговоры «глазами контрагента» — тот же тип, что у актора.
    "negotiation.sent.counterparty": ("negotiation", "due"),
    "negotiation.revised.proposed": ("negotiation", "due"),
    "negotiation.revised.accepted": ("negotiation", "good"),
    "negotiation.revised.rejected": ("negotiation", "normal"),
    "negotiation.withdrawn": ("negotiation", "normal"),
    "negotiation.rejected": ("negotiation", "normal"),
    "negotiation.reopened": ("negotiation", "due"),
    "negotiation.signed.counterparty": ("signature", "due"),
    "negotiation.signature_request_expired": ("deadline", "due"),
    "contract.amended": ("signed", "good"),
    "amendment.sent": ("negotiation", "due"),
    # 26.08 (ADR-075): допник отклонён / отозван — как `negotiation.rejected`/
    # `negotiation.withdrawn`, тот же тип «переговоры».
    "amendment.rejected": ("negotiation", "normal"),
    "amendment.withdrawn": ("negotiation", "normal"),
    "contract.terminated": ("negotiation", "due"),
    "contract.closed": ("accepted", "good"),
    # ADR-156: правки материалов в согласовании — факт переговоров (карточка
    # приходит ДО подписания), поэтому тип `negotiation`/вкладка «Сделки», а
    # вес `due`: изменённые материалы надо просмотреть до подписи.
    MATERIALS_CHANGED_TEMPLATE: ("negotiation", "due"),
    # ADR-155: «передано» и «получено» — два шага одного факта, одна и та
    # же вкладка ленты и тот же вес.
    "milestone.material_handed_over": ("stage_submitted", "normal"),
    "milestone.material_received": ("stage_submitted", "normal"),
    "milestone.resumed": ("stage_submitted", "normal"),
    # ADR-130 (Э5): собственно платёжные события — выставление счёта,
    # просрочка, отзыв счёта. Подтверждения оплаты остаются на
    # `milestone.*`-шаблонах выше (второго уведомления на тот же момент
    # быть не должно).
    "payment.created": ("payment", "due"),
    "payment.overdue": ("payment", "due"),
    "payment.cancelled": ("payment", "normal"),
    "payment.cancelled.counterparty": ("payment", "normal"),
    # Этап 7 (ADR-131): контур разногласий и гарантии. Тип `dispute` уже
    # спроецирован на группу `disputes` — новых ТИПОВ ленты фронту не
    # добавляется, иконка и окраска для них уже есть.
    "dispute.fix_requested": ("dispute", "due"),
    "dispute.fix_resubmitted": ("stage_submitted", "due"),
    "dispute.responded": ("dispute", "normal"),
    "dispute.discount_proposed": ("dispute", "due"),
    "dispute.discount_declined": ("dispute", "normal"),
    "dispute.cap_reached": ("dispute", "due"),
    "dispute.window_expired": ("deadline", "due"),
    "dispute.window_contested": ("dispute", "normal"),
    "warranty.claim_submitted": ("dispute", "due"),
    "warranty.claim_resolved": ("dispute", "good"),
    "warranty.claim_declined": ("dispute", "due"),
    # Э6 (ADR-136): RetentionTimer доказательств (ADR-036) — сроки хранения
    # во вкладку «Сроки», сам перевод в архив / уничтожение — в «Сделки».
    "evidence.retention_expiring": ("deadline", "due"),
    "evidence.archived": ("stage_submitted", "normal"),
    "evidence.shredded": ("deadline", "normal"),
    # ADR-139: доказательный пакет собран — тип `archive_ready` существовал в
    # проекции (зеркало мока фронта) без единого шаблона до этой ветки.
    "archive.ready": ("archive_ready", "good"),
    # ADR-138: сделка без движения. Предупреждение и отсрочка — «Дедлайны»
    # (срок, который сторона ещё может отодвинуть действием); само
    # автозакрытие — исход дедлайна, там же, но без окраски «срочно».
    "contract.idle_warning": ("deadline", "due"),
    "contract.idle_blocked": ("deadline", "due"),
    "contract.auto_closed": ("deadline", "normal"),
    # ADR-133: цикл «устранил -> подтвердил / не устранено» — та же группа
    # «Разногласия»; окно подтверждения — тип `deadline` (как истечение окон).
    "warranty.fix_submitted": ("dispute", "due"),
    "warranty.claim_satisfied": ("dispute", "good"),
    "warranty.claim_contested": ("dispute", "due"),
    "warranty.claim_auto_satisfied": ("deadline", "good"),
    # ADR-133 доп. 26.08: серия напоминаний по окну подтверждения — как
    # `milestone_acceptance_reminder`.
    "warranty_claim_acceptance_reminder": ("deadline", "due"),
}

# Тип -> группа-канал (зеркало TYPE_GROUP мока web/src/mocks/notificationsDb.ts).
# Отсмотр 2026-08-24: сообщения чата — своя складка «Чаты» (раньше тонули в
# «Сделках» без классификации).
FEED_CHANNEL_GROUPS: tuple[str, ...] = ("deals", "chats", "payments", "deadlines", "disputes")
_FEED_TYPE_GROUP: dict[str, str] = {
    "negotiation": "deals",
    "message": "chats",
    "signature": "deals",
    "signed": "deals",
    "stage_submitted": "deals",
    "accepted": "deals",
    "invite_accepted": "deals",
    "archive_ready": "deals",
    "payment": "payments",
    "deadline": "deadlines",
    "dispute": "disputes",
}

FEED_FILTERS: tuple[str, ...] = ("all", "unread", *FEED_CHANNEL_GROUPS)


def channel_group_for_template(template: str) -> str:
    """Группа-канал уведомления по его шаблону — та же проекция, что у ленты
    (_FEED_TEMPLATE_TYPES → _FEED_TYPE_GROUP). Нужна place_notification для
    гейта push/email по настройкам групп (DEV-14 §7, №10 отсмотра):
    вкладка ленты и глушение доставки обязаны считать группу одинаково."""
    feed_type, _severity = _FEED_TEMPLATE_TYPES.get(template, _FEED_DEFAULT)
    return _FEED_TYPE_GROUP.get(feed_type, "deals")


class _SafeFormatDict(dict):  # type: ignore[type-arg]
    """format_map без KeyError: неизвестный плейсхолдер остаётся как есть —
    тексты пакетов (l10n) могут ссылаться на ключи, которых нет в payload."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _feed_time_group(created_at: datetime, *, now: datetime) -> str:
    """today/yesterday/earlier — по календарным суткам (как в моке)."""
    diff = (timezone.localdate(now) - timezone.localdate(created_at)).days
    if diff <= 0:
        return "today"
    if diff == 1:
        return "yesterday"
    return "earlier"


@dataclass(frozen=True)
class FeedContractContext:
    """Живая мета договора для пункта ленты (отсмотр прода 2026-08-20).

    До этого мета клалась в payload один раз — в момент размещения
    (`services._enrich_payload`, ADR-098). На проде это дало две дыры:
    записи, размещённые ДО выката обогащения, навсегда остались без ссылки,
    контрагента и суммы (payload append-only — дописать нельзя), а сумма
    договора, меняющаяся до заморозки, застывала на момент события.
    Теперь мета резолвится ПРИ ЧТЕНИИ ленты из текущего состояния договора;
    payload — фолбэк для договоров, которых уже нет."""

    contract_id: UUID
    number: str
    title: str
    counterparty_name: str | None = None
    counterparty_profile_id: str | None = None
    amount: Decimal | None = None
    currency: str | None = None
    extra: dict[str, str] = field(default_factory=dict)


def _contract_short_number(contract_id: UUID) -> str:
    """Зеркало services._contract_short_number (последние 6 hex UUID) — тот
    же номер в тексте и в мете, selectors.py не импортирует services.py."""
    return str(contract_id).replace("-", "")[-6:].upper()


def _as_uuid(raw: Any) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except ValueError:
        return None


def _notification_contract_ids(
    notifications: list[Notification],
) -> dict[UUID, UUID]:
    """notification.id → contract.id. Колонка `contract_id` (ADR-098), иначе
    payload «прямых» шаблонов: contract_id, либо milestone_id → договор
    этапа (одним запросом на всю ленту). Старые записи без всего этого
    остаются без ссылки — это честно, у них договора нет и в данных."""
    result: dict[UUID, UUID] = {}
    by_milestone: dict[UUID, list[UUID]] = {}
    for n in notifications:
        payload = n.payload or {}
        found = n.contract_id or _as_uuid(payload.get("contract_id"))
        if found is not None:
            result[n.id] = found
            continue
        milestone_id = _as_uuid(payload.get("milestone_id"))
        if milestone_id is not None:
            by_milestone.setdefault(milestone_id, []).append(n.id)
    if by_milestone:
        from apps.milestones.models import Milestone

        rows = Milestone.objects.filter(pk__in=by_milestone).values_list("pk", "contract_id")
        for milestone_id, contract_id in rows:
            for notification_id in by_milestone[milestone_id]:
                result[notification_id] = contract_id
    return result


def _milestone_titles(notifications: list[Notification]) -> dict[UUID, str]:
    """milestone_id → title для записей, у которых в payload нет
    milestone_title (прямые шаблоны этапов до обогащения)."""
    wanted = {
        mid
        for n in notifications
        if (payload := n.payload or {}).get("milestone_id") and not payload.get("milestone_title")
        if (mid := _as_uuid(payload["milestone_id"])) is not None
    }
    if not wanted:
        return {}
    from apps.milestones.models import Milestone

    return dict(Milestone.objects.filter(pk__in=wanted).values_list("pk", "title"))


def feed_contract_contexts(
    notifications: list[Notification], *, user: User
) -> dict[UUID, FeedContractContext]:
    """notification.id → FeedContractContext по текущему состоянию договоров.
    Договоры грузятся одним запросом со сторонами; контрагент — ОТНОСИТЕЛЬНО
    получателя (`contract_selectors.resolve_counterparty`); сумма — тем же
    `total_leaf_amount`, что и карточка договора (черновик без этапов или
    разные валюты — суммы нет, ключей нет). Импорты локальные — тот же
    цикл-риск apps.contracts → apps.notifications, что в services.py."""
    from apps.contracts import selectors as contract_selectors
    from apps.milestones import services as milestones_services
    from apps.profiles import selectors as profile_selectors

    ids_by_notification = _notification_contract_ids(notifications)
    if not ids_by_notification:
        return {}
    contracts = {
        c.id: c for c in contract_selectors.list_contracts_by_ids(set(ids_by_notification.values()))
    }
    contexts: dict[UUID, FeedContractContext] = {}
    for contract_id, contract in contracts.items():
        number = _contract_short_number(contract_id)
        kwargs: dict[str, Any] = {
            "contract_id": contract_id,
            "number": number,
            "title": contract.title or f"№ {number}",
        }
        try:
            other = contract_selectors.resolve_counterparty(contract, user)
        except contract_selectors.PartyNotFoundError:
            other = None
        if other is not None:
            kwargs["counterparty_profile_id"] = str(other.profile_id)
            kwargs["counterparty_name"] = profile_selectors.public_display_name(other.profile)
        try:
            total = milestones_services.total_leaf_amount(contract)
        except ValueError:
            pass
        else:
            kwargs["amount"] = total.amount
            kwargs["currency"] = total.currency
        contexts[contract_id] = FeedContractContext(**kwargs)
    return {
        notification_id: contexts[contract_id]
        for notification_id, contract_id in ids_by_notification.items()
        if contract_id in contexts
    }


def _feed_text_payload(
    notification: Notification,
    ctx: FeedContractContext | None,
    milestone_titles: dict[UUID, str],
) -> dict[str, Any]:
    """Подстановки для текста и меты пункта: живой договор ПОВЕРХ payload
    (payload не меняется — content_hash неприкосновенен, это презентация).
    Ключи contract_title/number/counterparty_*/amount/currency никто из
    издателей событий не кладёт сам — они только от обогащения при
    размещении (снимок), поэтому текущее состояние договора приоритетнее;
    payload остаётся фолбэком для удалённого договора."""
    payload = dict(notification.payload or {})
    if ctx is not None:
        payload["contract_title"] = ctx.title
        payload["contract_number"] = ctx.number
        if ctx.counterparty_name:
            payload["counterparty_name"] = ctx.counterparty_name
        if ctx.counterparty_profile_id:
            payload["counterparty_profile_id"] = ctx.counterparty_profile_id
        if ctx.amount is not None and ctx.currency:
            payload["amount"] = str(ctx.amount)
            payload["currency"] = ctx.currency
    if not payload.get("milestone_title"):
        milestone_id = _as_uuid(payload.get("milestone_id"))
        if milestone_id is not None and milestone_id in milestone_titles:
            payload["milestone_title"] = milestone_titles[milestone_id]
    return payload


def _feed_item(
    notification: Notification,
    *,
    locale: str,
    now: datetime,
    ctx: FeedContractContext | None = None,
    milestone_titles: dict[UUID, str] | None = None,
) -> dict[str, Any]:
    item_type, severity = _FEED_TEMPLATE_TYPES.get(notification.template, _FEED_DEFAULT)
    text_payload = _feed_text_payload(notification, ctx, milestone_titles or {})
    title = _feed_title(notification, locale=locale, payload=text_payload)
    created_at = notification.placed_in_cabinet_at or notification.created_at
    item: dict[str, Any] = {
        "id": notification.id,
        "type": item_type,
        # ADR-159: КОД ШАБЛОНА наружу. `type` — грубая проекция (десятки
        # шаблонов сливаются в один "negotiation"), и адресно работать с
        # конкретным поводом по нему нельзя: фронт отличал
        # `contract.materials_changed` только по якорю `#milestone-` в
        # `action.href`. Шаблон — стабильный ключ строки Notification, тот же,
        # по которому считается группа-канал (`channel_group_for_template`).
        "template_code": notification.template,
        "title": title,
        "severity": severity,
        "created_at": created_at,
        "read": notification.read_at is not None,
        "group": _feed_time_group(created_at, now=now),
    }
    # ADR-098 + отсмотр 2026-08-20: навигация и мета пункта — из живого
    # договора (FeedContractContext), фолбэк — payload (договор удалён).
    # Поля опциональны: у событий без договора (entity_claimed) их нет,
    # фронт пропускает пустое.
    contract_id = ctx.contract_id if ctx is not None else notification.contract_id
    if contract_id is None:
        # Групповые события (group.join_requested/invited/request_approved) —
        # договора нет, место события — карточка объединения (замечание
        # тестеров 27.08: пункт без action никуда не вёл).
        if notification.subject_type == "group" and notification.subject_id is not None:
            item["action"] = {"label": "", "href": f"/groups/{notification.subject_id}"}
        return item
    item["action"] = {
        "label": "",
        "href": feed_href_for(notification.template, contract_id, text_payload),
    }
    contract_ref: dict[str, Any] = {"id": contract_id}
    if text_payload.get("contract_number"):
        contract_ref["number"] = text_payload["contract_number"]
    if text_payload.get("contract_title"):
        contract_ref["title"] = text_payload["contract_title"]
    item["contract"] = contract_ref
    if text_payload.get("counterparty_name"):
        counterparty: dict[str, Any] = {"name": text_payload["counterparty_name"]}
        if text_payload.get("counterparty_profile_id"):
            counterparty["profile_id"] = text_payload["counterparty_profile_id"]
        item["counterparty"] = counterparty
    # Сумма — всегда парой (amount: строка Decimal, currency), валюты по
    # умолчанию нет: без любой из половин ключа в ответе нет.
    if text_payload.get("amount") and text_payload.get("currency"):
        item["amount"] = {
            "amount": str(text_payload["amount"]),
            "currency": text_payload["currency"],
        }
    return item


# ── Глубокие ссылки уведомлений (ADR-170) ────────────────────────────────────
# Уведомление обязано открывать РАЗДЕЛ, о котором оно пришло, а не «общую
# вкладку сделки» (владелец 07.09: «потом допустим в правку надо искать»).
# Карта «шаблон -> цель» живёт здесь, рядом с проекцией типа/группы: это одна
# и та же презентационная развёртка кода шаблона (ADR-159), и расходиться им
# нельзя. Одна карта на все каналы: лента ЛК, пуш и кнопка письма.
#
# Якорь — КЛЮЧ ВКЛАДКИ карточки договора (web `ContractDetailPage.cardTabs`).
# Шаблона нет в карте -> якоря нет -> обзор, как было до этой ветки: промахнуться
# разделом хуже, чем не угадать его вовсе.

_ANCHOR_NEGO_SIGN = "#negoSign"
_ANCHOR_AMENDMENTS = "#amendments"
_ANCHOR_STAGES = "#stages"
_ANCHOR_PAYMENTS = "#payments"

# Точные коды — там, где семейство шаблона НЕ совпадает с разделом:
# `milestone.*`-подтверждения оплаты живут в «Платежах», а не в «Этапах»
# (тот же разрыв уже зашит в `_FEED_TEMPLATE_TYPES`: у них тип `payment`),
# а `signature_requested`/`evidence_received`/`milestone_*` — старые коды
# без точки, под префиксы не подпадают.
_FEED_TEMPLATE_ANCHORS: dict[str, str] = {
    "signature_requested": _ANCHOR_NEGO_SIGN,
    "contract.signed": _ANCHOR_NEGO_SIGN,
    "contract.amended": _ANCHOR_AMENDMENTS,
    # ADR-155: коды оставлены ради УЖЕ размещённых уведомлений.
    "milestone.advance_confirmed": _ANCHOR_PAYMENTS,
    "milestone.advance_confirmed.counterparty": _ANCHOR_PAYMENTS,
    "milestone.payment_confirmed": _ANCHOR_PAYMENTS,
    "milestone.payment_confirmed.counterparty": _ANCHOR_PAYMENTS,
    "milestone.paid": _ANCHOR_PAYMENTS,
    "milestone_submitted_for_acceptance": _ANCHOR_STAGES,
    "milestone_acceptance_reminder": _ANCHOR_STAGES,
    "milestone_material_notice": _ANCHOR_STAGES,
    "evidence_received": _ANCHOR_STAGES,
    # ADR-156 §3 — исходный случай глубокой ссылки, теперь частный случай
    # общего правила «раздел `#stages` + есть milestone_id -> якорь этапа».
    MATERIALS_CHANGED_TEMPLATE: _ANCHOR_STAGES,
}

# Семейства: новый код шаблона попадает в свой раздел без правки карты.
# Порядок важен только тем, что точная карта выше уже забрала исключения.
_FEED_PREFIX_ANCHORS: tuple[tuple[str, str], ...] = (
    ("negotiation.", _ANCHOR_NEGO_SIGN),
    ("amendment.", _ANCHOR_AMENDMENTS),
    ("payment.", _ANCHOR_PAYMENTS),
    ("milestone.", _ANCHOR_STAGES),
)

# Свои СТРАНИЦЫ, а не вкладка карточки.
CHAT_TEMPLATE = "message.received"
ARCHIVE_READY_TEMPLATE = "archive.ready"
_DISPUTE_PREFIXES: tuple[str, ...] = ("dispute.", "warranty")


def feed_anchor_for(template: str, payload: Mapping[str, Any]) -> str:
    """Якорь раздела карточки договора по коду шаблона; пустая строка — обзор.

    Чистая функция: ни модели, ни запросов — карта плюс одно уточнение по
    payload. Раздел «Этапы» с известным `milestone_id` уточняется до якоря
    конкретного этапа (`#milestone-<id>`), чтобы человек попадал в тот этап,
    о котором уведомление, а не в начало длинного дерева."""
    anchor = _FEED_TEMPLATE_ANCHORS.get(template)
    if anchor is None:
        anchor = next(
            (a for prefix, a in _FEED_PREFIX_ANCHORS if template.startswith(prefix)),
            None,
        )
    if anchor is None:
        return ""
    if anchor == _ANCHOR_STAGES:
        milestone_id = _as_uuid(payload.get("milestone_id"))
        if milestone_id is not None:
            return f"#milestone-{milestone_id}"
    return anchor


def feed_href_for(template: str, contract_id: UUID | str, payload: Mapping[str, Any]) -> str:
    """Куда ведёт уведомление по договору — ОДИН источник для ленты ЛК,
    пуша и кнопки письма (иначе каналы разойдутся о том же поводе).

    Якорь безвреден для клиента, который его не разбирает: браузер просто не
    найдёт цель и оставит верх страницы."""
    card = f"/contracts/{contract_id}"
    if template.startswith(_DISPUTE_PREFIXES):
        # Разногласия и гарантийные претензии живут на СВОЕЙ странице
        # (`/disputes/{id}`) — вкладки для них у карточки нет вовсе.
        # Легаси-записи без `dispute_id` в payload — на карточку договора.
        dispute_id = _as_uuid(payload.get("dispute_id"))
        return card if dispute_id is None else f"/disputes/{dispute_id}"
    if template == CHAT_TEMPLATE:
        # Вкладка «Чат» карточки — это каллаут с кнопкой «Открыть чат»;
        # вести через неё в переписку значит просить лишний клик.
        return f"/chat/{contract_id}"
    if template == ARCHIVE_READY_TEMPLATE:
        return f"{card}/archive"
    return f"{card}{feed_anchor_for(template, payload)}"


_PLACEHOLDER_RE = re.compile(r"\{[a-z_]+\}")


def substitute_placeholders(text: str, payload: dict[str, Any] | None) -> str:
    """Подстановка `{ключей}` payload в текст шаблона (ADR-098 для ленты,
    ADR-141 для писем/пушей): неизвестный ключ не роняет рендер, а
    оставшиеся плейсхолдеры заменяются на «…» — буквальный `{contract_title}`
    наружу не уходит никогда."""
    if not text:
        return text
    rendered = text.format_map(_SafeFormatDict(payload or {}))
    return _PLACEHOLDER_RE.sub("…", rendered)


def _feed_title(
    notification: Notification, *, locale: str, payload: dict[str, Any] | None = None
) -> str:
    """Текст пункта ленты. Уведомления, размещённые до ADR-098, не несут
    contract_title/milestone_title — шаблон отрендерился бы с буквальным
    «{contract_title}» (так и было на проде). Для них честный фолбэк —
    короткая тема шаблона («Договор подписан»), а не сломанная фраза;
    дозаписи payload нет намеренно (append-only контур, content_hash)."""
    body = render_body(notification.template, locale=locale)
    if not body:
        return render_subject(notification.template, locale=locale) or notification.template
    substitutions = payload if payload is not None else (notification.payload or {})
    rendered = body.format_map(_SafeFormatDict(substitutions))
    if _PLACEHOLDER_RE.search(rendered):
        subject = render_subject(notification.template, locale=locale)
        if subject:
            return subject
        return _PLACEHOLDER_RE.sub("…", rendered)
    return rendered


# ── Пагинация ленты (решение владельца 05.09: «пусть штук 15 висят, далее
# кнопка "показать ещё"») ─────────────────────────────────────────────────────
# Курсор keyset по паре `(created_at, id)`, а НЕ offset: лента растёт сверху,
# и при offset между двумя запросами страницы съезжают — пункт дублируется или
# пропадает. Курсор непрозрачный (base64 от «isoformat|uuid») — формат внутри
# остаётся нашим делом, фронт его только возвращает как есть.

FEED_PAGE_SIZE = 15
FEED_PAGE_SIZE_MAX = 50


class InvalidFeedCursorError(ValueError):
    """Курсор ленты не разбирается — api/views.py превращает в 400."""


def _templates_by_group() -> dict[str, frozenset[str]]:
    acc: dict[str, set[str]] = {group: set() for group in FEED_CHANNEL_GROUPS}
    for code, (feed_type, _severity) in _FEED_TEMPLATE_TYPES.items():
        acc[_FEED_TYPE_GROUP[feed_type]].add(code)
    return {group: frozenset(codes) for group, codes in acc.items()}


_FEED_GROUP_TEMPLATES: dict[str, frozenset[str]] = _templates_by_group()
_FEED_KNOWN_TEMPLATES: frozenset[str] = frozenset(_FEED_TEMPLATE_TYPES)
# Куда падает НЕИЗВЕСТНЫЙ шаблон: _FEED_DEFAULT -> тип -> группа. Пункт не
# теряется (лента — юрканал, ADR-057), значит и счётчик группы обязан его
# учесть — в SQL это «не из известных кодов».
_FEED_DEFAULT_GROUP: str = _FEED_TYPE_GROUP[_FEED_DEFAULT[0]]


def _feed_group_q(group: str) -> Q:
    """Условие «уведомление относится к вкладке group» — по коду шаблона, тем
    же маршрутом, что и проекция пункта (_FEED_TEMPLATE_TYPES → _FEED_TYPE_GROUP).
    Считать группы в SQL, а не по построенным пунктам, обязательно: счётчики
    идут по ВСЕЙ ленте, а _feed_item мы строим только для страницы."""
    condition = Q(template__in=_FEED_GROUP_TEMPLATES[group])
    if group == _FEED_DEFAULT_GROUP:
        condition |= ~Q(template__in=_FEED_KNOWN_TEMPLATES)
    return condition


def _feed_filter_q(filter_key: str) -> Q:
    """?filter= → условие сужения ленты. «all» ничего не сужает."""
    if filter_key == "unread":
        return Q(read_at__isnull=True)
    if filter_key in FEED_CHANNEL_GROUPS:
        return _feed_group_q(filter_key)
    return Q()


def encode_feed_cursor(notification: Notification) -> str:
    """Курсор «после этого пункта» — пара сортировки в base64url без padding."""
    raw = f"{notification.created_at.isoformat()}|{notification.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _feed_cursor_q(cursor: str) -> Q:
    """Keyset для порядка (-created_at, -id): строго «дальше» курсора."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        created_raw, _, id_raw = raw.partition("|")
        created_at = datetime.fromisoformat(created_raw)
        notification_id = UUID(id_raw)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise InvalidFeedCursorError(cursor) from exc
    if created_at.tzinfo is None:
        raise InvalidFeedCursorError(cursor)
    return Q(created_at__lt=created_at) | Q(created_at=created_at, id__lt=notification_id)


def _feed_counters(base: QuerySet[Notification]) -> dict[str, Any]:
    """unread_count и счётчики вкладок — одним агрегатом по ВСЕЙ ленте."""
    unread = Q(read_at__isnull=True)
    aggregated = base.aggregate(
        unread_count=Count("id", filter=unread),
        **{
            f"group_{group}": Count("id", filter=unread & _feed_group_q(group))
            for group in FEED_CHANNEL_GROUPS
        },
    )
    return {
        "unread_count": aggregated["unread_count"],
        "groups": {group: aggregated[f"group_{group}"] for group in FEED_CHANNEL_GROUPS},
    }


def _attach_counterparty_avatars(items: list[dict[str, Any]], request: Any) -> None:
    """ADR-173: фото контрагента в ленте — ЖИВОЕ, а не из снимка события.
    Ссылка версионируется и подписывается (ADR-103): в payload уведомления
    она бы протухла вместе с заменой фото. Одна пачка на страницу ленты —
    `avatar_urls_for_request` берёт профили одним запросом."""
    from apps.profiles import selectors as profile_selectors

    refs = [
        item["counterparty"]
        for item in items
        if item.get("counterparty") and item["counterparty"].get("profile_id")
    ]
    if not refs:
        return
    urls = profile_selectors.avatar_urls_for_request({ref["profile_id"] for ref in refs}, request)
    for ref in refs:
        ref["avatar_url"] = urls.get(ref["profile_id"])


def feed_for_recipient(
    user: User,
    *,
    filter_key: str,
    locale: str,
    limit: int = FEED_PAGE_SIZE,
    cursor: str | None = None,
    request: Any = None,
) -> dict[str, Any]:
    """GET /notifications?filter=&limit=&cursor= — СТРАНИЦА ленты DEV-14 §7:
    {items, unread_count, groups, next_cursor, total}.

    `unread_count`/`groups` — счётчики ВКЛАДОК: по-прежнему по ВСЕЙ ленте, а не
    по отфильтрованной и не по странице (фильтр сужает только items), но теперь
    считаются агрегатами в БД. `total` — длина ТЕКУЩЕЙ отфильтрованной ленты:
    из него фронт берёт «Показать ещё N». `next_cursor` — None на последней
    странице. Тяжёлая часть (живой контекст договоров, рендер текста) делается
    только для пунктов страницы. `request` — зритель для фото контрагента
    (ADR-173); без него фото отдаётся только у публичных профилей."""
    now = timezone.now()
    base = list_for_recipient(user)
    counters = _feed_counters(base)

    filtered = base.filter(_feed_filter_q(filter_key))
    total = filtered.count()
    page = filtered.filter(_feed_cursor_q(cursor)) if cursor else filtered
    # +1 строка — «есть ли ещё», без второго COUNT по хвосту.
    rows = list(page[: limit + 1])
    has_more = len(rows) > limit
    notifications = rows[:limit]

    contexts = feed_contract_contexts(notifications, user=user)
    milestone_titles = _milestone_titles(notifications)
    items = [
        _feed_item(
            n, locale=locale, now=now, ctx=contexts.get(n.id), milestone_titles=milestone_titles
        )
        for n in notifications
    ]
    _attach_counterparty_avatars(items, request)

    return {
        "items": items,
        "unread_count": counters["unread_count"],
        "groups": counters["groups"],
        "next_cursor": encode_feed_cursor(notifications[-1]) if has_more else None,
        "total": total,
    }


def get_for_recipient_or_404(notification_id: UUID, *, user: User) -> Notification:
    """404, а не 403, на чужой id — не подтверждаем существование чужого
    уведомления (тот же приём, что apps.entities.selectors.get_..._or_404)."""
    return get_object_or_404(Notification, pk=notification_id, recipient=user)


def render_body(template_code: str, *, locale: str) -> str:
    """Текст шаблона на нужном языке. Приоритет источника (feat/
    notifications-wiring, продолжение ГВ.5/Л.2): `apps.l10n.selectors.
    get_notification_text(template_code, ...)` — языковой пакет, ключ
    `notifications.<template_code>`, с собственным фолбэком locale->en
    (l10n/README.md) — ЕСЛИ у шаблона такой ключ есть (сейчас: только
    коды-топики из settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES /
    _COUNTERPARTY_TEMPLATES, `template_code` для них буквально равен
    outbox-топику, docstring config/settings/base.py). Иначе —
    body_i18n[locale], иначе body_i18n["ru"] (старый
    механизм ГВ.5: только ru/en, применяется к «прямым» шаблонам
    apps.*.services.place_notification — evidence_received,
    signature_requested и т.п., их коды не топики и в пакетах их нет),
    иначе "" (шаблона нет вообще)."""
    pack_text = l10n_selectors.get_notification_text(template_code, locale=locale)
    if pack_text is not None and pack_text.get("body"):
        return pack_text["body"]

    template = NotificationTemplate.objects.filter(code=template_code).first()
    if template is None:
        return ""
    body_i18n: dict[str, str] = template.body_i18n
    return body_i18n.get(locale) or body_i18n.get("ru", "")


def render_subject(template_code: str, *, locale: str) -> str | None:
    """Тема уведомления — ТОЛЬКО из языкового пакета (`notifications.
    <template_code>.subject`): body_i18n (старый ГВ.5-механизм) темы не
    хранит вообще, там всегда None. Провайдеры (`apps.notifications.
    providers`) сейчас тему не используют — задел на будущее (push/email
    провайдеры типично разделяют subject/body), не влияет на текущее
    поведение `Notification` (в модели нет отдельной колонки subject,
    только `provider_payload`, `apps.notifications.services.
    place_notification`)."""
    pack_text = l10n_selectors.get_notification_text(template_code, locale=locale)
    if pack_text is not None:
        return pack_text.get("subject")
    return None
