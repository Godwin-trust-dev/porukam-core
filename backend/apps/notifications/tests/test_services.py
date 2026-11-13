"""docs/tasks/fundament.md ЭФ.4 — тесты сервисного слоя apps.notifications."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.deadlines import services as deadline_services
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.notifications import services
from apps.notifications.models import (
    NotificationTemplate,
    ReminderPointConfig,
    ReminderSchedule,
)
from apps.notifications.providers import DeliveryResult

pytestmark = pytest.mark.django_db


def _user(suffix: str, **extra) -> User:
    return User.objects.create(trust_id=f"trust-notif-{suffix}", phone=f"+7999090{suffix}", **extra)


@pytest.fixture
def kind_config() -> DeadlineKindConfig:
    return DeadlineKindConfig.objects.create(
        kind="notifications_test", duration=timedelta(hours=48)
    )


def _unanchored_deadline(kind_config, subject_id) -> DomainDeadline:
    return deadline_services.create_deadline(
        kind=kind_config.kind,
        subject_type="business_entity",
        subject_id=subject_id,
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
    )


def test_place_notification_sets_placed_in_cabinet_at():
    recipient = _user("0001")
    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={"method": "owner_identity_match"},
        legal_significance=False,
    )
    assert notification.placed_in_cabinet_at is not None
    assert notification.related_deadline is None


def test_place_notification_anchors_related_unanchored_deadline(kind_config):
    """fundament.md ЭФ.4: «дедлайн с starts_from=cabinet_placement начинает
    тикать только после размещения»."""
    recipient = _user("0002")
    entity_id = uuid4()
    deadline = _unanchored_deadline(kind_config, entity_id)
    assert deadline.deadline_at is None  # не тикает до размещения

    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        subject_type="business_entity",
        subject_id=str(entity_id),
    )

    deadline.refresh_from_db()
    assert deadline.anchor_at == notification.placed_in_cabinet_at
    assert deadline.deadline_at == deadline.anchor_at + kind_config.duration
    assert notification.related_deadline_id == deadline.id


def test_place_notification_does_not_touch_already_anchored_deadline(kind_config):
    recipient = _user("0003")
    entity_id = uuid4()
    deadline = _unanchored_deadline(kind_config, entity_id)
    first = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        subject_type="business_entity",
        subject_id=str(entity_id),
    )
    deadline.refresh_from_db()
    anchor_after_first = deadline.anchor_at

    second = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        subject_type="business_entity",
        subject_id=str(entity_id),
    )

    deadline.refresh_from_db()
    assert deadline.anchor_at == anchor_after_first  # второй раз не переякорился
    assert second.related_deadline is None
    assert first.id != second.id


def test_content_hash_is_stable_for_same_inputs():
    """fundament.md ЭФ.4: «content_hash стабилен»."""
    recipient = _user("0004")
    payload = {"method": "owner_identity_match", "n": 1}

    first = services.place_notification(
        recipient=recipient, template="entity_claimed", payload=payload, legal_significance=False
    )
    second = services.place_notification(
        recipient=recipient, template="entity_claimed", payload=payload, legal_significance=False
    )

    assert first.content_hash == second.content_hash
    assert first.content_hash != ""


def test_content_hash_differs_for_different_payload():
    recipient = _user("0005")
    first = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={"method": "a"},
        legal_significance=False,
    )
    second = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={"method": "b"},
        legal_significance=False,
    )
    assert first.content_hash != second.content_hash


def test_update_settings_cannot_disable_in_app():
    """fundament.md ЭФ.4: «настройка не может отключить in_app»."""
    user = _user("0006")
    with pytest.raises(services.InAppChannelCannotBeDisabledError):
        services.update_settings(user, in_app_enabled=False)

    # Ошибка поднимается ДО записи в БД — get_or_create_settings() отдельно
    # подтверждает, что канал остаётся включённым по умолчанию.
    settings_row = services.get_or_create_settings(user)
    assert settings_row.in_app_enabled is True


def test_update_settings_can_disable_push_email_sms():
    user = _user("0007")
    settings_row = services.update_settings(
        user, push_enabled=False, email_enabled=False, sms_enabled=False
    )
    assert settings_row.push_enabled is False
    assert settings_row.email_enabled is False
    assert settings_row.sms_enabled is False
    assert settings_row.in_app_enabled is True


def test_schedule_reminder_series_creates_entries_for_configured_points(kind_config):
    """fundament.md ЭФ.4: «серия напоминаний создаётся по точкам»."""
    recipient = _user("0008")
    ReminderPointConfig.objects.create(
        kind=kind_config.kind,
        template="milestone_acceptance_reminder",
        points=[0.0, 0.5, 0.75, 0.9, 0.99],
    )
    now = timezone.now()
    deadline = deadline_services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
    )

    schedules = services.schedule_reminder_series(deadline, recipient=recipient)

    assert sorted(s.point for s in schedules) == [0.5, 0.75, 0.9, 0.99]  # 0.0 не планируется
    duration = deadline.deadline_at - deadline.anchor_at
    by_point = {s.point: s for s in schedules}
    for point, schedule in by_point.items():
        assert schedule.fire_at == deadline.anchor_at + duration * point
    assert by_point[0.99].is_final is True
    assert by_point[0.5].is_final is False


def test_schedule_reminder_series_returns_empty_without_config(kind_config):
    recipient = _user("0009")
    now = timezone.now()
    deadline = deadline_services.create_deadline(
        kind=kind_config.kind,
        subject_type="milestone",
        subject_id=uuid4(),
        starts_from=DomainDeadline.StartsFrom.EVENT,
        anchor_at=now,
    )
    assert services.schedule_reminder_series(deadline, recipient=recipient) == []
    assert ReminderSchedule.objects.filter(deadline=deadline).count() == 0


def test_mark_read_sets_read_at_once():
    recipient = _user("0010")
    notification = services.place_notification(
        recipient=recipient, template="entity_claimed", payload={}, legal_significance=False
    )
    assert notification.read_at is None

    read_once = services.mark_read(notification, user=recipient)
    assert read_once.read_at is not None

    read_again = services.mark_read(notification, user=recipient)
    assert read_again.read_at == read_once.read_at  # повторная отметка не двигает время


def test_mark_read_by_someone_else_is_denied():
    recipient = _user("0011")
    stranger = _user("0012")
    notification = services.place_notification(
        recipient=recipient, template="entity_claimed", payload={}, legal_significance=False
    )
    with pytest.raises(services.NotificationPermissionDeniedError):
        services.mark_read(notification, user=stranger)


def test_get_template_returns_none_for_unknown_code():
    assert services.get_template("no_such_template") is None
    template = NotificationTemplate.objects.filter(code="entity_claimed").first()
    assert template is not None  # засеян миграцией 0002


# --- Контур получателя: язык и SMS (ГВ.5, docs/tasks/global-wave.md, ADR-075) --


class _RecordingProvider:
    """Тестовый двойник PushProvider/EmailProvider/SmsProvider — запоминает,
    что реально ушло провайдеру (locale/body), не только факт вызова."""

    def __init__(self, *, delivered: bool = True) -> None:
        self.calls: list[dict[str, object]] = []
        self._delivered = delivered

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        self.calls.append(message)
        return DeliveryResult(delivered=self._delivered, provider_message_id="fake", status="sent")


def test_ru_recipient_gets_russian_body_in_provider_payload():
    recipient = _user("0020", country_code="RU")
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "ru"
    assert push.calls[0]["body"] == "Подтверждён контроль над юрлицом."


def test_global_recipient_gets_english_body_in_provider_payload():
    """✅ ГВ.5: GLOBAL-пользователь получает уведомления на EN."""
    recipient = _user("0021", country_code="GLOBAL")
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "en"
    assert push.calls[0]["body"] == "Control over the company has been confirmed."


def test_recipient_without_country_defaults_to_global_english():
    """Не выбравший страну пользователь резолвится в GLOBAL (тот же
    fallback, что apps.jurisdictions.selectors.resolve_jurisdiction, ГВ.1)."""
    recipient = _user("0022", country_code=None)
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "en"


def test_sms_fallback_is_never_attempted_for_global_recipient():
    """✅ ГВ.5: «в GLOBAL ни одна ветка кода не пытается отправить SMS» —
    SMS выключен конфигурацией контура (sms_channel_enabled), не удалением
    кода: force_sms=True и push не доставлен, но SMS-провайдер не вызван."""
    recipient = _user("0023", country_code="GLOBAL")
    sms = _RecordingProvider()
    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        force_sms=True,
        sms_provider=sms,
    )
    assert sms.calls == []
    assert notification.sms_sent_at is None


def test_sms_fallback_still_works_for_ru_recipient():
    """Регрессия: контур-гейт не ломает существующий RU SMS-фоллбек."""
    recipient = _user("0024", country_code="RU")
    sms = _RecordingProvider()
    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        force_sms=True,
        sms_provider=sms,
    )
    assert len(sms.calls) == 1
    assert notification.sms_sent_at is not None


# --- ADR-095: язык письма — выбор человека, а не только контур -----------


def test_chosen_locale_beats_country_in_provider_payload():
    """✅ ADR-095. `entity_claimed` — «прямой» шаблон (не топик), его текст
    живёт в body_i18n c ключами ru/en, поэтому здесь проверяется именно
    выбор ЯЗЫКА, а не наличие перевода: россиянин, переключившийся на
    английский, получает английское письмо, хотя контур у него RU."""
    recipient = _user("0025", country_code="RU", locale="en")
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "en"
    assert push.calls[0]["body"] == "Control over the company has been confirmed."


def test_recipient_locale_reaches_provider_even_without_pack():
    """Немец в контуре GLOBAL: язык письма — `de`, а текст придёт по
    фолбэк-цепочке пакета (de -> en). Важно, что до рендера доезжает именно
    выбранный язык: пока сюда приходило `en`, ни один немецкий перевод не мог
    быть использован в принципе, сколько бы их ни лежало в пакетах."""
    from apps.l10n import services as l10n_services

    l10n_services.import_pack(
        {
            "locale": "de",
            "name": "Deutsch",
            "rtl": False,
            "quality": "machine",
            "pack_version": 1,
            "errors": {},
            "notifications": {},
            "catalog": {},
            "clauses": {},
            "legal": {},
        }
    )
    recipient = _user("0026", country_code="DE", locale="de")
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "de"


def test_country_still_used_when_no_locale_chosen():
    """Регресс-стереж: пользователь без выбранного языка обязан вести себя
    ровно как до ADR-095 (иначе фолбэк на DEFAULT_LOCALE отправил бы
    GLOBAL-получателю русский текст)."""
    recipient = _user("0027", country_code=None, locale=None)
    push = _RecordingProvider()
    services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        push_provider=push,
    )
    assert push.calls[0]["locale"] == "en"


# --- группы-каналы (DEV-14 §7, №10 отсмотра 2026-08-18) ----------------------


def test_place_notification_group_muted_skips_push_and_email():
    """Выключенная группа глушит push/email-доставку, но НЕ ленту ЛК:
    размещение в кабинете юрзначимо и от групп не зависит."""
    recipient = _user("0031", email="godwin-test@example.com")
    services.update_settings(recipient, groups={"deals": False})

    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",  # группа deals (дефолтная проекция ленты)
        payload={"method": "owner_identity_match"},
        legal_significance=False,
    )

    assert notification.placed_in_cabinet_at is not None
    assert notification.push_sent_at is None
    assert notification.email_sent_at is None
    channels = set(notification.delivery_attempts.values_list("channel", flat=True))
    assert channels == {"in_app"}  # ЛК-размещение фиксируется всегда


def test_place_notification_group_enabled_still_attempts_delivery():
    recipient = _user("0032", email="godwin-test2@example.com")
    # E-mail с миграции 0015 выключен по умолчанию (решение продукта 25.08) —
    # тест про ГРУППУ-канал, а не про дефолт, поэтому канал включаем явно.
    services.update_settings(recipient, email_enabled=True)

    notification = services.place_notification(
        recipient=recipient,
        template="entity_claimed",
        payload={"method": "owner_identity_match"},
        legal_significance=False,
    )

    channels = set(notification.delivery_attempts.values_list("channel", flat=True))
    assert "push" in channels
    assert "email" in channels


def test_update_settings_push_denied_guard():
    """PUT push=true при denied — доменная ошибка (зеркало мока, DEV-14 §5);
    granted в том же вызове — валидно."""
    user = _user("0033")
    services.update_settings(user, push_permission="denied", push_enabled=False)

    with pytest.raises(services.PushPermissionDeniedError):
        services.update_settings(user, push_enabled=True)

    settings_row = services.update_settings(user, push_permission="granted", push_enabled=True)
    assert settings_row.push_enabled is True
    assert settings_row.push_permission == "granted"


def test_new_user_gets_email_channel_off_by_default():
    """Решение продукта 25.08 (миграция 0015): e-mail-канал у НОВОГО
    пользователя выключен — дублировать каждое уведомление письмом он
    включает сам. Остальные каналы не тронуты: ЛК юридически значим и
    неотключаем (ADR-057), push/sms остаются включёнными."""
    user = User.objects.create(trust_id="trust-email-default", phone="+79990960301")

    settings_row = services.get_or_create_settings(user)

    assert settings_row.email_enabled is False
    assert settings_row.in_app_enabled is True
    assert settings_row.push_enabled is True
    assert settings_row.sms_enabled is True


def test_email_channel_stays_off_until_user_turns_it_on():
    """Выключенный по умолчанию канал реально глушит письмо, а явное
    включение через PUT /notification-settings его возвращает."""
    user = User.objects.create(
        trust_id="trust-email-optin", phone="+79990960302", email="user@example.com"
    )
    email_provider = _RecordingProvider()

    services.place_notification(
        recipient=user,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        email_provider=email_provider,
    )
    assert email_provider.calls == []

    services.update_settings(user, email_enabled=True)
    services.place_notification(
        recipient=user,
        template="entity_claimed",
        payload={},
        legal_significance=False,
        email_provider=email_provider,
    )
    assert len(email_provider.calls) == 1
