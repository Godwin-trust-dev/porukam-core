"""apps.disputes.api — tech-spec.md §8.8 (ADR-131). Коды ошибок из спеки
проверяются дословно (`fix_rounds_exhausted`)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from apps.disputes import services
from apps.disputes.models import Dispute, DisputeWindow
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.profiles.models import Profile

from ._helpers import open_milestone_dispute

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ANTI_WAIVER = "Скидка закрывает только указанный дефект"


@pytest.fixture
def customer():
    return make_user("a001")


@pytest.fixture
def contractor():
    return make_user("a002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_list_disputes_returns_counterparty(dispute, customer, contractor):
    """Находка отсмотра 25.08: раздел «Споры» брал вторую сторону из кэша
    `GET /contracts`. Теперь она в самом сериализаторе."""
    resp = _client(customer).get("/v1/disputes")
    assert resp.status_code == 200, resp.content
    row = resp.json()[0]
    assert row["id"] == str(dispute.id)
    assert row["contract_id"] == str(dispute.contract_id)
    assert row["counterparty"]["profile_id"]
    assert row["counterparty"]["role"] == "contractor"
    assert row["days_to_cap"] == 29
    assert row["fix_rounds_left"] == 2


def test_counterparty_is_relative_to_reader(dispute, contractor):
    resp = _client(contractor).get("/v1/disputes")
    assert resp.json()[0]["counterparty"]["role"] == "customer"


def test_counterparty_carries_avatar_respecting_visibility(dispute, customer, contractor):
    """ADR-173 (владелец 08.09): фото контрагента и в разделе «Споры».
    Видимость — та же, что в карточке профиля (ADR-103): public видно всем,
    deals_only — только контрагенту завершённой сделки."""
    profile = Profile.objects.filter(owner_user=contractor, kind=Profile.Kind.PERSON).get()
    assert _client(customer).get("/v1/disputes").json()[0]["counterparty"]["avatar_url"] is None

    profile.avatar_key = "avatars/ctr/0198bb00"
    profile.avatar_visibility = Profile.AvatarVisibility.PUBLIC
    profile.save(update_fields=["avatar_key", "avatar_visibility"])
    row = _client(customer).get("/v1/disputes").json()[0]
    assert str(profile.id) in row["counterparty"]["avatar_url"]

    profile.avatar_visibility = Profile.AvatarVisibility.DEALS_ONLY
    profile.save(update_fields=["avatar_visibility"])
    row = _client(customer).get("/v1/disputes").json()[0]
    assert row["counterparty"]["avatar_url"] is None


def test_detail_for_outsider_is_403(dispute):
    outsider = make_user("a009")
    resp = _client(outsider).get(f"/v1/disputes/{dispute.id}")
    assert resp.status_code == 403
    assert resp.json()["code"] == "permission_denied"


def test_fix_request_flow_and_third_round_conflict(dispute, customer, contractor):
    customer_client = _client(customer)
    contractor_client = _client(contractor)
    for _round in (1, 2):
        resp = customer_client.post(
            f"/v1/disputes/{dispute.id}/fix-requests", {"comment": "переделать"}, format="json"
        )
        assert resp.status_code == 201, resp.content
        fix_request_id = resp.json()["id"]
        resp = contractor_client.post(
            f"/v1/disputes/{dispute.id}/fix-requests/{fix_request_id}/resubmit",
            {"comment": "сделано"},
            format="json",
        )
        assert resp.status_code == 200, resp.content

    resp = customer_client.post(
        f"/v1/disputes/{dispute.id}/fix-requests", {"comment": "ещё раз"}, format="json"
    )
    assert resp.status_code == 409
    # Код из tech-spec.md §8.8 дословно.
    assert resp.json()["code"] == "fix_rounds_exhausted"


def test_fix_request_by_contractor_is_403(dispute, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/fix-requests", {"comment": ""}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "wrong_dispute_side"


def test_respond_endpoint_contests_window(dispute, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/respond", {"comment": "не согласен"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    window = dispute.windows.get()
    assert window.contested is True


def test_dispute_detail_returns_replies(dispute, customer, contractor):
    """Хвост волны 4: текст ответа стороны виден на карточке спора обеим
    сторонам — `replies[{author_id, comment, evidence, created_at}]`."""
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/respond",
        {"comment": "не согласен", "evidence": ["photo-ok.jpg"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    replies = resp.json()["replies"]
    assert len(replies) == 1
    assert replies[0]["author_id"] == str(contractor.id)
    assert replies[0]["comment"] == "не согласен"
    assert replies[0]["evidence"] == ["photo-ok.jpg"]
    assert replies[0]["created_at"]

    detail = _client(customer).get(f"/v1/disputes/{dispute.id}").json()
    assert detail["replies"][0]["comment"] == "не согласен"
    listed = _client(customer).get("/v1/disputes").json()
    assert listed[0]["replies"][0]["id"] == replies[0]["id"]


def test_respond_by_opener_is_403(dispute, customer):
    resp = _client(customer).post(
        f"/v1/disputes/{dispute.id}/respond", {"comment": "сам себе"}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "not_dispute_counterparty"


def test_discount_proposal_and_decline(dispute, customer, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/discount-proposal",
        {
            "new_amount": "8500.00",
            "currency": "RUB",
            "anti_waiver_note": _ANTI_WAIVER,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    # Суммы — строкой (CLAUDE.md), валюта рядом.
    assert body["new_amount"] == "8500.00"
    assert body["new_amount_currency"] == "RUB"
    # Вход в общий контур подписания §8.6.
    assert body["amendment_id"]

    resp = _client(customer).post(
        f"/v1/disputes/{dispute.id}/discount-proposals/{body['id']}/decline", {}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "declined"
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN


def test_discount_above_amount_is_422(dispute, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/discount-proposal",
        {"new_amount": "99999.00", "currency": "RUB", "anti_waiver_note": _ANTI_WAIVER},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "discount_not_applicable"


def test_resolve_endpoint_closes_dispute(dispute, contractor):
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/resolve", {"resolution_type": "accepted"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "resolved"
    assert resp.json()["outcome"] == "resolved"

    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/resolve", {"resolution_type": "accepted"}, format="json"
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "dispute_already_resolved"


def test_resolve_with_system_only_outcome_is_400(dispute, contractor):
    """`cap_reached` — исход СВИПА, кнопкой его не поставить."""
    resp = _client(contractor).post(
        f"/v1/disputes/{dispute.id}/resolve", {"resolution_type": "cap_reached"}, format="json"
    )
    assert resp.status_code == 400


def test_dispute_windows_list(dispute, contractor):
    resp = _client(contractor).get("/v1/dispute-windows")
    assert resp.status_code == 200, resp.content
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["kind"] == DisputeWindow.Kind.DISPUTE_RESPONSE
    assert rows[0]["deadline_at"] is not None
    assert rows[0]["contested"] is None


def test_dispute_windows_list_hides_closed_by_default(dispute, contractor):
    services.respond_to_dispute(dispute, user=contractor, comment="", evidence=[])
    assert _client(contractor).get("/v1/dispute-windows").json() == []
    assert len(_client(contractor).get("/v1/dispute-windows?active=false").json()) == 1


def test_contest_window_endpoint(dispute, contractor):
    window = dispute.windows.get()
    resp = _client(contractor).post(
        f"/v1/dispute-windows/{window.id}/contest", {"comment": "возражаю"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["contested"] is True


def test_contest_window_by_outsider_is_403(dispute):
    outsider = make_user("a010")
    window = dispute.windows.get()
    resp = _client(outsider).post(f"/v1/dispute-windows/{window.id}/contest", {}, format="json")
    assert resp.status_code == 403


def test_anonymous_is_401(dispute):
    assert APIClient().get("/v1/disputes").status_code == 401


def test_propose_discount_service_and_api_agree_on_amount(dispute, contractor):
    """Сервис и API должны считать одно и то же: DecimalField сериализатора
    не должен превращать сумму в float по дороге."""
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("7777.77"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    resp = _client(contractor).get(f"/v1/disputes/{dispute.id}")
    assert resp.json()["discount_agreements"][0]["new_amount"] == "7777.77"
    assert agreement.new_amount == Decimal("7777.77")
