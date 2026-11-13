"""Приёмка ЭФ.3: подписка Audit Vault на ВСЕ outbox-события через
settings.OUTBOX_SUBSCRIBERS["*"] (принцип §37a); недоступность Vault не
роняет доменную операцию и не теряет событие (остаётся на ретрай)."""

from __future__ import annotations

import pytest

from apps.accounts import services as accounts_services
from apps.accounts.providers import FakeSMSGateway
from apps.audit import subscriber
from common import relay
from common.models import OutboxEvent
from services.audit_vault.models import AuditEntry

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def test_wildcard_subscriber_writes_vault_entry_via_relay_default_settings():
    gateway = FakeSMSGateway()
    accounts_services.request_otp("+79996600001", gateway=gateway)
    accounts_services.verify_otp("+79996600001", "111111")

    event = OutboxEvent.objects.get(topic="account.logged_in")
    assert event.published_at is None

    delivered = relay.deliver_due_events()

    event.refresh_from_db()
    assert delivered == 1
    assert event.published_at is not None
    entry = AuditEntry.objects.get(source_event_id=event.event_id)
    assert entry.action == "account.logged_in"
    assert entry.target_type == "user"


_flaky_failures_left: dict[str, int] = {}


def _flaky_other_subscriber(event: OutboxEvent) -> None:
    key = str(event.event_id)
    remaining = _flaky_failures_left.get(key, 0)
    if remaining > 0:
        _flaky_failures_left[key] = remaining - 1
        raise RuntimeError("искусственный сбой другого подписчика той же темы")


def test_redelivery_after_sibling_subscriber_failure_does_not_duplicate_vault_entry(settings):
    settings.OUTBOX_SUBSCRIBERS = {
        "account.logged_in": [
            "apps.audit.tests.test_subscriber._flaky_other_subscriber",
            "apps.audit.subscriber.handle_event",
        ]
    }
    gateway = FakeSMSGateway()
    accounts_services.request_otp("+79996600002", gateway=gateway)
    accounts_services.verify_otp("+79996600002", "111111")
    event = OutboxEvent.objects.get(topic="account.logged_in")
    _flaky_failures_left[str(event.event_id)] = 1

    delivered_first = relay.deliver_due_events()
    event.refresh_from_db()
    assert delivered_first == 0
    assert event.published_at is None
    assert AuditEntry.objects.filter(source_event_id=event.event_id).count() == 1

    event.next_attempt_at = None
    event.delivery_attempts = 0
    event.save(update_fields=["next_attempt_at", "delivery_attempts"])

    delivered_second = relay.deliver_due_events()
    event.refresh_from_db()
    assert delivered_second == 1
    assert event.published_at is not None
    assert AuditEntry.objects.filter(source_event_id=event.event_id).count() == 1


def test_vault_unreachable_does_not_fail_domain_operation_and_event_is_not_lost(monkeypatch):
    def _boom(event: OutboxEvent) -> None:
        raise RuntimeError("Audit Vault недоступен (симуляция деградации)")

    monkeypatch.setattr(subscriber, "handle_event", _boom)

    gateway = FakeSMSGateway()
    accounts_services.request_otp("+79996600003", gateway=gateway)
    user, tokens = accounts_services.verify_otp("+79996600003", "111111")
    assert user.phone == "+79996600003"
    assert tokens.access

    event = OutboxEvent.objects.get(topic="account.logged_in")

    delivered = relay.deliver_due_events()

    event.refresh_from_db()
    assert delivered == 0
    assert event.published_at is None
    assert event.delivery_attempts == 1
    assert AuditEntry.objects.filter(source_event_id=event.event_id).count() == 0
