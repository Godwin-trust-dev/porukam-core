"""Разделы /stages и /payments (отсмотр 2026-08-22) — селекторы
`get_stages`/`get_payments` + тонкий HTTP-слой. Кросс-договорная сводка
листьев: только договоры в исполнении (SIGNED), только листья
(domain-model.md §7.1), платёжное состояние — из двусторонних
подтверждений-заглушек (tech-spec.md §6.3, финмодель v2 — платёжного
контура нет)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from apps.contracts import services as contracts_services
from apps.contracts.tests._signing_helpers import (
    add_leaf_milestone,
    make_under_review_contract,
    route_both_sides,
    sign_both,
)
from apps.dashboards import selectors
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import (
    make_frozen_contract,
    make_signed_contract_with_leaf,
    make_user,
)
from apps.profiles.models import Profile
from apps.reputation.models import DealFact

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("sect-cst")


@pytest.fixture
def contractor():
    return make_user("sect-ctr")


# --- get_stages --------------------------------------------------------------


def test_stages_empty_without_contracts(customer):
    assert selectors.get_stages(customer) == {"items": []}


def test_stages_lists_leaf_of_signed_contract_for_both_sides(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)

    for user, side in ((customer, "customer"), (contractor, "contractor")):
        data = selectors.get_stages(user)
        assert [i["id"] for i in data["items"]] == [str(milestone.id)]
        item = data["items"][0]
        assert item["contract_id"] == str(contract.id)
        assert item["side"] == side
        assert item["status"] == "pending"
        assert item["amount"] == "10000.00"
        assert item["amount_currency"] == "RUB"
        assert item["counterparty"]["profile_id"]


def test_stages_ignores_unsigned_contract(customer, contractor):
    make_frozen_contract(customer=customer, contractor=contractor)
    assert selectors.get_stages(customer) == {"items": []}


def test_stages_status_follows_fsm(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    assert selectors.get_stages(customer)["items"][0]["status"] == "in_progress"

    milestones_services.submit_milestone(milestone, user=contractor)
    assert selectors.get_stages(customer)["items"][0]["status"] == "under_acceptance"


# --- get_payments ------------------------------------------------------------


def test_payments_empty_without_contracts(customer):
    assert selectors.get_payments(customer) == {"items": []}


def test_payments_upcoming_until_accepted(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    item = selectors.get_payments(customer)["items"][0]
    assert item["milestone_id"] == str(milestone.id)
    assert item["state"] == "upcoming"
    assert item["amount"] == "10000.00"
    assert item["paid_confirmed_by_me"] is False


def test_payments_awaiting_confirmation_after_acceptance(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestones_services.submit_milestone(milestone, user=contractor)
    milestones_services.accept_milestone(milestone, user=customer)

    item = selectors.get_payments(customer)["items"][0]
    assert item["state"] == "awaiting_confirmation"
    assert item["paid_confirmed_by_me"] is False
    assert item["paid_confirmed_by_counterparty"] is False


def test_payments_one_sided_confirmation_visible_to_both(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestones_services.submit_milestone(milestone, user=contractor)
    milestones_services.accept_milestone(milestone, user=customer)
    milestones_services.confirm_payment(milestone, user=customer, side="customer")

    customer_item = selectors.get_payments(customer)["items"][0]
    assert customer_item["state"] == "awaiting_confirmation"
    assert customer_item["paid_confirmed_by_me"] is True
    assert customer_item["paid_confirmed_by_counterparty"] is False

    contractor_item = selectors.get_payments(contractor)["items"][0]
    assert contractor_item["paid_confirmed_by_me"] is False
    assert contractor_item["paid_confirmed_by_counterparty"] is True


def test_payments_paid_after_both_confirmations(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestones_services.submit_milestone(milestone, user=contractor)
    milestones_services.accept_milestone(milestone, user=customer)
    milestones_services.confirm_payment(milestone, user=customer, side="customer")
    milestones_services.confirm_payment(milestone, user=contractor, side="contractor")

    item = selectors.get_payments(customer)["items"][0]
    assert item["state"] == "paid"
    assert item["paid_confirmed_by_me"] is True
    assert item["paid_confirmed_by_counterparty"] is True


# --- HTTP-слой ---------------------------------------------------------------


def test_stages_and_payments_require_authentication():
    client = APIClient()
    assert client.get("/v1/dashboard/stages").status_code == 401
    assert client.get("/v1/dashboard/payments").status_code == 401


def test_stages_and_payments_http_shape(customer, contractor):
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    client = APIClient()
    client.force_authenticate(user=customer)

    resp = client.get("/v1/dashboard/stages")
    assert resp.status_code == 200, resp.content
    assert resp.data["items"][0]["contract_id"] == str(contract.id)
    assert resp.data["items"][0]["amount"] == "10000.00"

    resp = client.get("/v1/dashboard/payments")
    assert resp.status_code == 200, resp.content
    assert resp.data["items"][0]["state"] == "upcoming"


# --- Фото контрагента в строках разделов (ADR-173) ---------------------------


def _viewer(user, profile_id=None):
    """Зритель для `avatar_url_for_request`: из DRF-request тот берёт ровно
    пару «пользователь + acting_profile_id» (ActingProfileMiddleware)."""
    return SimpleNamespace(user=user, acting_profile_id=profile_id)


def _counterparty_profile(user) -> Profile:
    return Profile.objects.filter(owner_user=user, kind=Profile.Kind.PERSON).get()


def test_sections_counterparty_carries_public_avatar(customer, contractor):
    """Владелец 08.09: фото контрагента напротив договора — и в разделах."""
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    profile = _counterparty_profile(contractor)
    profile.avatar_key = "avatars/ctr/0198aa00"
    profile.avatar_visibility = Profile.AvatarVisibility.PUBLIC
    profile.save(update_fields=["avatar_key", "avatar_visibility"])

    request = _viewer(customer)
    stage = selectors.get_stages(customer, request)["items"][0]
    payment = selectors.get_payments(customer, request)["items"][0]
    for block in (stage["counterparty"], payment["counterparty"]):
        assert block["avatar_url"] is not None
        assert str(profile.id) in block["avatar_url"]
        # public — ссылка без подписи (ADR-103), <img> откроет её как есть.
        assert "&t=" not in block["avatar_url"]


def test_sections_counterparty_avatar_null_without_photo(customer, contractor):
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    item = selectors.get_payments(customer, _viewer(customer))["items"][0]
    assert item["counterparty"]["avatar_url"] is None


def test_sections_deals_only_avatar_needs_completed_deal(customer, contractor):
    """deals_only (ADR-103): чужому — null, контрагенту завершённой сделки —
    подписанная ссылка. Раздел не имеет права быть щелью в этой видимости."""
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    profile = _counterparty_profile(contractor)
    profile.avatar_key = "avatars/ctr/0198aa01"
    profile.avatar_visibility = Profile.AvatarVisibility.DEALS_ONLY
    profile.save(update_fields=["avatar_key", "avatar_visibility"])
    viewer_profile = _counterparty_profile(customer)

    request = _viewer(customer, viewer_profile.id)
    item = selectors.get_payments(customer, request)["items"][0]
    assert item["counterparty"]["avatar_url"] is None

    DealFact.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000d1",
        customer_profile_id=viewer_profile.id,
        contractor_profile_id=profile.id,
        is_completed=True,
        completed_at=timezone.now(),
    )
    item = selectors.get_payments(customer, request)["items"][0]
    assert item["counterparty"]["avatar_url"] is not None
    assert "&t=" in item["counterparty"]["avatar_url"]


def test_sections_avatars_cost_no_extra_queries(customer, contractor):
    """N+1: профили контрагентов приходят батчем `list_contracts_by_ids` —
    появление фото у обеих строк не добавляет разделу ни одного запроса."""
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    second = make_user("sect-ctr2")
    make_signed_contract_with_leaf(customer=customer, contractor=second)
    request = _viewer(customer)
    with CaptureQueriesContext(connection) as without_photos:
        assert len(selectors.get_payments(customer, request)["items"]) == 2

    for user, key in ((contractor, "avatars/a/0198aa02"), (second, "avatars/b/0198aa03")):
        profile = _counterparty_profile(user)
        profile.avatar_key = key
        profile.avatar_visibility = Profile.AvatarVisibility.PUBLIC
        profile.save(update_fields=["avatar_key", "avatar_visibility"])

    with CaptureQueriesContext(connection) as with_photos:
        items = selectors.get_payments(customer, request)["items"]
    assert all(item["counterparty"]["avatar_url"] for item in items)
    assert len(with_photos.captured_queries) == len(without_photos.captured_queries)


def test_deals_only_avatar_resolved_once_per_counterparty(customer, contractor):
    """Один контрагент в нескольких строках раздела — ОДНА проверка права:
    у deals_only она ходит в apps.reputation за завершённой сделкой."""
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    for _ in range(2):
        add_leaf_milestone(contract, user=customer)
    contracts_services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    customer_request, contractor_request = route_both_sides(
        contract, customer=customer, contractor=contractor, version_id=contract.frozen_version_id
    )
    assert contract.frozen_version is not None
    sign_both(
        contract,
        customer=customer,
        contractor=contractor,
        customer_request=customer_request,
        contractor_request=contractor_request,
        version_hash=contract.frozen_version.integrity_hash,
    )
    profile = _counterparty_profile(contractor)
    profile.avatar_key = "avatars/ctr/0198aa04"
    profile.avatar_visibility = Profile.AvatarVisibility.DEALS_ONLY
    profile.save(update_fields=["avatar_key", "avatar_visibility"])

    request = _viewer(customer, _counterparty_profile(customer).id)
    with CaptureQueriesContext(connection) as queries:
        items = selectors.get_payments(customer, request)["items"]
    assert len(items) == 2
    deal_checks = [q for q in queries.captured_queries if "reputation_deal_fact" in q["sql"]]
    assert len(deal_checks) == 1
