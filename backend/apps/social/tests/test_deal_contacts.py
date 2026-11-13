"""ADR-106: unit-тесты apps.social.subscriber — защитные ветки на
синтетических OutboxEvent. Интеграция с реальными событиями договора —
apps/contracts/tests/test_deal_contacts_events.py (import-linter: social не
импортирует contracts)."""

from __future__ import annotations

from typing import Any

import pytest

from apps.accounts.models import User
from apps.social import subscriber
from apps.social.models import Contact
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-dealcontact-{suffix}", phone=f"+7999088{suffix}")


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


# --- подписчик напрямую: защитные ветки -------------------------------------


def _event(
    topic: str, *, payload: dict[str, Any], actor: dict[str, Any] | None = None
) -> OutboxEvent:
    return OutboxEvent(
        topic=topic, subject={"type": "contract", "id": "x"}, payload=payload, actor=actor or {}
    )


def test_subscriber_ignores_foreign_topic(customer: User, contractor: User) -> None:
    subscriber.handle_event(
        _event(
            "contract.completed",
            payload={"party_user_ids": [str(customer.id), str(contractor.id)]},
            actor={"user_id": str(customer.id)},
        )
    )
    assert Contact.objects.count() == 0


def test_subscriber_ignores_event_without_parties(customer: User) -> None:
    subscriber.handle_event(
        _event("contract.drafted", payload={}, actor={"user_id": str(customer.id)})
    )
    assert Contact.objects.count() == 0


def test_subscriber_ignores_actor_not_among_parties(customer: User, contractor: User) -> None:
    stranger = _user("0003")
    subscriber.handle_event(
        _event(
            "contract.drafted",
            payload={"party_user_ids": [str(customer.id), str(contractor.id)]},
            actor={"user_id": str(stranger.id)},
        )
    )
    assert Contact.objects.count() == 0


def test_subscriber_skips_unknown_user_ids(customer: User) -> None:
    subscriber.handle_event(
        _event(
            "contract.signed",
            payload={"party_user_ids": [str(customer.id), "00000000-0000-0000-0000-000000000000"]},
        )
    )
    assert Contact.objects.count() == 0


def test_subscriber_drafted_adds_contact_for_actor_only(customer: User, contractor: User) -> None:
    subscriber.handle_event(
        _event(
            "contract.drafted",
            payload={"party_user_ids": [str(customer.id), str(contractor.id)]},
            actor={"user_id": str(customer.id)},
        )
    )
    assert Contact.objects.filter(owner=customer, target_user=contractor, source="deal").exists()
    assert not Contact.objects.filter(owner=contractor).exists()


def test_subscriber_signed_adds_both_and_is_idempotent(customer: User, contractor: User) -> None:
    event = _event(
        "contract.signed", payload={"party_user_ids": [str(customer.id), str(contractor.id)]}
    )
    subscriber.handle_event(event)
    subscriber.handle_event(event)
    assert Contact.objects.count() == 2
