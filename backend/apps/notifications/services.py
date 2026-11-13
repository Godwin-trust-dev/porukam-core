"""Use cases apps.notifications (tech-spec.md §5.2.10; docs/tasks/fundament.md
ЭФ.4; domain-model.md §17; docs/adr/ADR-057-notification-cabinet-channel.md).

Границы модулей (CLAUDE.md): здесь используются ТОЛЬКО facade-модули других
приложений (apps.deadlines.services/selectors, apps.jurisdictions.selectors) —
никогда models.py чужого приложения (кроме apps.accounts.models.User — импорт
только для типа, см. apps.accounts.services). Экземпляры DomainDeadline,
которые возвращают facade-функции apps.deadlines, поэтому типизированы как
Any (mypy strict на services.py, tool.mypy overrides в pyproject.toml) —
DomainDeadline остаётся классом apps.deadlines, не импортируется сюда.

apps.jurisdictions.selectors.resolve_jurisdiction (ГВ.5, docs/tasks/
global-wave.md, ADR-075) — контур получателя по User.country_code: язык
уведомления (place_notification читает body_i18n через .selectors.render_body)
и sms_channel_enabled (SMS-фоллбек выключен конфигурацией контура, не
удалением кода — тот же profile, что и в apps.jurisdictions.JurisdictionConfig
с ГВ.1)."""

from __future__ import annotations

import hashlib
import json
import logging
from collections import Counter
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings as django_settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.deadlines import selectors as deadline_selectors
from apps.deadlines import services as deadline_services
from apps.jurisdictions.selectors import resolve_jurisdiction
from common.i18n import resolve_user_locale

from . import selectors as notification_selectors
from .email_texts import login_code_hint, login_code_subject
from .models import (
    MATERIALS_CHANGED_TEMPLATE,
    DeliveryAttempt,
    DeviceToken,
    Notification,
    NotificationSettings,
    NotificationTemplate,
    PendingMaterialsChange,
    PushSubscription,
    ReminderPointConfig,
    ReminderSchedule,
)
from .providers import (
    DeliveryResult,
    EmailProvider,
    FakeSmsProvider,
    PushProvider,
    SmsProvider,
    get_email_provider,
    get_push_provider,
)

# CLAUDE.md/fundament.md ЭФ.4: реальные провайдеры не были частью фундамента —
# фейки как значения по умолчанию. Push (ADR-110) и email (ADR-111) —
# реальные каналы за конфигурацией (`NOTIFICATIONS_PUSH_PROVIDER` /
# `NOTIFICATIONS_EMAIL_PROVIDER`), поэтому резолвятся на вызов
# (`push_provider=None`/`email_provider=None` ниже), а не модульной
# константой — иначе тесты/переопределение env после импорта не действовали бы.
logger = logging.getLogger(__name__)

_default_sms_provider = FakeSmsProvider()

# DomainDeadline.StartsFrom.CABINET_PLACEMENT дублируется по значению (не
# импортируем apps.deadlines.models) — тот же приём, что в
# apps/deadlines/models.py для CheckConstraint.
_STARTS_FROM_CABINET_PLACEMENT = "cabinet_placement"


class InAppChannelCannotBeDisabledError(ValueError):
    """ЛК-канал юридически значим и отключить его нельзя (CLAUDE.md,
    domain-model.md §17). Соответствует CheckConstraint
    `notification_settings_in_app_always_enabled` на уровне БД."""


class NotificationPermissionDeniedError(ValueError):
    """Попытка прочитать/пометить прочитанным чужое уведомление."""


class PushPermissionDeniedError(ValueError):
    """PUT push=true при браузерном разрешении denied (DEV-14 §5): включить
    push через приложение нельзя — сначала разрешение в настройках
    устройства/браузера. Зеркало проверки мока (notificationsDb)."""


class DeadlineWithoutReminderSeriesError(ValueError):
    """schedule_reminder_series() вызван на незаякоренном дедлайне (anchor_at
    или deadline_at ещё NULL) — в обычном потоке (place_notification сразу
    после anchor_deadline()) это невозможно, ошибка защищает от неверного
    прямого вызова сервиса."""


