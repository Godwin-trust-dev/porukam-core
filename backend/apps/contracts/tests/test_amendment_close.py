"""Дополнение 26.08 к ADR-075: отзыв (`withdraw_amendment`) и отклонение
(`reject_amendment`) допника — каждый переход и каждый запрет отдельным
тестом (CLAUDE.md), плюс API, хроника допника, уведомления обеим сторонам и
`SignatureRequestSerializer.signed_at`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from django.conf import settings
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import (
    Amendment,
    AmendmentChange,
    Contract,
    ContractParty,
    ContractVersion,
    Signature,
    SignatureRequest,
)
from apps.l10n import services as l10n_services
from apps.notifications import selectors as notification_selectors
from apps.notifications.models import Notification
from common import relay
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

from ._signing_helpers import make_signed_contract, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_STATUS = Contract.NegotiationStatus
_CHANGE_TYPE = AmendmentChange.Type
_SIG_STATUS = SignatureRequest.Status


@pytest.fixture
def customer() -> User:
    return make_user("c0001")


@pytest.fixture
def contractor() -> User:
    return make_user("c0002")


@pytest.fixture
def signed_contract(customer: User, contractor: User) -> Contract:
    return make_signed_contract(customer=customer, contractor=contractor)


@pytest.fixture
def under_review_amendment(signed_contract: Contract, customer: User) -> Amendment:
    """Инициатор — заказчик."""
    amendment = services.create_amendment(
        signed_contract,
        user=customer,
        reason="Добавили работы",
        changes=[
            {
                "type": _CHANGE_TYPE.ADD_MILESTONE,
                "payload": {"title": "Доп. работа", "amount": "3000.00", "currency": "RUB"},
            }
        ],
    )
    return services.send_amendment_for_review(amendment, user=customer)


@pytest.fixture
def frozen_amendment(under_review_amendment: Amendment, customer: User) -> Amendment:
    services.freeze_amendment(under_review_amendment, user=customer)
    under_review_amendment.refresh_from_db()
    return under_review_amendment


@pytest.fixture
def awaiting_amendment(frozen_amendment: Amendment, customer: User, contractor: User):
    customer_request = services.route_amendment_signatory(
        frozen_amendment,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_amendment.frozen_version_id,
        signatory_user_id=customer.id,
    )
    contractor_request = services.route_amendment_signatory(
        frozen_amendment,
        user=contractor,
        side=_ROLE.CONTRACTOR,
        version_id=frozen_amendment.frozen_version_id,
        signatory_user_id=contractor.id,
    )
    frozen_amendment.refresh_from_db()
    return frozen_amendment, customer_request, contractor_request


def _client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# --- withdraw_amendment: переходы ------------------------------------------


def test_withdraw_from_under_review(under_review_amendment: Amendment, customer: User):
    amendment = services.withdraw_amendment(
        under_review_amendment, user=customer, reason="передумали"
    )
    assert amendment.negotiation_status == _STATUS.WITHDRAWN_BY_INITIATOR
    event = OutboxEvent.objects.get(topic="amendment.withdrawn")
    assert event.subject == {"type": "amendment", "id": str(amendment.id)}
    assert event.payload["contract_id"] == str(amendment.contract_id)
    assert event.payload["reason"] == "передумали"
    assert event.payload["annulled_signature_request_ids"] == []
    assert event.actor == {"user_id": str(customer.id)}


def test_withdraw_from_pending_signature_drops_frozen_version(
    frozen_amendment: Amendment, customer: User
):
    version_id = frozen_amendment.frozen_version_id
    services.withdraw_amendment(frozen_amendment, user=customer)
    frozen_amendment.refresh_from_db()
    assert frozen_amendment.negotiation_status == _STATUS.WITHDRAWN_BY_INITIATOR
    assert frozen_amendment.frozen_version_id is None
    # Снимок append-only — строка версии остаётся.
    assert ContractVersion.objects.filter(pk=version_id).exists()


def test_withdraw_from_awaiting_signatures_annuls_amendment_round_only(
    awaiting_amendment, customer: User, contractor: User, signed_contract: Contract
):
    amendment, customer_request, contractor_request = awaiting_amendment
    services.sign_amendment(
        contractor_request, user=contractor, version_hash=amendment.frozen_version.integrity_hash
    )
    services.withdraw_amendment(amendment, user=customer)
    amendment.refresh_from_db()
    customer_request.refresh_from_db()
    contractor_request.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.WITHDRAWN_BY_INITIATOR
    assert customer_request.status == _SIG_STATUS.DECLINED_FOR_REVISION
    # Уже подписанный запрос не «pending» — статус не переписывается, подпись удалена.
    assert contractor_request.status == _SIG_STATUS.SIGNED
    assert Signature.objects.filter(amendment=amendment).count() == 0
    event = OutboxEvent.objects.get(topic="amendment.withdrawn")
    assert event.payload["annulled_signature_request_ids"] == [str(customer_request.id)]
    assert len(event.payload["annulled_signature_ids"]) == 1
    # Договорный раунд (Э4.4) цел.
    assert Signature.objects.filter(contract=signed_contract, amendment__isnull=True).count() == 2
    signed_contract.refresh_from_db()
    assert signed_contract.negotiation_status == _STATUS.SIGNED
    assert signed_contract.frozen_version_id is not None


# --- withdraw_amendment: запреты -------------------------------------------


def test_withdraw_by_counterparty_is_not_initiator(
    under_review_amendment: Amendment, contractor: User
):
    with pytest.raises(services.NotInitiatorError):
        services.withdraw_amendment(under_review_amendment, user=contractor)
    under_review_amendment.refresh_from_db()
    assert under_review_amendment.negotiation_status == _STATUS.UNDER_REVIEW


def test_withdraw_by_stranger_is_not_a_party(under_review_amendment: Amendment):
    with pytest.raises(services.NotAPartyError):
        services.withdraw_amendment(under_review_amendment, user=make_user("c0009"))


def test_withdraw_from_draft_is_invalid_transition(signed_contract: Contract, customer: User):
    draft = services.create_amendment(
        signed_contract,
        user=customer,
        reason="черновик",
        changes=[{"type": _CHANGE_TYPE.CUSTOM_TERM, "payload": {"text": "x"}}],
    )
    with pytest.raises(InvalidTransitionError):
        services.withdraw_amendment(draft, user=customer)


def test_withdraw_signed_amendment_is_invalid_transition(
    awaiting_amendment, customer: User, contractor: User
):
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    services.sign_amendment(contractor_request, user=contractor, version_hash=version_hash)
    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.SIGNED
    with pytest.raises(InvalidTransitionError):
        services.withdraw_amendment(amendment, user=customer)
    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.SIGNED
    assert Signature.objects.filter(amendment=amendment).count() == 2


def test_withdraw_twice_is_invalid_transition(under_review_amendment: Amendment, customer: User):
    services.withdraw_amendment(under_review_amendment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.withdraw_amendment(under_review_amendment, user=customer)


def test_withdraw_rejected_amendment_is_invalid_transition(
    under_review_amendment: Amendment, customer: User, contractor: User
):
    services.reject_amendment(under_review_amendment, user=contractor)
    with pytest.raises(InvalidTransitionError):
        services.withdraw_amendment(under_review_amendment, user=customer)


# --- reject_amendment: переходы ---------------------------------------------


def test_reject_from_under_review(under_review_amendment: Amendment, contractor: User):
    amendment = services.reject_amendment(
        under_review_amendment, user=contractor, reason="не согласен с суммой"
    )
    assert amendment.negotiation_status == _STATUS.REJECTED_BY_COUNTERPARTY
    event = OutboxEvent.objects.get(topic="amendment.rejected")
    assert event.subject == {"type": "amendment", "id": str(amendment.id)}
    assert event.payload["reason"] == "не согласен с суммой"
    assert event.payload["order"] == amendment.order
    assert event.actor == {"user_id": str(contractor.id)}


def test_reject_from_pending_signature_drops_frozen_version(
    frozen_amendment: Amendment, contractor: User
):
    services.reject_amendment(frozen_amendment, user=contractor)
    frozen_amendment.refresh_from_db()
    assert frozen_amendment.negotiation_status == _STATUS.REJECTED_BY_COUNTERPARTY
    assert frozen_amendment.frozen_version_id is None


def test_reject_from_awaiting_signatures_annuls_pending_requests(
    awaiting_amendment, customer: User, contractor: User
):
    amendment, customer_request, contractor_request = awaiting_amendment
    services.sign_amendment(
        customer_request, user=customer, version_hash=amendment.frozen_version.integrity_hash
    )
    services.reject_amendment(amendment, user=contractor)
    amendment.refresh_from_db()
    contractor_request.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.REJECTED_BY_COUNTERPARTY
    assert contractor_request.status == _SIG_STATUS.DECLINED_FOR_REVISION
    assert Signature.objects.filter(amendment=amendment).count() == 0
    assert amendment.frozen_version_id is None


# --- reject_amendment: запреты ---------------------------------------------


def test_reject_by_initiator_is_not_counterparty(under_review_amendment: Amendment, customer: User):
    with pytest.raises(services.NotCounterpartyError):
        services.reject_amendment(under_review_amendment, user=customer)
    under_review_amendment.refresh_from_db()
    assert under_review_amendment.negotiation_status == _STATUS.UNDER_REVIEW


def test_reject_by_stranger_is_not_a_party(under_review_amendment: Amendment):
    with pytest.raises(services.NotAPartyError):
        services.reject_amendment(under_review_amendment, user=make_user("c0010"))


def test_reject_from_draft_is_invalid_transition(
    signed_contract: Contract, customer: User, contractor: User
):
    draft = services.create_amendment(
        signed_contract,
        user=customer,
        reason="черновик",
        changes=[{"type": _CHANGE_TYPE.CUSTOM_TERM, "payload": {"text": "x"}}],
    )
    with pytest.raises(InvalidTransitionError):
        services.reject_amendment(draft, user=contractor)


def test_reject_signed_amendment_is_invalid_transition(
    awaiting_amendment, customer: User, contractor: User
):
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    services.sign_amendment(contractor_request, user=contractor, version_hash=version_hash)
    amendment.refresh_from_db()
    with pytest.raises(InvalidTransitionError):
        services.reject_amendment(amendment, user=contractor)
    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.SIGNED


def test_reject_twice_is_invalid_transition(under_review_amendment: Amendment, contractor: User):
    services.reject_amendment(under_review_amendment, user=contractor)
    with pytest.raises(InvalidTransitionError):
        services.reject_amendment(under_review_amendment, user=contractor)


def test_reject_withdrawn_amendment_is_invalid_transition(
    under_review_amendment: Amendment, customer: User, contractor: User
):
    services.withdraw_amendment(under_review_amendment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.reject_amendment(under_review_amendment, user=contractor)


def test_closed_amendment_cannot_be_frozen_or_sent(
    under_review_amendment: Amendment, customer: User, contractor: User
):
    """Терминал: из отклонённого допника нет пути обратно в контур подписания."""
    services.reject_amendment(under_review_amendment, user=contractor)
    with pytest.raises(InvalidTransitionError):
        services.freeze_amendment(under_review_amendment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.send_amendment_for_review(under_review_amendment, user=customer)


# --- Хроника допника ---------------------------------------------------------


def test_amendment_timeline_contains_withdrawn_and_rejected_events(
    under_review_amendment: Amendment, customer: User, contractor: User
):
    services.withdraw_amendment(under_review_amendment, user=customer, reason="передумали")
    resp = _client(contractor).get(f"/v1/amendments/{under_review_amendment.id}/timeline")
    assert resp.status_code == 200, resp.content
    topics = [e["topic"] for e in resp.json()]
    assert topics[-1] == "amendment.withdrawn"
    assert resp.json()[-1]["payload"]["reason"] == "передумали"


# --- API ----------------------------------------------------------------------


def test_withdraw_api_by_initiator(under_review_amendment: Amendment, customer: User):
    resp = _client(customer).post(
        f"/v1/amendments/{under_review_amendment.id}/withdraw",
        {"reason": "передумали"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["negotiation_status"] == "withdrawn_by_initiator"
    assert resp.json()["frozen_version_id"] is None


def test_withdraw_api_without_body(under_review_amendment: Amendment, customer: User):
    resp = _client(customer).post(f"/v1/amendments/{under_review_amendment.id}/withdraw")
    assert resp.status_code == 200, resp.content


def test_withdraw_api_by_counterparty_is_403(under_review_amendment: Amendment, contractor: User):
    resp = _client(contractor).post(
        f"/v1/amendments/{under_review_amendment.id}/withdraw", {}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "not_initiator"


def test_withdraw_api_by_stranger_is_403(under_review_amendment: Amendment):
    resp = _client(make_user("c0011")).post(
        f"/v1/amendments/{under_review_amendment.id}/withdraw", {}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "permission_denied"


def test_withdraw_api_twice_is_409(under_review_amendment: Amendment, customer: User):
    client = _client(customer)
    url = f"/v1/amendments/{under_review_amendment.id}/withdraw"
    assert client.post(url, {}, format="json").status_code == 200
    resp = client.post(url, {}, format="json")
    assert resp.status_code == 409
    assert resp.json()["code"] == "invalid_negotiation_transition"


def test_reject_api_by_counterparty(frozen_amendment: Amendment, contractor: User):
    resp = _client(contractor).post(
        f"/v1/amendments/{frozen_amendment.id}/reject", {"reason": "дорого"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["negotiation_status"] == "rejected_by_counterparty"
    assert resp.json()["frozen_version_id"] is None


def test_reject_api_by_initiator_is_403(under_review_amendment: Amendment, customer: User):
    resp = _client(customer).post(
        f"/v1/amendments/{under_review_amendment.id}/reject", {}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "not_counterparty"


def test_reject_api_by_stranger_is_403(under_review_amendment: Amendment):
    resp = _client(make_user("c0012")).post(
        f"/v1/amendments/{under_review_amendment.id}/reject", {}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "permission_denied"


def test_reject_api_on_signed_amendment_is_409(
    awaiting_amendment, customer: User, contractor: User
):
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    services.sign_amendment(contractor_request, user=contractor, version_hash=version_hash)
    resp = _client(contractor).post(f"/v1/amendments/{amendment.id}/reject", {}, format="json")
    assert resp.status_code == 409
    assert resp.json()["code"] == "invalid_negotiation_transition"


def test_reject_api_twice_is_409(under_review_amendment: Amendment, contractor: User):
    client = _client(contractor)
    url = f"/v1/amendments/{under_review_amendment.id}/reject"
    assert client.post(url, {}, format="json").status_code == 200
    assert client.post(url, {}, format="json").status_code == 409


# --- SignatureRequestSerializer.signed_at ------------------------------------


def test_signature_request_signed_at_is_null_until_signed(awaiting_amendment, customer: User):
    amendment, customer_request, contractor_request = awaiting_amendment
    resp = _client(customer).get(f"/v1/amendments/{amendment.id}/signature-requests")
    assert resp.status_code == 200
    assert all(item["signed_at"] is None for item in resp.json())

    services.sign_amendment(
        customer_request, user=customer, version_hash=amendment.frozen_version.integrity_hash
    )
    resp = _client(customer).get(f"/v1/amendments/{amendment.id}/signature-requests")
    by_id = {item["id"]: item for item in resp.json()}
    signed_at = Signature.objects.get(amendment=amendment, side=_ROLE.CUSTOMER).signed_at
    assert by_id[str(customer_request.id)]["signed_at"] == signed_at.isoformat()
    assert by_id[str(contractor_request.id)]["signed_at"] is None


def test_signature_request_signed_at_is_null_after_round_annulled(
    awaiting_amendment, customer: User
):
    amendment, customer_request, _ = awaiting_amendment
    services.sign_amendment(
        customer_request, user=customer, version_hash=amendment.frozen_version.integrity_hash
    )
    services.withdraw_amendment(amendment, user=customer)
    resp = _client(customer).get(f"/v1/signature-requests/{customer_request.id}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "signed"
    assert resp.json()["signed_at"] is None


# --- Уведомления (ADR-126) ----------------------------------------------------

_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"


@pytest.fixture
def _l10n_packs():
    for code in ("en", "ru"):
        l10n_services.import_pack(
            json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))
        )


def _templates(user: User) -> set[str]:
    return set(Notification.objects.filter(recipient=user).values_list("template", flat=True))


def test_reject_notifies_only_the_other_side(
    _l10n_packs, under_review_amendment: Amendment, customer: User, contractor: User
):
    """ADR-178: `contractor` — актор отказа, свою же карточку не получает;
    получает только `customer`."""
    relay.deliver_due_events()
    Notification.objects.all().delete()
    services.reject_amendment(under_review_amendment, user=contractor)
    relay.deliver_due_events()
    assert "amendment.rejected" in _templates(customer)
    assert "amendment.rejected" not in _templates(contractor)
    notification = Notification.objects.get(recipient=customer, template="amendment.rejected")
    assert notification.legal_significance is True
    assert str(notification.contract_id) == str(under_review_amendment.contract_id)
    ru = notification_selectors.render_body("amendment.rejected", locale="ru")
    en = notification_selectors.render_body("amendment.rejected", locale="en")
    assert ru.startswith("Допсоглашение к договору") and "отклонено" in ru
    assert en and ru != en
    assert notification_selectors.render_subject("amendment.rejected", locale="ru")


def test_withdraw_notifies_only_the_other_side(
    _l10n_packs, frozen_amendment: Amendment, customer: User, contractor: User
):
    """ADR-178: `customer` — актор отзыва, свою же карточку не получает;
    получает только `contractor`."""
    relay.deliver_due_events()
    Notification.objects.all().delete()
    services.withdraw_amendment(frozen_amendment, user=customer)
    relay.deliver_due_events()
    assert "amendment.withdrawn" not in _templates(customer)
    assert "amendment.withdrawn" in _templates(contractor)
    ru = notification_selectors.render_body("amendment.withdrawn", locale="ru")
    assert "отозвано" in ru
    assert notification_selectors.render_subject("amendment.withdrawn", locale="en")


def test_closed_amendment_feed_item_points_to_contract(
    _l10n_packs, under_review_amendment: Amendment, customer: User, contractor: User
):
    services.reject_amendment(under_review_amendment, user=contractor)
    relay.deliver_due_events()
    resp = _client(customer).get("/v1/notifications")
    assert resp.status_code == 200, resp.content
    items = [i for i in resp.json()["items"] if i["type"] == "negotiation"]
    assert items
    # ADR-170: пункт закрытого допника ведёт не «в договор вообще», а во
    # вкладку «Допсоглашения» — туда, где виден его исход.
    assert items[0]["action"]["href"] == (
        f"/contracts/{under_review_amendment.contract_id}#amendments"
    )
