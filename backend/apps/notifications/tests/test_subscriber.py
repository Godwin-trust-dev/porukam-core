"""docs/tasks/fundament.md ЭФ.4 — приёмка: «в dev выполнить claim -> в GET
/notifications появилось уведомление с placed_in_cabinet_at; связанный
тестовый дедлайн заякорился этим временем». Использует реальный поток
apps.entities.services (entity.claimed уже связан с шаблоном entity_claimed
через settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES, migrations/0002;
получатель — явный payload.notify_user_id, ADR-178)."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.deadlines import services as deadline_services
from apps.deadlines.models import DeadlineKindConfig, DomainDeadline
from apps.entities import services as entity_services
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider
from apps.notifications.models import Notification
from apps.notifications.subscriber import handle_event
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )


def test_claim_places_notification_and_anchors_linked_test_deadline():
    user = User.objects.create(trust_id="trust-notif-claim-1", phone="+79990900201")
    _verify(user, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)

    entity = entity_services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )

    # Тестовый дедлайн, привязанный к субъекту claim'а (docs/tasks/fundament.md
    # ЭФ.4 приёмка: «связанный тестовый дедлайн» — kind ad hoc для этого теста,
    # реальные обработчики автоприёмки/спора появятся в этапе 4.
    DeadlineKindConfig.objects.get_or_create(
        kind="notifications_subscriber_test", defaults={"duration": timedelta(days=3)}
    )
    linked_deadline = deadline_services.create_deadline(
        kind="notifications_subscriber_test",
        subject_type="business_entity",
        subject_id=entity.id,
        starts_from=DomainDeadline.StartsFrom.CABINET_PLACEMENT,
    )
    assert linked_deadline.anchor_at is None  # не тикает до размещения уведомления

    event = OutboxEvent.objects.get(topic="entity.claimed", subject__id=str(entity.id))
    handle_event(event)

    notification = Notification.objects.get(recipient=user, template="entity_claimed")
    assert notification.placed_in_cabinet_at is not None

    linked_deadline.refresh_from_db()
    assert linked_deadline.anchor_at == notification.placed_in_cabinet_at
    assert linked_deadline.deadline_at == linked_deadline.anchor_at + timedelta(days=3)


def test_relay_delivers_entity_claimed_to_notifications_subscriber():
    user = User.objects.create(trust_id="trust-notif-claim-2", phone="+79990900202")
    _verify(user, full_name="Анна Смирнова", tax_id=FakeEntityRegistryProvider.SELF_EMPLOYED_INN)

    entity_services.register_business_entity(
        FakeEntityRegistryProvider.SELF_EMPLOYED_INN,
        country="RU",
        created_by=user,
        provider=_registry,
    )

    delivered = relay.deliver_due_events()
    assert delivered >= 1
    assert Notification.objects.filter(recipient=user, template="entity_claimed").exists()


def test_handle_event_ignores_unmapped_topic():
    event = OutboxEvent.objects.create(
        topic="unmapped.topic",
        occurred_at=timezone.now(),
        actor={"user_id": str(UUID(int=0))},
        subject={},
        payload={},
    )
    handle_event(event)
    assert Notification.objects.count() == 0


def test_handle_event_ignores_event_without_actor():
    event = OutboxEvent.objects.create(
        topic="entity.claimed",
        occurred_at=timezone.now(),
        actor={},
        subject={"type": "business_entity", "id": str(UUID(int=1))},
        payload={},
    )
    handle_event(event)
    assert Notification.objects.count() == 0


def test_subscriber_honors_payload_notify_user_id(db):
    """События объединений адресуются НЕ актору: payload.notify_user_id
    главнее actor.user_id (отсмотр 2026-08-23, группа-уведомления)."""
    from apps.accounts.models import User
    from apps.notifications import subscriber
    from apps.notifications.models import Notification
    from common.models import OutboxEvent

    actor_user = User.objects.create(trust_id="trust-sub-actor", phone="+79990970001")
    recipient = User.objects.create(trust_id="trust-sub-recipient", phone="+79990970002")
    from django.utils import timezone

    event = OutboxEvent.objects.create(
        topic="group.join_requested",
        occurred_at=timezone.now(),
        subject={"type": "group", "id": "00000000-0000-0000-0000-000000000001"},
        payload={"notify_user_id": str(recipient.id), "group_name": "Мастера"},
        actor={"user_id": str(actor_user.id)},
    )
    subscriber.handle_event(event)
    notification = Notification.objects.get(template="group.join_requested")
    assert notification.recipient_id == recipient.id


def test_addressee_registry_does_not_fall_back_to_actor(settings):
    """ADR-178, regression: до этой правки `actor.user_id` был фолбэком в
    реестре адресата, когда `payload.notify_user_id` отсутствовал — именно
    этот фолбэк порождал карточку самому актору («ваше действие
    зафиксировано») на каждое действие по договору, отсюда жалоба владельца
    11.09 «уведомления должны приходить только по действиям контрагентов, не
    моих». Запись реестра без notify_user_id в payload не должна доставлять
    уведомление актору события."""
    from apps.notifications import subscriber

    actor = User.objects.create(trust_id="trust-sub-no-fallback", phone="+79990970013")
    settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES = {"some.topic": "some.topic"}
    settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES = {}
    event = OutboxEvent.objects.create(
        topic="some.topic",
        occurred_at=timezone.now(),
        subject={},
        payload={},
        actor={"user_id": str(actor.id)},
    )
    subscriber.handle_event(event)
    assert Notification.objects.count() == 0


def test_dict_registry_explicit_none_suppresses_notification(settings):
    """Дополнение 26.08 к ADR-131: `amendment.rejected` с `cause=discount_declined`
    — следствие отказа от скидки, о моменте уже говорит `dispute.discount_
    declined`; явный None под ключом-дискриминатором глушит уведомление,
    любой другой `cause` (и его отсутствие) уходит в "*". Реестр адресата
    (ADR-178) размещает карточку ТОЛЬКО по явному payload.notify_user_id —
    здесь он есть намеренно, чтобы проверить именно логику дискриминатора
    `_resolve_template_code`, а не сам факт адресации."""
    from apps.notifications import subscriber

    actor = User.objects.create(trust_id="trust-sub-cause-actor", phone="+79990970011")
    addressee = User.objects.create(trust_id="trust-sub-cause-addressee", phone="+79990970012")
    settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES = {
        "amendment.rejected": {"discount_declined": None, "*": "amendment.rejected"}
    }
    settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES = {}

    def _event(cause: str | None) -> OutboxEvent:
        payload = {"reason": "", "notify_user_id": str(addressee.id)}
        if cause is not None:
            payload["cause"] = cause
        return OutboxEvent.objects.create(
            topic="amendment.rejected",
            occurred_at=timezone.now(),
            subject={"type": "amendment", "id": str(UUID(int=7))},
            payload=payload,
            actor={"user_id": str(actor.id)},
        )

    subscriber.handle_event(_event("discount_declined"))
    assert Notification.objects.count() == 0
    subscriber.handle_event(_event(""))
    subscriber.handle_event(_event(None))
    assert Notification.objects.filter(template="amendment.rejected").count() == 2
