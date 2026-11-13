"""apps.contracts.services — Э4.2 (docs/tasks/etap-4.md): FSM согласования
(draft->under_review->терминалы) и протокол разногласий (RevisionProposal,
PreapprovedAlternative). Каждый переход и каждый запрет — отдельным тестом
(CLAUDE.md)."""

from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty, RevisionProposal
from apps.profiles.models import Profile
from common.fsm import InvalidTransitionError

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = RevisionProposal.Status


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-negotiation-{suffix}", phone=f"+7999086{suffix}")


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


@pytest.fixture
def contractor_profile(contractor: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )


@pytest.fixture
def draft_contract(customer: User, contractor_profile: Profile) -> Contract:
    return services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )


@pytest.fixture
def under_review_contract(draft_contract: Contract, customer: User) -> Contract:
    return services.send_for_review(draft_contract, user=customer)


# --- send: draft -> under_review --------------------------------------------


def test_send_by_customer_moves_to_under_review(draft_contract: Contract, customer: User):
    contract = services.send_for_review(draft_contract, user=customer)
    assert contract.negotiation_status == Contract.NegotiationStatus.UNDER_REVIEW


def test_send_by_contractor_also_allowed(draft_contract: Contract, contractor: User):
    """§6.1: «любая сторона» — не только инициатор-заказчик."""
    contract = services.send_for_review(draft_contract, user=contractor)
    assert contract.negotiation_status == Contract.NegotiationStatus.UNDER_REVIEW


def test_send_by_stranger_is_not_a_party(draft_contract: Contract):
    stranger = _user("0003")
    with pytest.raises(services.NotAPartyError):
        services.send_for_review(draft_contract, user=stranger)


def test_send_twice_is_invalid_transition(under_review_contract: Contract, customer: User):
    with pytest.raises(InvalidTransitionError):
        services.send_for_review(under_review_contract, user=customer)


# --- withdraw: under_review -> withdrawn_by_initiator -----------------------


def test_withdraw_by_initiator_succeeds(under_review_contract: Contract, customer: User):
    contract = services.withdraw_negotiation(under_review_contract, user=customer)
    assert contract.negotiation_status == Contract.NegotiationStatus.WITHDRAWN_BY_INITIATOR


def test_withdraw_by_counterparty_is_forbidden(under_review_contract: Contract, contractor: User):
    with pytest.raises(services.NotInitiatorError):
        services.withdraw_negotiation(under_review_contract, user=contractor)


def test_withdraw_from_draft_is_invalid_transition(draft_contract: Contract, customer: User):
    with pytest.raises(InvalidTransitionError):
        services.withdraw_negotiation(draft_contract, user=customer)


# --- reject: under_review -> rejected_by_counterparty ------------------------


def test_reject_by_counterparty_succeeds(under_review_contract: Contract, contractor: User):
    contract = services.reject_negotiation(under_review_contract, user=contractor)
    assert contract.negotiation_status == Contract.NegotiationStatus.REJECTED_BY_COUNTERPARTY


def test_reject_by_initiator_is_forbidden(under_review_contract: Contract, customer: User):
    with pytest.raises(services.NotCounterpartyError):
        services.reject_negotiation(under_review_contract, user=customer)


def test_reject_from_draft_is_invalid_transition(draft_contract: Contract, contractor: User):
    with pytest.raises(InvalidTransitionError):
        services.reject_negotiation(draft_contract, user=contractor)


# --- propose_revision --------------------------------------------------------


def test_propose_revision_creates_open_proposal(under_review_contract: Contract, customer: User):
    proposal = services.propose_revision(
        under_review_contract,
        user=customer,
        item_ref="title",
        new_value="Ремонт крана и труб",
        comment="добавили объём работ",
    )
    assert proposal.status == _STATUS.OPEN
    # ADR-123: «Было» для адресуемого item_ref берётся из договора.
    assert proposal.old_value == "Ремонт крана"
    assert proposal.new_value == "Ремонт крана и труб"
    assert proposal.proposed_by_id is not None


def test_propose_revision_on_draft_is_invalid_transition(draft_contract: Contract, customer: User):
    with pytest.raises(InvalidTransitionError):
        services.propose_revision(draft_contract, user=customer, item_ref="title", new_value="x")


