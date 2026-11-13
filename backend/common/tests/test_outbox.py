import pytest
from django.db import transaction

from common import outbox
from common.models import OutboxEvent


@pytest.mark.django_db
def test_publish_creates_outbox_row():
    event = outbox.publish(
        "account.logged_in",
        subject={"type": "user", "id": "1"},
        payload={"device_id": 1},
        actor={"user_id": "1", "profile_id": None},
    )
    stored = OutboxEvent.objects.get(event_id=event.event_id)
    assert stored.topic == "account.logged_in"
    assert stored.subject == {"type": "user", "id": "1"}
    assert stored.payload == {"device_id": 1}
    assert stored.actor == {"user_id": "1", "profile_id": None}
    assert stored.schema_version == 1


@pytest.mark.django_db
def test_publish_defaults_actor_to_empty_dict():
    event = outbox.publish("account.logged_in", subject={}, payload={})
    assert event.actor == {}


@pytest.mark.django_db
def test_publish_not_persisted_on_transaction_rollback():
    with pytest.raises(RuntimeError), transaction.atomic():
        outbox.publish("account.logged_in", subject={}, payload={})
        raise RuntimeError("откат по бизнес-ошибке в том же transaction.atomic()")
    assert OutboxEvent.objects.count() == 0


@pytest.mark.django_db
def test_publish_persisted_exactly_once_after_commit():
    with transaction.atomic():
        event = outbox.publish("account.logged_in", subject={}, payload={})
    assert OutboxEvent.objects.filter(event_id=event.event_id).count() == 1
