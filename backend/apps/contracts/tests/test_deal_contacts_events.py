"""ADR-106: контрагент попадает в контакты (source=deal) с черновика —
интеграция contracts → outbox → apps.social.subscriber.

Лежит в apps.contracts (а не в apps.social): import-linter запрещает
apps.social импортировать contracts даже в тестах; apps.contracts → social
разрешено. Unit-тесты самого подписчика — apps/social/tests/test_deal_contacts.py.
"""

from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.contracts.tests._signing_helpers import make_person_profile, make_signed_contract
from apps.social import services as social_services
from apps.social.models import Contact
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-dealcontact-{suffix}", phone=f"+7999088{suffix}")


def _drain(*, max_sweeps: int = 5) -> None:
    for _ in range(max_sweeps):
        if relay.deliver_due_events() == 0:
            return


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


def _draft(customer: User, contractor: User) -> Contract:
    make_person_profile(customer)
    contractor_profile = make_person_profile(contractor)
    return contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Ремонт крана",
    )


def _contact(owner: User, target: User) -> Contact | None:
    return Contact.objects.filter(owner=owner, target_user=target).first()


# --- черновик ----------------------------------------------------------------


def test_drafted_event_carries_party_user_ids(customer: User, contractor: User) -> None:
    contract = _draft(customer, contractor)
    event = OutboxEvent.objects.get(topic="contract.drafted", subject__id=str(contract.id))
    assert sorted(event.payload["party_user_ids"]) == sorted([str(customer.id), str(contractor.id)])


def test_draft_adds_counterparty_to_initiator_contacts(customer: User, contractor: User) -> None:
    _draft(customer, contractor)
    _drain()
    contact = _contact(customer, contractor)
    assert contact is not None
    assert contact.source == Contact.Source.DEAL


def test_draft_does_not_add_initiator_to_counterparty_contacts(
    customer: User, contractor: User
) -> None:
    """Контрагент ещё ничего не делал — его контакты не засоряем (ADR-106)."""
    _draft(customer, contractor)
    _drain()
    assert _contact(contractor, customer) is None


def test_draft_is_idempotent_and_keeps_existing_source(customer: User, contractor: User) -> None:
    social_services.add_contact(customer, target_user=contractor, source=Contact.Source.MANUAL)
    _draft(customer, contractor)
    _drain()
    assert Contact.objects.filter(owner=customer, target_user=contractor).count() == 1
    assert _contact(customer, contractor).source == Contact.Source.MANUAL  # type: ignore[union-attr]


def test_second_draft_with_same_counterparty_creates_no_duplicate(
    customer: User, contractor: User
) -> None:
    _draft(customer, contractor)
    _drain()
    contractor_profile = contractor.profiles.get()
    contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Ещё один кран",
    )
    _drain()
    assert Contact.objects.filter(owner=customer, target_user=contractor).count() == 1


# --- подпись: обоюдно --------------------------------------------------------


def test_signed_adds_both_directions(customer: User, contractor: User) -> None:
    make_signed_contract(customer=customer, contractor=contractor)
    _drain()
    assert _contact(customer, contractor) is not None
    assert _contact(contractor, customer) is not None
    assert _contact(contractor, customer).source == Contact.Source.DEAL  # type: ignore[union-attr]