def test_propose_revision_by_stranger_is_not_a_party(under_review_contract: Contract):
    stranger = _user("0004")
    with pytest.raises(services.NotAPartyError):
        services.propose_revision(
            under_review_contract, user=stranger, item_ref="title", new_value="x"
        )


# --- accept_revision ----------------------------------------------------------


def test_accept_revision_by_other_party_succeeds(
    under_review_contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Новое"
    )
    accepted = services.accept_revision(proposal, user=contractor)
    assert accepted.status == _STATUS.ACCEPTED
    assert accepted.decided_by_id is not None
    assert accepted.decided_at is not None


def test_accept_own_revision_is_forbidden(under_review_contract: Contract, customer: User):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Новое"
    )
    with pytest.raises(services.OwnProposalDecisionError):
        services.accept_revision(proposal, user=customer)


def test_accept_already_decided_revision_is_not_open(
    under_review_contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Новое"
    )
    services.accept_revision(proposal, user=contractor)
    with pytest.raises(services.RevisionProposalNotOpenError):
        services.accept_revision(proposal, user=contractor)


# --- reject_revision ------------------------------------------------------


def test_reject_revision_by_other_party_succeeds(
    under_review_contract: Contract, customer: User, contractor: User
):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Новое"
    )
    rejected = services.reject_revision(proposal, user=contractor)
    assert rejected.status == _STATUS.REJECTED


def test_reject_own_revision_is_forbidden(under_review_contract: Contract, customer: User):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Новое"
    )
    with pytest.raises(services.OwnProposalDecisionError):
        services.reject_revision(proposal, user=customer)


# --- counter_revision (встречная редакция) -----------------------------------


def test_counter_revision_supersedes_original_and_chains_old_value(
    under_review_contract: Contract, customer: User, contractor: User
):
    original = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Вариант А"
    )
    counter = services.counter_revision(
        original, user=contractor, new_value="Вариант Б", comment="предпочитаю так"
    )
    original.refresh_from_db()
    assert original.status == _STATUS.SUPERSEDED
    assert counter.status == _STATUS.OPEN
    assert counter.old_value == "Вариант А"
    assert counter.new_value == "Вариант Б"
    assert (
        counter.proposed_by_id
        == services.get_party_for_user(under_review_contract, contractor).profile_id
    )


def test_full_ping_pong_ends_with_accept(
    under_review_contract: Contract, customer: User, contractor: User
):
    """Приёмка Э4.2: полный пинг-понг правок двумя сторонами."""
    p1 = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="А"
    )
    p2 = services.counter_revision(p1, user=contractor, new_value="Б")
    p3 = services.counter_revision(p2, user=customer, new_value="В")
    final = services.accept_revision(p3, user=contractor)

    p1.refresh_from_db()
    p2.refresh_from_db()
    assert p1.status == _STATUS.SUPERSEDED
    assert p2.status == _STATUS.SUPERSEDED
    assert final.status == _STATUS.ACCEPTED
    assert final.new_value == "В"


def test_counter_own_revision_is_forbidden(under_review_contract: Contract, customer: User):
    proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="А"
    )
    with pytest.raises(services.OwnProposalDecisionError):
        services.counter_revision(proposal, user=customer, new_value="Б")


# --- accept_all_revisions -----------------------------------------------------


def test_accept_all_without_money_changes_succeeds_without_confirm_summary(
    under_review_contract: Contract, customer: User, contractor: User
):
    services.propose_revision(
        under_review_contract, user=contractor, item_ref="title", new_value="Новый заголовок"
    )
    accepted = services.accept_all_revisions(under_review_contract, user=customer)
    assert len(accepted) == 1
    assert accepted[0].status == _STATUS.ACCEPTED


