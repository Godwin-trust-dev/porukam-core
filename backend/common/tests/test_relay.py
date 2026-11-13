"""Тесты relay (ЭФ.1, docs/tasks/fundament.md): доставка неопубликованных
событий подписчикам, ретраи с джиттером при сбое, идемпотентность
подписчика по event_id (без дублей эффекта при повторной доставке).
Ключ "*" (ЭФ.3, docs/adr/ADR-065-*.md) — глобальные подписчики для любого
топика, добавленные поверх точечных."""

from __future__ import annotations

import pytest
from django.test import override_settings
from django.utils import timezone

from common import outbox, relay

pytestmark = pytest.mark.django_db

_delivered: dict[str, int] = {}
_failures_left: dict[str, int] = {}


def _counting_subscriber(event) -> None:  # noqa: ANN001 — сигнатура handler(event)
    """Тестовая заглушка-подписчик: сама себя дедуплицирует по event_id —
    так и должен вести себя реальный подписчик (audit vault/уведомления,
    ЭФ.3/ЭФ.4), т.к. реле может доставить событие повторно."""
    key = str(event.event_id)
    _delivered[key] = _delivered.get(key, 0) + 1


def _flaky_subscriber(event) -> None:  # noqa: ANN001
    """Падает столько раз, сколько заказано в _failures_left[event_id],
    затем ведёт себя как _counting_subscriber."""
    key = str(event.event_id)
    remaining = _failures_left.get(key, 0)
    if remaining > 0:
        _failures_left[key] = remaining - 1
        raise RuntimeError("искусственный сбой подписчика")
    _counting_subscriber(event)


@override_settings(OUTBOX_SUBSCRIBERS={"*": ["common.tests.test_relay._counting_subscriber"]})
def test_wildcard_subscriber_receives_any_topic():
    event = outbox.publish("some.unregistered.topic", subject={}, payload={})

    relay.deliver_due_events()

    event.refresh_from_db()
    assert event.published_at is not None
    assert _delivered[str(event.event_id)] == 1


@override_settings(
    OUTBOX_SUBSCRIBERS={
        "*": ["common.tests.test_relay._counting_subscriber"],
        "account.logged_in": ["common.tests.test_relay._counting_subscriber"],
    }
)
def test_wildcard_and_topic_subscribers_are_both_invoked():
    event = outbox.publish("account.logged_in", subject={}, payload={})

    relay.deliver_due_events()

    event.refresh_from_db()
    assert event.published_at is not None
    assert _delivered[str(event.event_id)] == 2


@override_settings(
    OUTBOX_SUBSCRIBERS={"account.logged_in": ["common.tests.test_relay._counting_subscriber"]}
)
def test_deliver_due_events_marks_published_at():
    event = outbox.publish("account.logged_in", subject={}, payload={})

    delivered = relay.deliver_due_events()

    event.refresh_from_db()
    assert delivered == 1
    assert event.published_at is not None
    assert _delivered[str(event.event_id)] == 1


@override_settings(OUTBOX_SUBSCRIBERS={})
def test_deliver_due_events_without_subscribers_publishes_immediately():
    event = outbox.publish("account.logged_in", subject={}, payload={})

    relay.deliver_due_events()

    event.refresh_from_db()
    assert event.published_at is not None


@override_settings(
    OUTBOX_SUBSCRIBERS={"account.logged_in": ["common.tests.test_relay._counting_subscriber"]}
)
def test_already_published_event_is_not_redelivered():
    event = outbox.publish("account.logged_in", subject={}, payload={})

    relay.deliver_due_events()
    relay.deliver_due_events()

    assert _delivered[str(event.event_id)] == 1


@override_settings(
    OUTBOX_SUBSCRIBERS={"account.logged_in": ["common.tests.test_relay._flaky_subscriber"]}
)
def test_failed_subscriber_is_retried_with_backoff_and_without_duplicate_effect():
    event = outbox.publish("account.logged_in", subject={}, payload={})
    _failures_left[str(event.event_id)] = 1

    delivered_first_pass = relay.deliver_due_events()
    event.refresh_from_db()
    assert delivered_first_pass == 0
    assert event.published_at is None
    assert event.delivery_attempts == 1
    assert event.next_attempt_at is not None
    assert str(event.event_id) not in _delivered  # эффект ещё не применялся

    # Повторный sweep раньше next_attempt_at — событие не трогаем.
    delivered_too_early = relay.deliver_due_events()
    event.refresh_from_db()
    assert delivered_too_early == 0
    assert event.delivery_attempts == 1

    event.next_attempt_at = timezone.now()
    event.save(update_fields=["next_attempt_at"])

    delivered_second_pass = relay.deliver_due_events()
    event.refresh_from_db()
    assert delivered_second_pass == 1
    assert event.published_at is not None
    assert _delivered[str(event.event_id)] == 1  # без дублей эффекта
