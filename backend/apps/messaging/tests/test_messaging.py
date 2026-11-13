"""apps.messaging (ADR-112): переписка по договору — сервисы + HTTP-слой.

Каждый запрет — отдельным тестом (CLAUDE.md): не сторона — 404; пустое
сообщение — 422; уведомление контрагенту — одно на серию непрочитанных.
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.contracts.tests._signing_helpers import make_user
from apps.messaging import selectors, services
from apps.messaging.models import Message
from apps.notifications.models import Notification
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("msg-cst")


@pytest.fixture
def contractor():
    return make_user("msg-ctr")


@pytest.fixture
def stranger():
    return make_user("msg-str")


@pytest.fixture
def contract(customer, contractor):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    return contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Переписка",
    )


# --- services ----------------------------------------------------------------


def test_send_and_list(contract, customer, contractor):
    services.send_message(contract, user=customer, body="Добрый день!")
    services.send_message(contract, user=contractor, body="Здравствуйте.")
    bodies = [m.body for m in selectors.list_messages(contract)]
    assert bodies == ["Добрый день!", "Здравствуйте."]


def test_empty_message_rejected(contract, customer):
    with pytest.raises(services.EmptyMessageError):
        services.send_message(contract, user=customer, body="   ")
    assert Message.objects.count() == 0


def test_unread_and_mark_read(contract, customer, contractor):
    services.send_message(contract, user=customer, body="Раз")
    services.send_message(contract, user=customer, body="Два")
    owned_contractor = {p.profile_id for p in contract.parties.all() if p.role == "contractor"}
    assert selectors.unread_count(contract, owned_profile_ids=owned_contractor) == 2

    updated = services.mark_read(contract, user=contractor)
    assert updated == 2
    assert selectors.unread_count(contract, owned_profile_ids=owned_contractor) == 0
    # Идемпотентно.
    assert services.mark_read(contract, user=contractor) == 0


def test_notification_once_per_unread_series(contract, customer, contractor):
    """Анти-шторм (ADR-112 §5): уведомление контрагенту — одно, пока серия
    не прочитана; после прочтения следующее сообщение снова уведомляет."""
    services.send_message(contract, user=customer, body="Раз")
    services.send_message(contract, user=customer, body="Два")
    assert (
        Notification.objects.filter(recipient=contractor, template="message.received").count() == 1
    )

    services.mark_read(contract, user=contractor)
    services.send_message(contract, user=customer, body="Три")
    assert (
        Notification.objects.filter(recipient=contractor, template="message.received").count() == 2
    )


def test_threads_list(contract, customer, contractor):
    services.send_message(contract, user=customer, body="Привет")
    threads = selectors.list_threads(contractor)
    assert len(threads) == 1
    assert threads[0]["contract_id"] == str(contract.id)
    assert threads[0]["unread_count"] == 1
    assert threads[0]["last_message"]["body"] == "Привет"
    # У постороннего диалогов нет.
    assert selectors.list_threads(make_user("msg-empty")) == []


# --- HTTP-слой ---------------------------------------------------------------


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_http_requires_authentication(contract):
    client = APIClient()
    assert client.get(f"/v1/contracts/{contract.id}/messages").status_code == 401
    assert client.get("/v1/messages/threads").status_code == 401


def test_http_stranger_gets_404(contract, stranger):
    client = _client(stranger)
    assert client.get(f"/v1/contracts/{contract.id}/messages").status_code == 404
    resp = client.post(f"/v1/contracts/{contract.id}/messages", {"body": "чужой"}, format="json")
    assert resp.status_code == 404
    assert Message.objects.count() == 0


def test_http_send_list_read_flow(contract, customer, contractor):
    customer_client = _client(customer)
    resp = customer_client.post(
        f"/v1/contracts/{contract.id}/messages", {"body": "Добрый день!"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["body"] == "Добрый день!"

    contractor_client = _client(contractor)
    listing = contractor_client.get(f"/v1/contracts/{contract.id}/messages")
    assert listing.status_code == 200
    assert listing.data["unread_count"] == 1
    assert [i["body"] for i in listing.data["items"]] == ["Добрый день!"]

    after_read = contractor_client.post(f"/v1/contracts/{contract.id}/messages/read")
    assert after_read.status_code == 200
    assert after_read.data["unread_count"] == 0

    threads = contractor_client.get("/v1/messages/threads")
    assert threads.status_code == 200
    assert threads.data[0]["contract_id"] == str(contract.id)


def test_http_empty_body_rejected(contract, customer):
    """Пробельное тело срезает CharField (trim_whitespace) ещё в сериализаторе —
    400 invalid_request; EmptyMessageError сервиса — рубеж для прямых вызовов."""
    resp = _client(customer).post(
        f"/v1/contracts/{contract.id}/messages", {"body": "   "}, format="json"
    )
    assert resp.status_code == 400
    assert Message.objects.count() == 0