def test_accept_all_with_money_change_requires_confirm_summary(
    under_review_contract: Contract, customer: User, contractor: User
):
    services.propose_revision(
        under_review_contract,
        user=contractor,
        item_ref="milestones[0].amount",
        new_value={"amount": "5000.00", "currency": "RUB"},
    )
    with pytest.raises(services.ConfirmSummaryRequiredError) as exc_info:
        services.accept_all_revisions(under_review_contract, user=customer)
    assert exc_info.value.summary[0]["item_ref"] == "milestones[0].amount"

    proposals = list(under_review_contract.revision_proposals.all())
    assert all(p.status == _STATUS.OPEN for p in proposals)


def test_accept_all_with_confirm_summary_applies_money_change(
    under_review_contract: Contract, customer: User, contractor: User
):
    services.propose_revision(
        under_review_contract,
        user=contractor,
        item_ref="milestones[0].amount",
        new_value={"amount": "5000.00", "currency": "RUB"},
    )
    accepted = services.accept_all_revisions(
        under_review_contract, user=customer, confirm_summary=True
    )
    assert len(accepted) == 1
    assert accepted[0].status == _STATUS.ACCEPTED


def test_accept_all_skips_own_open_proposals(
    under_review_contract: Contract, customer: User, contractor: User
):
    services.propose_revision(
        under_review_contract, user=customer, item_ref="title", new_value="Моё предложение"
    )
    accepted = services.accept_all_revisions(under_review_contract, user=customer)
    assert accepted == []
    own = under_review_contract.revision_proposals.get()
    assert own.status == _STATUS.OPEN


# --- preapproved alternatives --------------------------------------------


def test_apply_preapproved_alternative_creates_accepted_revision(
    under_review_contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        under_review_contract,
        user=customer,
        item_ref="payment_method",
        payload={"payment_method": "external"},
    )
    applied = services.apply_preapproved_alternative(alternative, user=contractor)
    assert applied.status == _STATUS.ACCEPTED
    assert applied.preapproved_alternative_of_id == alternative.id
    assert applied.new_value == {"payment_method": "external"}


def test_apply_preapproved_alternative_supersedes_open_proposal_on_same_item_ref(
    under_review_contract: Contract, customer: User, contractor: User
):
    open_proposal = services.propose_revision(
        under_review_contract, user=customer, item_ref="payment_method", new_value="cash"
    )
    alternative = services.create_preapproved_alternative(
        under_review_contract,
        user=customer,
        item_ref="payment_method",
        payload={"payment_method": "external"},
    )
    applied = services.apply_preapproved_alternative(alternative, user=contractor)

    open_proposal.refresh_from_db()
    assert open_proposal.status == _STATUS.SUPERSEDED
    assert applied.old_value == "cash"


def test_apply_preapproved_alternative_on_draft_is_invalid_transition(
    draft_contract: Contract, customer: User, contractor: User
):
    alternative = services.create_preapproved_alternative(
        draft_contract, user=customer, item_ref="title", payload={"title": "x"}
    )
    with pytest.raises(InvalidTransitionError):
        services.apply_preapproved_alternative(alternative, user=contractor)


def test_send_without_payment_method_rejected(customer: User, contractor_profile: Profile):
    """Отсмотр 2026-08-22: способ оплаты обязателен — фронт гейтит «Далее»,
    бэк дублирует инвариант на send (422 payment_method_required)."""
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        title="Без способа оплаты",
    )
    assert draft.payment_method is None
    with pytest.raises(services.PaymentMethodRequiredError):
        services.send_for_review(draft, user=customer)
    draft.refresh_from_db()
    assert draft.negotiation_status == "draft"


def test_send_without_payment_order_rejected(customer: User, contractor_profile: Profile):
    """ADR-151: порядок оплаты обязателен там, где применим (услуга/продажа/
    аренда) — 422 payment_order_required по образцу payment_method."""
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Без порядка оплаты",
    )
    assert draft.payment_order is None
    with pytest.raises(services.PaymentOrderRequiredError):
        services.send_for_review(draft, user=customer)
    draft.refresh_from_db()
    assert draft.negotiation_status == "draft"


def test_send_loan_without_payment_order_is_allowed(customer: User, contractor_profile: Profile):
    """ADR-151: для займа порядок оплаты неприменим — гейт не срабатывает."""
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
    )
    sent = services.send_for_review(draft, user=customer)
    assert sent.negotiation_status == "under_review"
    assert sent.payment_order is None