def _content_hash(*, recipient_id: UUID, template: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"recipient": str(recipient_id), "template": template, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_or_create_settings(user: User) -> NotificationSettings:
    settings_row, _ = NotificationSettings.objects.get_or_create(user=user)
    return settings_row


def update_settings(
    user: User,
    *,
    push_enabled: bool | None = None,
    email_enabled: bool | None = None,
    sms_enabled: bool | None = None,
    in_app_enabled: bool | None = None,
    push_permission: str | None = None,
    groups: dict[str, bool] | None = None,
) -> NotificationSettings:
    """PUT /notification-settings. `in_app_enabled=False` — ошибка ДО записи
    в БД (CheckConstraint не даст сохранить, но явная ошибка сервисного слоя
    даёт вызывающей стороне понятный код вместо IntegrityError).

    `push_enabled=True` при действующем (с учётом этого же PUT) браузерном
    разрешении denied — PushPermissionDeniedError: UI держит тумблер
    неактивным, но защищаемся и на API (зеркало мока, DEV-14 §5).
    Ключи `groups` уже провалидированы сериализатором (deals/payments/
    deadlines/disputes)."""
    if in_app_enabled is False:
        raise InAppChannelCannotBeDisabledError(
            "уведомления в личном кабинете — юридический канал, отключить нельзя"
        )

    settings_row = get_or_create_settings(user)
    effective_permission = (
        push_permission if push_permission is not None else settings_row.push_permission
    )
    if push_enabled is True and effective_permission == NotificationSettings.PushPermission.DENIED:
        raise PushPermissionDeniedError("уведомления выключены в настройках устройства")

    update_fields = []
    if push_enabled is not None:
        settings_row.push_enabled = push_enabled
        update_fields.append("push_enabled")
    if email_enabled is not None:
        settings_row.email_enabled = email_enabled
        update_fields.append("email_enabled")
    if sms_enabled is not None:
        settings_row.sms_enabled = sms_enabled
        update_fields.append("sms_enabled")
    if push_permission is not None:
        settings_row.push_permission = push_permission
        update_fields.append("push_permission")
    for group, enabled in (groups or {}).items():
        field = f"group_{group}"
        setattr(settings_row, field, enabled)
        update_fields.append(field)
    if update_fields:
        settings_row.save(update_fields=update_fields)
    return settings_row


def subscribe_push(
    user: User, *, endpoint: str, p256dh: str, auth: str, user_agent: str = ""
) -> PushSubscription:
    """POST /push-subscriptions (ADR-110). Идемпотентно по endpoint: браузер
    может пере-подписаться с тем же endpoint (перезаход, обновление ключей) —
    строка обновляется, а не дублируется. Смена владельца endpoint (в этом
    браузере вошёл другой аккаунт) — переписывание user: подписка принадлежит
    браузеру, пуши должен получать тот, кто в нём сейчас."""
    subscription, _ = PushSubscription.objects.update_or_create(
        endpoint=endpoint,
        defaults={"user": user, "p256dh": p256dh, "auth": auth, "user_agent": user_agent[:255]},
    )
    return subscription


def unsubscribe_push(user: User, *, endpoint: str) -> None:
    """POST /push-subscriptions/unsubscribe. Идемпотентно: отписка чужого или
    уже удалённого endpoint — no-op (валидного сценария узнать про чужой
    endpoint нет, а 404 раскрывал бы его существование)."""
    PushSubscription.objects.filter(user=user, endpoint=endpoint).delete()


class UnknownPushProviderError(ValueError):
    """Провайдер вне `DeviceToken.Provider` — обёртка прислала токен канала,
    которого бэк не знает; молча сохранять его нельзя (пуши в никуда)."""


class EmptyDeviceTokenError(ValueError):
    """Пустой токен: SDK провайдера ещё не выдал его, а обёртка уже
    зарегистрировала. Строка-пустышка заняла бы `unique` и увела бы
    следующее устройство в чужого владельца."""


def register_device_token(
    user: User,
    *,
    provider: str,
    token: str,
    app_id: str,
    platform: str = "android",
    user_agent: str = "",
) -> DeviceToken:
    """POST /device-tokens (ADR-176). Идемпотентно по `token`: обёртка шлёт
    токен при КАЖДОМ запуске (мост TWA — параметр стартового URL, другого нет),
    и повторная регистрация обязана обновлять строку, а не плодить дубли.

    Смена владельца — то же правило, что у Web Push подписки (ADR-110 п.2):
    токен принадлежит УСТРОЙСТВУ, вошёл в приложение другой аккаунт — пуши
    получает он. `last_seen_at` обновляется через auto_now самим сохранением."""
    if not token:
        raise EmptyDeviceTokenError("токен устройства не может быть пустым")
    if provider not in DeviceToken.Provider.values:
        raise UnknownPushProviderError(
            f"провайдер должен быть одним из {sorted(DeviceToken.Provider.values)}"
        )
    device_token, _ = DeviceToken.objects.update_or_create(
        token=token,
        defaults={
            "user": user,
            "provider": provider,
            "app_id": app_id,
            "platform": platform,
            "user_agent": user_agent[:255],
        },
    )
    return device_token


def unregister_device_token(user: User, *, token: str) -> None:
    """POST /device-tokens/unregister. Идемпотентно и только СВОЙ токен:
    чужой или уже удалённый — no-op (валидного сценария узнать про чужой токен
    нет, а 404 раскрывал бы его существование — как у Web Push отписки)."""
    DeviceToken.objects.filter(user=user, token=token).delete()


def _anchor_related_deadlines(*, subject_type: str, subject_id: str, at: datetime) -> Any | None:
    """Ищет незаякоренные (anchor_at IS NULL) дедлайны субъекта с
    starts_from=cabinet_placement и якорит их этим уведомлением (связка
    ЭФ.2/ЭФ.4, ADR-057). Возвращает первый заякоренный (для
    Notification.related_deadline — схема §5.2.10 держит одну FK), либо
    None, если у субъекта таких дедлайнов нет."""
    candidates = deadline_selectors.list_active_for_subject(
        subject_type=subject_type, subject_id=UUID(subject_id)
    ).filter(anchor_at__isnull=True, starts_from=_STARTS_FROM_CABINET_PLACEMENT)

    anchored_first = None
    for deadline in candidates:
        anchored = deadline_services.anchor_deadline(deadline, at=at)
        if anchored_first is None:
            anchored_first = anchored
    return anchored_first


def _contract_short_number(contract_id: Any) -> str:
    """Короткий «номер договора» для текстов и меты ленты (ADR-098):
    последние 6 hex-символов UUID (uuid7: хвост — случайная часть, начало —
    таймштамп, у соседних договоров он почти одинаковый). Отдельного
    доменного номера у Contract нет (tech-spec §5.2) — это презентационная
    производная, стабильная для данного id."""
    return str(contract_id).replace("-", "")[-6:].upper()


def _enrich_payload(
    payload: dict[str, Any], *, contract_id: Any, recipient: User, milestone_id: Any = None
) -> dict[str, Any]:
    """ADR-098: самодостаточный payload в момент размещения. Тексты пакетов
    ссылаются на {contract_title}, но события контрактного контура
    публикуются с пустым payload — в проде заголовок ленты печатал
    буквальный плейсхолдер. Обогащаем ЦЕНТРАЛЬНО здесь (одна точка вместо
    каждого publish-сайта): title/номер договора + контрагент, вычисленный
    ОТНОСИТЕЛЬНО получателя. setdefault — явно переданные издателем
    значения не перетираются. Импорты локальные: apps.contracts.services
    сам импортирует этот модуль (цикла на уровне модулей не заводим)."""
    if contract_id is None:
        return payload
    from apps.contracts import selectors as contract_selectors
    from apps.profiles import selectors as profile_selectors

    contract = contract_selectors.get_contract(contract_id)
    if contract is None:
        return payload
    enriched = dict(payload)
    _enrich_milestone_title(enriched, milestone_id)
    number = _contract_short_number(contract.id)
    enriched.setdefault("contract_number", number)
    # Пустой title — валидное состояние черновика; фолбэк на номер, чтобы
    # шаблон «Договор «{contract_title}»…» не печатал пустые кавычки.
    enriched.setdefault("contract_title", contract.title or f"№ {number}")
    _enrich_amount(enriched, contract)
    try:
        other = contract_selectors.resolve_counterparty(contract, recipient)
    except contract_selectors.PartyNotFoundError:
        return enriched
    enriched.setdefault("counterparty_profile_id", str(other.profile_id))
    name = profile_selectors.public_display_name(other.profile)
    if name:
        enriched.setdefault("counterparty_name", name)
    return enriched


def _enrich_amount(enriched: dict[str, Any], contract: Any) -> None:
    """Сумма договора в payload (`amount`: строка Decimal + `currency`) —
    мета пункта ленты «контрагент · № · сумма». Схема не хранит итог —
    «сумма листьев = сумма договора» (tech-spec §6.1), считаем тем же
    `apps.milestones.services.total_leaf_amount`, что и карточка договора.
    ValueError — черновик без этапов или листья в разных валютах: суммы
    просто нет, ключей не пишем (ни пустых строк, ни валюты по умолчанию)."""
    if "amount" in enriched and "currency" in enriched:
        return
    from apps.milestones import services as milestones_services

    try:
        total = milestones_services.total_leaf_amount(contract)
    except ValueError:
        return
    enriched.setdefault("amount", str(total.amount))
    enriched.setdefault("currency", total.currency)


def _enrich_milestone_title(enriched: dict[str, Any], milestone_id: Any) -> None:
    """`milestone_title` для «прямых» шаблонов этапов (они передают только
    milestone_id): тексты «Этап «{milestone_title}» сдан на приёмку» без
    названия этапа читались как обрывок. События milestones кладут
    milestone_title сами (`_event_payload`) — setdefault их не трогает."""
    milestone_uuid = _as_uuid(milestone_id)
    if milestone_uuid is None or enriched.get("milestone_title"):
        return
    from apps.milestones.models import Milestone

    title = Milestone.objects.filter(pk=milestone_uuid).values_list("title", flat=True).first()
    if title:
        enriched["milestone_title"] = title


def _as_uuid(raw: Any) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except ValueError:
        return None


def _milestone_contract_uuid(milestone_id: Any) -> UUID | None:
    """contract_id по этапу — для «прямых» шаблонов milestones
    (milestone_submitted_for_acceptance, milestone_material_notice), которые
    передают только milestone_id. Импорт локальный — тот же цикл-риск, что
    у apps.contracts в _enrich_payload."""
    milestone_uuid = _as_uuid(milestone_id)
    if milestone_uuid is None:
        return None
    from apps.milestones.models import Milestone

    return Milestone.objects.filter(pk=milestone_uuid).values_list("contract_id", flat=True).first()


def _subject_contract_uuid(
    *,
    subject_type: str | None,
    subject_id: str | None,
    subject_contract_id: str | None,
    payload: dict[str, Any],
) -> UUID | None:
    """Договор уведомления — из субъекта события (ADR-098), а если его нет —
    из payload «прямых» шаблонов: signature_requested кладёт contract_id,
    milestone_* — milestone_id. Без этого фолбэка самое важное уведомление
    контрагенту («подпишите договор») оставалось некликабельным и без
    обогащения (отсмотр прода 2026-08-20)."""
    raw = subject_contract_id or (subject_id if subject_type == "contract" else None)
    found = _as_uuid(raw) or _as_uuid(payload.get("contract_id"))
    if found is not None:
        return found
    milestone_id = subject_id if subject_type == "milestone" else payload.get("milestone_id")
    return _milestone_contract_uuid(milestone_id)


@transaction.atomic
def place_notification(
    *,
    recipient: User,
    template: str,
    payload: dict[str, Any],
    legal_significance: bool,
    subject_type: str | None = None,
    subject_id: str | None = None,
    subject_contract_id: str | None = None,
    source_event_id: UUID | None = None,
    push_provider: PushProvider | None = None,
    email_provider: EmailProvider | None = None,
    force_sms: bool = False,
    sms_provider: SmsProvider = _default_sms_provider,
    force_email: bool = False,
    email_attachments: list[dict[str, str]] | None = None,
) -> Notification:
    """apps.notifications.services.place_notification (domain-model.md §17):
    размещение в ЛК = юридическая доставка. `placed_in_cabinet_at` —
    момент, от которого течёт тайм-аут связанного дедлайна (если есть).

    Язык письма — `common.i18n.resolve_user_locale` (ADR-095): выбранный
    получателем язык интерфейса, иначе язык контура. Раньше здесь стоял
    `jurisdiction.primary_locale` напрямую, то есть ровно два возможных
    значения (ru/en) на 29 языков переключателя — немец с немецким
    интерфейсом получал английские письма, и починить это на стороне
    контура было нельзя.

    `source_event_id` (ADR-126) — outbox-событие, породившее уведомление:
    ключ дедупликации повторной доставки (UniqueConstraint
    `unique_notification_per_source_event`). Для «прямых» вызовов из
    services.py остаётся None — они не от события.

    `force_email` (ADR-139): юрзначимое письмо, которое уходит НЕЗАВИСИМО от
    пользовательской настройки e-mail и групп-каналов (у новых пользователей
    e-mail выключен по умолчанию, 0015) — выдача доказательного пакета обеим
    сторонам при завершении сделки (ADR-137 «добровольно-принудительно»).
    Нет адреса — только ЛК (юрканал) + `DeliveryAttempt` со статусом
    `no_email`, чтобы факт «письмо не ушло» был виден. `email_attachments` —
    список `{filename, content_type, content_b64}` (пакет < 20 МБ, проверка
    у вызывающей стороны), уходит провайдеру в `message["attachments"]`.

    Контур (ADR-075/ГВ.1) остаётся ответственным за КАНАЛ: разрешает или
    запрещает SMS-фоллбек ниже — GLOBAL выключает SMS конфигурацией
    (JurisdictionConfig.sms_channel_enabled), не удалением кода: ветка ниже
    существует для всех контуров одинаково, просто не выполняется, когда
    контур её не разрешает."""
    now = timezone.now()
    if push_provider is None:
        push_provider = get_push_provider()
    if email_provider is None:
        email_provider = get_email_provider()
    jurisdiction = resolve_jurisdiction(recipient.country_code)
    # Фолбэк — именно primary_locale уже резолвнутого контура, а НЕ
    # DEFAULT_LOCALE: у получателя без страны контур GLOBAL, и его язык en;
    # подстановка глобального дефолта ("ru") отправила бы такому человеку
    # русское письмо — регресс относительно ГВ.5.
    locale = resolve_user_locale(recipient) or jurisdiction.primary_locale
    contract_uuid = _subject_contract_uuid(
        subject_type=subject_type,
        subject_id=subject_id,
        subject_contract_id=subject_contract_id,
        payload=payload,
    )
    milestone_ref = subject_id if subject_type == "milestone" else payload.get("milestone_id")
    payload = _enrich_payload(
        payload, contract_id=contract_uuid, recipient=recipient, milestone_id=milestone_ref
    )
    body = notification_selectors.render_body(template, locale=locale)
    subject = notification_selectors.render_subject(template, locale=locale)
    provider_payload: dict[str, Any] = {
        "template": template,
        "payload": payload,
        "locale": locale,
        "subject": subject,
        "body": body,
        # ADR-141: ссылка письма ведёт в сделку, а не на общую ленту.
        "contract_id": str(contract_uuid) if contract_uuid else "",
    }
    if email_attachments:
        provider_payload["attachments"] = list(email_attachments)

    try:
        subject_uuid = UUID(subject_id) if subject_id else None
    except ValueError:
        subject_uuid = None
    notification = Notification.objects.create(
        recipient=recipient,
        template=template,
        payload=payload,
        legal_significance=legal_significance,
        subject_type=subject_type or "",
        subject_id=subject_uuid,
        contract_id=contract_uuid,
        source_event_id=source_event_id,
        placed_in_cabinet_at=now,
        content_hash=_content_hash(recipient_id=recipient.id, template=template, payload=payload),
    )
    DeliveryAttempt.objects.create(
        notification=notification,
        channel=DeliveryAttempt.Channel.IN_APP,
        provider_message_id="",
        status="placed_in_cabinet",
        status_at=now,
    )

    settings_row = get_or_create_settings(recipient)
    # Группы-каналы (DEV-14 §7): выключенная группа глушит push/email этой
    # группы. Ленту ЛК и SMS-фолбэк НЕ трогает: размещение в кабинете
    # юрзначимо, а fallback-SMS шлётся только по явному force_sms финальной
    # точки напоминаний (юрканал-страховка, не «обычный» канал).
    group = notification_selectors.channel_group_for_template(template)
    group_enabled = getattr(settings_row, f"group_{group}", True)

    push_delivered = False
    if settings_row.push_enabled and group_enabled:
        result = push_provider.send(recipient, provider_payload)
        DeliveryAttempt.objects.create(
            notification=notification,
            channel=DeliveryAttempt.Channel.PUSH,
            provider_message_id=result.provider_message_id,
            status=result.status,
            status_at=now,
        )
        if result.delivered:
            notification.push_sent_at = now
            push_delivered = True

    email_wanted = force_email or (settings_row.email_enabled and group_enabled)
    if email_wanted and recipient.email:
        result = email_provider.send(recipient, provider_payload)
        DeliveryAttempt.objects.create(
            notification=notification,
            channel=DeliveryAttempt.Channel.EMAIL,
            provider_message_id=result.provider_message_id,
            status=result.status,
            status_at=now,
        )
        if result.delivered:
            notification.email_sent_at = now
    elif force_email:
        # Юрзначимое письмо без адреса: факт фиксируем попыткой со статусом
        # no_email — ЛК (юрканал) уже состоялся строкой выше.
        DeliveryAttempt.objects.create(
            notification=notification,
            channel=DeliveryAttempt.Channel.EMAIL,
            provider_message_id="",
            status="no_email",
            status_at=now,
        )

    # ADR-057: fallback-SMS только когда вызывающая сторона явно просит
    # (финальная точка серии напоминаний, tasks.sweep_reminder_schedules) И
    # push не был доставлен, И пользователь не отключил SMS-канал в своих
    # настройках, И контур получателя вообще допускает SMS (ГВ.5: GLOBAL —
    # нет, web-push + email вместо него).
    if (
        force_sms
        and not push_delivered
        and settings_row.sms_enabled
        and jurisdiction.sms_channel_enabled
    ):
        result = sms_provider.send(recipient, provider_payload)
        DeliveryAttempt.objects.create(
            notification=notification,
            channel=DeliveryAttempt.Channel.SMS,
            provider_message_id=result.provider_message_id,
            status=result.status,
            status_at=now,
        )
        if result.delivered:
            notification.sms_sent_at = now

    update_fields = ["push_sent_at", "email_sent_at", "sms_sent_at"]
    if subject_type is not None and subject_id is not None:
        related_deadline = _anchor_related_deadlines(
            subject_type=subject_type, subject_id=subject_id, at=now
        )
        if related_deadline is not None:
            notification.related_deadline = related_deadline
            update_fields.append("related_deadline")
            schedule_reminder_series(related_deadline, recipient=recipient)

    notification.save(update_fields=update_fields)
    return notification


def schedule_reminder_series(deadline: Any, *, recipient: User) -> list[ReminderSchedule]:
    """domain-model.md §17 acceptance_reminders: создаёт запланированные
    напоминания по точкам из ReminderPointConfig.points, кроме точки 0.0 (та
    уже покрыта самим place_notification в момент якорения). Тихо
    возвращает [], если для deadline.kind серия не сконфигурирована.

    Требует заякоренный дедлайн (anchor_at и deadline_at заполнены) —
    вызывается либо из place_notification сразу после anchor_deadline(),
    либо (в тестах) на уже заякоренном дедлайне."""
    config = ReminderPointConfig.objects.filter(kind=deadline.kind).first()
    if config is None:
        return []
    if deadline.anchor_at is None or deadline.deadline_at is None:
        raise DeadlineWithoutReminderSeriesError(
            f"дедлайн {deadline.id} не заякорен — серию напоминаний планировать нельзя"
        )

    duration = deadline.deadline_at - deadline.anchor_at
    points = sorted(p for p in config.points if p > 0.0)
    final_point = points[-1] if points else None

    created = []
    for point in points:
        schedule, _ = ReminderSchedule.objects.get_or_create(
            deadline=deadline,
            recipient=recipient,
            point=point,
            defaults={
                "template": config.template,
                "is_final": point == final_point,
                "fire_at": deadline.anchor_at + duration * point,
            },
        )
        created.append(schedule)
    return created


@transaction.atomic
def replan_reminder_series(deadline: Any, *, recipients: list[User]) -> list[ReminderSchedule]:
    """ADR-138: серия напоминаний ЗАНОВО после переноса дедлайна
    (`apps.deadlines.services.reschedule_deadline`). Все прежние точки этого
    дедлайна — и ещё не отправленные, и уже отправленные — удаляются: они
    считались от старого `anchor_at`, и отправленное «за 14 дней до
    закрытия» предупреждение относилось к дате, которой больше нет
    (движение по договору её отодвинуло). Сами размещённые уведомления
    (`Notification`) остаются — удаляется только план. Получателей несколько
    (обе стороны договора), точки — из `ReminderPointConfig` по `kind`."""
    ReminderSchedule.objects.filter(deadline=deadline).delete()
    created: list[ReminderSchedule] = []
    for recipient in recipients:
        created.extend(schedule_reminder_series(deadline, recipient=recipient))
    return created


def mark_read(notification: Notification, *, user: User) -> Notification:
    if notification.recipient_id != user.id:
        raise NotificationPermissionDeniedError("уведомление принадлежит другому пользователю")
    if notification.read_at is None:
        notification.read_at = timezone.now()
        notification.save(update_fields=["read_at"])
    return notification


def mark_all_read(user: User) -> int:
    """POST /notifications/read-all (DEV-14 §7). Прочтение — состояние ленты
    получателя, не юрфакт (юрмомент — placed_in_cabinet_at, ADR-057), поэтому
    массовый update допустим."""
    return Notification.objects.filter(recipient=user, read_at__isnull=True).update(
        read_at=timezone.now()
    )


def send_login_code_email(
    *,
    email: str,
    code: str,
    minutes: int,
    locale: str | None = None,
    provider: EmailProvider | None = None,
) -> DeliveryResult:
    """Письмо с кодом входа по e-mail (ADR-168) — ФАСАД для apps.accounts.

    Почему здесь, а не в apps.accounts: реальная интеграция с почтой одна на
    продукт (`ResendEmailProvider`, ADR-111, ключ и адрес отправителя в env
    этого приложения) — второй её экземпляр в apps.accounts был бы дублем
    внешнего провайдера, а не границей контекста. apps.accounts зовёт этот
    фасад и ничего не знает ни про Resend, ни про вёрстку письма.

    Это НЕ уведомление: Notification не создаётся, в ЛК ничего не
    размещается, DeliveryAttempt не пишется, настройки каналов
    (`NotificationSettings.email_enabled`) НЕ спрашиваются — выключенные
    уведомления не должны отрезать человеку вход. Юрканал (ADR-057) тут ни
    при чём: это транспорт одноразового кода, а не доставка юрзначимого
    сообщения.

    `locale` — язык запроса (`common.i18n.resolve_signup_locale`); None и
    неизвестный код дают en (та же политика фолбэка, что у email_texts):
    пользователя ещё нет, спросить `resolve_user_locale` не у кого.

    `minutes` — срок жизни кода, который надо написать в письме. Аргумент, а
    не настройка этого приложения: срок задаёт вход (apps.accounts,
    EMAIL_OTP_CODE_TTL_SECONDS), и письмо не должно расходиться с кешем.

    Ошибка доставки не бросается наружу — возвращается `delivered=False`;
    решает вызывающая сторона (apps.accounts не раскрывает существование
    адреса и отвечает 200 в любом случае)."""
    if provider is None:
        provider = get_email_provider()
    letter_locale = locale or "en"
    # Код едет ОТДЕЛЬНЫМ полем, а не внутри фразы `body` (замечание владельца
    # 08.09): вёрстка рисует его крупной плашкой, которую легко прочитать и
    # скопировать, а `body` остаётся припиской про срок и «если это не вы».
    message: dict[str, object] = {
        "template": "account.login_code",
        "locale": letter_locale,
        "subject": login_code_subject(letter_locale),
        "body": login_code_hint(letter_locale, minutes=minutes),
        "code": code,
        "payload": {},
    }
    return provider.send_to_address(email, message)


def get_template(code: str) -> NotificationTemplate | None:
    return NotificationTemplate.objects.filter(code=code).first()


# ── ADR-156: правки материалов в согласовании ────────────────────────────────
# ADR-155 разрешил править материалы этапа прямо в `under_review` без раунда
# правок — второй стороне об этом не приходило НИЧЕГО (замечание владельца
# 03.09: «наверное, надо уведомлять»). Уведомляем, но НЕ по каждому клику:
# правки идут пачкой, поэтому окно схлопывания (строки PendingMaterialsChange
# + минутный свип, apps.notifications.tasks.sweep_materials_change_digests).


def materials_change_window() -> timedelta:
    """Ширина окна схлопывания — из настроек
    (`NOTIFICATIONS_MATERIALS_CHANGE_DEBOUNCE_MINUTES`), не константой в
    коде: длительность — конфигурация (tech-spec.md §11 п.4), и на проде её
    придётся подбирать по живым сделкам."""
    return timedelta(minutes=int(django_settings.NOTIFICATIONS_MATERIALS_CHANGE_DEBOUNCE_MINUTES))


def register_materials_change(
    *,
    recipient: User,
    contract_id: UUID,
    milestone_id: UUID,
    milestone_title: str,
    actor_id: UUID,
    change: str,
    source_event_id: UUID,
) -> PendingMaterialsChange | None:
    """Одна правка материалов -> строка ожидания (не уведомление!). Если у
    пары (получатель, договор, этап, актор) уже открыто окно — правка
    подсаживается в него с ТЕМ ЖЕ `notify_at`; иначе окно открывается
    заново. Возвращает None, если это повторная доставка уже учтённого
    события (ADR-064 at-least-once).

    Правило «не двигать notify_at» намеренное: иначе сторона, которая правит
    материалы час подряд, откладывала бы уведомление на весь этот час —
    вторая сторона узнавала бы о правках последней."""
    already = PendingMaterialsChange.objects.filter(
        recipient=recipient, source_event_id=source_event_id
    ).first()
    if already is not None:
        return None

    open_row = (
        PendingMaterialsChange.objects.filter(
            recipient=recipient,
            contract_id=contract_id,
            milestone_id=milestone_id,
            actor_id=actor_id,
            notified_at__isnull=True,
        )
        .order_by("notify_at")
        .first()
    )
    if open_row is not None:
        notify_at = open_row.notify_at
    else:
        notify_at = timezone.now() + materials_change_window()
    try:
        # Вложенный atomic (savepoint): IntegrityError на гонке двух доставок
        # одного события не должен рвать внешнюю транзакцию реле.
        with transaction.atomic():
            return PendingMaterialsChange.objects.create(
                recipient=recipient,
                contract_id=contract_id,
                milestone_id=milestone_id,
                milestone_title=milestone_title[:300],
                actor_id=actor_id,
                change=change,
                source_event_id=source_event_id,
                notify_at=notify_at,
            )
    except IntegrityError:
        logger.info(
            "notifications: правка материалов по событию %s для %s уже учтена (гонка доставки)",
            source_event_id,
            recipient.id,
        )
        return None


def flush_materials_change_digests(*, now: datetime | None = None) -> int:
    """Закрывает все созревшие окна (`notify_at <= now`, ещё не отправленные)
    и размещает по ОДНОЙ карточке на окно. Возвращает число размещённых
    уведомлений. Вызывается минутным свипом; отдельные окна независимы,
    поэтому каждое закрывается своей транзакцией — сбой на одном не отменяет
    остальные."""
    at = now or timezone.now()
    keys = list(
        PendingMaterialsChange.objects.filter(notified_at__isnull=True, notify_at__lte=at)
        .values_list("recipient_id", "contract_id", "milestone_id", "actor_id")
        .distinct()
    )
    placed = 0
    for recipient_id, contract_id, milestone_id, actor_id in keys:
        notification = _flush_materials_change_window(
            recipient_id=recipient_id,
            contract_id=contract_id,
            milestone_id=milestone_id,
            actor_id=actor_id,
            at=at,
        )
        if notification is not None:
            placed += 1
    return placed


@transaction.atomic
def _flush_materials_change_window(
    *,
    recipient_id: Any,
    contract_id: UUID,
    milestone_id: UUID,
    actor_id: UUID,
    at: datetime,
) -> Notification | None:
    """Одно окно -> одна карточка. `select_for_update` держит строки окна на
    время размещения: параллельный свип (или ручной вызов из теста) не
    отправит вторую карточку по тем же правкам."""
    rows = list(
        PendingMaterialsChange.objects.select_for_update()
        .filter(
            recipient_id=recipient_id,
            contract_id=contract_id,
            milestone_id=milestone_id,
            actor_id=actor_id,
            notified_at__isnull=True,
            notify_at__lte=at,
        )
        .select_related("recipient")
        .order_by("id")
    )
    if not rows:
        return None
    counts = Counter(row.change for row in rows)
    payload: dict[str, Any] = {
        "contract_id": str(contract_id),
        "milestone_id": str(milestone_id),
        "added": counts.get(PendingMaterialsChange.Change.ADDED, 0),
        "updated": counts.get(PendingMaterialsChange.Change.UPDATED, 0),
        "removed": counts.get(PendingMaterialsChange.Change.REMOVED, 0),
    }
    # Название этапа — из последней правки, у которой оно есть: этап могли
    # переименовать в том же окне, читателю важнее нынешнее имя. Пусто —
    # ключа нет, дальше его доберёт `_enrich_milestone_title` из БД.
    title = next((row.milestone_title for row in reversed(rows) if row.milestone_title), "")
    if title:
        payload["milestone_title"] = title

    notification = place_notification(
        recipient=rows[0].recipient,
        template=MATERIALS_CHANGED_TEMPLATE,
        payload=payload,
        legal_significance=False,
        subject_type="milestone",
        subject_id=str(milestone_id),
        subject_contract_id=str(contract_id),
    )
    PendingMaterialsChange.objects.filter(pk__in=[row.pk for row in rows]).update(
        notified_at=at, notification=notification
    )
    return notification


# --- Удаление аккаунта (ADR-169) -----------------------------------------


@transaction.atomic
def purge_personal_data(user_id: Any) -> None:  # noqa: ANN401
    """Уничтожение идентификаторов устройств при удалении аккаунта (DELETE
    /users/me, ADR-169). Вызывается через `settings.ACCOUNT_DELETION_PURGERS`
    + `import_string` — статического импорта apps.accounts -> apps.notifications
    быть не может (тот же довод, что у `LOGIN_CODE_EMAIL_SENDER`).

    `PushSubscription` — endpoint браузера, ключи RFC 8291 и user-agent, то
    есть адрес конкретного устройства: удаляется целиком, иначе на телефон
    ушедшего человека продолжали бы приходить пуши. `DeviceToken` (ADR-176) —
    ровно то же самое для нативного канала обёртки (RuStore/FCM/HMS): токен
    провайдера адресует конкретный телефон, уходит вместе с аккаунтом.

    Сами `Notification` НЕ трогаются: размещение в ЛК — ЮРКАНАЛ (ADR-057),
    от `placed_in_cabinet_at` считаются доменные тайм-ауты чужих сделок,
    и это доказательство доставки, а не переписка. ПД в них — имя
    контрагента в `payload`, и оно принадлежит уведомлениям ДРУГИХ людей:
    их чистка — не удаление этого аккаунта (см. «Последствия» ADR-169).
    """
    PushSubscription.objects.filter(user_id=user_id).delete()
    DeviceToken.objects.filter(user_id=user_id).delete()
