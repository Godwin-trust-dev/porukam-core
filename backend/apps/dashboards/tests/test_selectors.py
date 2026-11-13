"""apps.dashboards.selectors — ADR-090: минимальный дашборд запуска, ТОЛЬКО
«что требует моего действия» (`attention`). «Мои сделки» на экране — не
здесь, переиспользование уже реального `GET /v1/contracts` на фронте
(ADR-090 §1) — за пределами apps.dashboards, тут нечего тестировать.
Каждый пункт секции `attention` — отдельным тестом (CLAUDE.md: каждый
переход/запрет — отдельно; здесь три «перехода» дашборда —
signature/acceptance/submission)."""

from __future__ import annotations

import pytest

from apps.contracts.tests._signing_helpers import make_frozen_contract, make_user, route_both_sides
from apps.dashboards import selectors
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("dash-cst")


@pytest.fixture
def contractor():
    return make_user("dash-ctr")


def test_empty_dashboard_for_user_without_contracts(customer):
    assert selectors.get_dashboard(customer) == {"attention": []}


def test_signature_attention_for_pending_signatory_both_sides(customer, contractor):
    contract = make_frozen_contract(customer=customer, contractor=contractor)
    route_both_sides(
        contract, customer=customer, contractor=contractor, version_id=contract.frozen_version_id
    )

    customer_data = selectors.get_dashboard(customer)
    contractor_data = selectors.get_dashboard(contractor)

    assert [i["kind"] for i in customer_data["attention"]] == ["signature"]
    assert customer_data["attention"][0]["contract_id"] == str(contract.id)
    assert customer_data["attention"][0]["side"] == "customer"
    assert [i["kind"] for i in contractor_data["attention"]] == ["signature"]
    assert contractor_data["attention"][0]["side"] == "contractor"


def test_submission_attention_only_for_contractor_of_in_progress_leaf(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)

    contractor_data = selectors.get_dashboard(contractor)
    customer_data = selectors.get_dashboard(customer)

    assert [i["kind"] for i in contractor_data["attention"]] == ["submission"]
    assert contractor_data["attention"][0]["id"] == f"submission:{milestone.id}"
    assert contractor_data["attention"][0]["contract_id"] == str(contract.id)
    assert contractor_data["attention"][0]["side"] == "contractor"
    assert customer_data["attention"] == []


def test_acceptance_attention_only_for_customer_of_under_acceptance_leaf(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestones_services.submit_milestone(milestone, user=contractor)

    customer_data = selectors.get_dashboard(customer)
    contractor_data = selectors.get_dashboard(contractor)

    assert [i["kind"] for i in customer_data["attention"]] == ["acceptance"]
    assert customer_data["attention"][0]["id"] == f"acceptance:{milestone.id}"
    assert customer_data["attention"][0]["side"] == "customer"
    assert contractor_data["attention"] == []


def test_accepted_leaf_clears_attention(customer, contractor):
    _contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestones_services.submit_milestone(milestone, user=contractor)
    milestones_services.accept_milestone(milestone, user=customer)

    assert selectors.get_dashboard(customer)["attention"] == []
    assert selectors.get_dashboard(contractor)["attention"] == []


def test_stranger_not_a_party_sees_nothing(customer, contractor):
    """Cross-cutting выборки (`SignatureRequest.signatory=user`,
    `Milestone` по `owned_profile_ids`) уже скоупят на владельца по
    построению — фиксируем это явным тестом (не «наверное сработает»)."""
    make_frozen_contract(customer=customer, contractor=contractor)
    stranger = make_user("dash-stranger")

    assert selectors.get_dashboard(stranger) == {"attention": []}
