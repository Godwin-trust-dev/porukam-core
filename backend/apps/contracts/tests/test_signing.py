"""apps.contracts.services — Э4.4 (docs/tasks/etap-4.md): заморозка и
подписание. Каждый переход и каждый запрет — отдельным тестом (CLAUDE.md)."""

from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.contracts import services
from apps.contracts.models import Contract, ContractParty, ContractVersion, Signature
from apps.milestones import services as milestones_services
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

from ._signing_helpers import (
    add_leaf_milestone,
    make_frozen_contract,
    make_person_profile,
    make_signed_contract,
    make_under_review_contract,
    make_user,
    route_both_sides,
    sign_both,
)

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = Contract.NegotiationStatus


@pytest.fixture
def customer() -> User:
    return make_user("f0001")


@pytest.fixture
def contractor() -> User:
    return make_user("f0002")


@pytest.fixture
def under_review_contract(customer: User, contractor: User) -> Contract:
    return make_under_review_contract(customer=customer, contractor=contractor)


# --- freeze: under_review -> pending_signature -------------------------------


def test_freeze_moves_to_pending_signature_and_creates_version(
    under_review_contract: Contract, customer: User
):
    add_leaf_milestone(under_review_contract, user=customer)
    version = services.freeze_contract(under_review_contract, user=customer)
    under_review_contract.refresh_from_db()
    assert under_review_contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert under_review_contract.frozen_version_id == version.id
    assert len(version.integrity_hash) == 64
    assert version.snapshot["contract_id"] == str(under_review_contract.id)


def test_freeze_by_contractor_also_allowed(under_review_contract: Contract, contractor: User):
    add_leaf_milestone(under_review_contract, user=contractor)
    version = services.freeze_contract(under_review_contract, user=contractor)
    assert version.contract_id == under_review_contract.id


def test_freeze_from_draft_is_invalid_transition(customer: User, contractor: User):
    draft = make_under_review_contract(customer=customer, contractor=contractor)
    draft.negotiation_status = _STATUS.DRAFT
    draft.save(update_fields=["negotiation_status"])
    with pytest.raises(InvalidTransitionError):
        services.freeze_contract(draft, user=customer)


def test_freeze_twice_is_invalid_transition(under_review_contract: Contract, customer: User):
    add_leaf_milestone(under_review_contract, user=customer)
    services.freeze_contract(under_review_contract, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.freeze_contract(under_review_contract, user=customer)


def test_freeze_with_open_revision_is_forbidden(under_review_contract: Contract, customer: User):
    add_leaf_milestone(under_review_contract, user=customer)
    services.propose_revision(under_review_contract, user=customer, item_ref="title", new_value="x")
    with pytest.raises(services.OpenRevisionsError):
        services.freeze_contract(under_review_contract, user=customer)


def test_freeze_with_empty_tree_is_forbidden(under_review_contract: Contract, customer: User):
    with pytest.raises(services.EmptyMilestoneTreeError):
        services.freeze_contract(under_review_contract, user=customer)


def test_freeze_by_stranger_is_not_a_party(under_review_contract: Contract):
    stranger = make_user("f0003")
    with pytest.raises(services.NotAPartyError):
        services.freeze_contract(under_review_contract, user=stranger)


def test_freeze_with_platform_payment_and_no_requisites_is_forbidden(
    customer: User, contractor: User
):
    contractor_profile_owner = contractor
    draft = make_under_review_contract(customer=customer, contractor=contractor_profile_owner)
    draft.payment_method = Contract.PaymentMethod.DIRECT_PLATFORM
    draft.save(update_fields=["payment_method"])
    add_leaf_milestone(draft, user=customer)
    with pytest.raises(services.RequisitesMissingError):
        services.freeze_contract(draft, user=customer)


def test_freeze_with_cash_payment_ignores_requisites(
    under_review_contract: Contract, customer: User
):
    """redaction v2 (etap-4.md): гейт НЕ «для платных сегментов», а для
    расчётов через платформу — cash его не задевает."""
    add_leaf_milestone(under_review_contract, user=customer)
    version = services.freeze_contract(under_review_contract, user=customer)
    assert version is not None


def test_refreeze_after_no_op_reopen_reuses_same_version(
    under_review_contract: Contract, customer: User, contractor: User
):
    """Повторная заморозка БЕЗ изменений после decline_for_revision -> тот
    же canonical-хеш -> переиспользуем версию, не пытаемся создать дубликат
    (UNIQUE (contract, integrity_hash))."""
    add_leaf_milestone(under_review_contract, user=customer)
    version1 = services.freeze_contract(under_review_contract, user=customer)
    request, _ = route_both_sides(
        under_review_contract, customer=customer, contractor=contractor, version_id=version1.id
    )
    services.decline_for_revision(request, user=customer, comment="передумал")
    under_review_contract.refresh_from_db()
    version2 = services.freeze_contract(under_review_contract, user=customer)
    assert version1.id == version2.id
    assert ContractVersion.objects.filter(contract=under_review_contract).count() == 1


# --- route_signatory: pending_signature -> awaiting_signatures --------------


@pytest.fixture
def frozen_contract(customer: User, contractor: User) -> Contract:
    return make_frozen_contract(customer=customer, contractor=contractor)


def test_route_first_side_moves_to_awaiting_signatures(frozen_contract: Contract, customer: User):
    request = services.route_signatory(
        frozen_contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    frozen_contract.refresh_from_db()
    assert frozen_contract.negotiation_status == _STATUS.AWAITING_SIGNATURES
    assert request.status == request.Status.PENDING
    assert request.expires_at is not None


def test_route_second_side_stays_awaiting_signatures(
    frozen_contract: Contract, customer: User, contractor: User
):
    services.route_signatory(
        frozen_contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    frozen_contract.refresh_from_db()
    services.route_signatory(
        frozen_contract,
        user=contractor,
        side=_ROLE.CONTRACTOR,
        version_id=frozen_contract.frozen_version_id,
        signatory_user_id=contractor.id,
    )
    frozen_contract.refresh_from_db()
    assert frozen_contract.negotiation_status == _STATUS.AWAITING_SIGNATURES


def test_route_from_draft_is_invalid_transition(customer: User, contractor: User):
    draft = make_under_review_contract(customer=customer, contractor=contractor)
    draft.negotiation_status = _STATUS.DRAFT
    draft.save(update_fields=["negotiation_status"])
    with pytest.raises(InvalidTransitionError):
        services.route_signatory(
            draft,
            user=customer,
            side=_ROLE.CUSTOMER,
            version_id=None,
            signatory_user_id=customer.id,
        )


def test_route_for_other_side_is_forbidden(frozen_contract: Contract, customer: User):
    with pytest.raises(services.NotThisSidePartyError):
        services.route_signatory(
            frozen_contract,
            user=customer,
            side=_ROLE.CONTRACTOR,
            version_id=frozen_contract.frozen_version_id,
            signatory_user_id=customer.id,
        )


def test_route_with_stale_version_id_is_forbidden(frozen_contract: Contract, customer: User):
    with pytest.raises(services.StaleVersionError):
        services.route_signatory(
            frozen_contract,
            user=customer,
            side=_ROLE.CUSTOMER,
            version_id=frozen_contract.frozen_version_id.__class__(int=0),
            signatory_user_id=customer.id,
        )


def test_route_twice_for_same_side_is_forbidden(frozen_contract: Contract, customer: User):
    services.route_signatory(
        frozen_contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    with pytest.raises(services.SignatureRequestAlreadyPendingError):
        services.route_signatory(
            frozen_contract,
            user=customer,
            side=_ROLE.CUSTOMER,
            version_id=frozen_contract.frozen_version_id,
            signatory_user_id=customer.id,
        )


def test_route_with_ineligible_signatory_is_forbidden(
    frozen_contract: Contract, customer: User, contractor: User
):
    with pytest.raises(services.SignatoryNotEligibleError):
        services.route_signatory(
            frozen_contract,
            user=customer,
            side=_ROLE.CUSTOMER,
            version_id=frozen_contract.frozen_version_id,
            signatory_user_id=contractor.id,
        )


# --- sign: awaiting_signatures -> {awaiting_signatures | signed} -----------


@pytest.fixture
def awaiting_contract(frozen_contract: Contract, customer: User, contractor: User):
    customer_request, contractor_request = route_both_sides(
        frozen_contract,
        customer=customer,
        contractor=contractor,
        version_id=frozen_contract.frozen_version_id,
    )
    frozen_contract.refresh_from_db()
    return frozen_contract, customer_request, contractor_request


def test_first_signature_keeps_awaiting_signatures(awaiting_contract, customer: User):
    contract, customer_request, _ = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    signature = services.sign(customer_request, user=customer, version_hash=version_hash)
    contract.refresh_from_db()
    assert contract.negotiation_status == _STATUS.AWAITING_SIGNATURES
    assert signature.side == _ROLE.CUSTOMER


def test_second_signature_completes_to_signed(awaiting_contract, customer: User, contractor: User):
    contract, customer_request, contractor_request = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    sign_both(
        contract,
        customer=customer,
        contractor=contractor,
        customer_request=customer_request,
        contractor_request=contractor_request,
        version_hash=version_hash,
    )
    contract.refresh_from_db()
    assert contract.negotiation_status == _STATUS.SIGNED
    assert contract.execution_status == "pending_start"
    assert Signature.objects.filter(contract=contract).count() == 2


def test_sign_with_stale_hash_is_forbidden(awaiting_contract, customer: User):
    contract, customer_request, _ = awaiting_contract
    with pytest.raises(services.StaleVersionError):
        services.sign(customer_request, user=customer, version_hash="0" * 64)


def test_sign_by_wrong_user_is_forbidden(awaiting_contract, contractor: User):
    contract, customer_request, _ = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    with pytest.raises(services.NotTheSignatoryError):
        services.sign(customer_request, user=contractor, version_hash=version_hash)


def test_sign_already_signed_request_is_forbidden(awaiting_contract, customer: User):
    contract, customer_request, _ = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    services.sign(customer_request, user=customer, version_hash=version_hash)
    with pytest.raises(services.SignatureRequestNotPendingError):
        services.sign(customer_request, user=customer, version_hash=version_hash)


# --- forward: awaiting_signatures -> pending_signature ----------------------


def test_forward_returns_to_pending_signature(awaiting_contract, customer: User):
    contract, customer_request, _ = awaiting_contract
    services.forward_signature_request(customer_request, user=customer, comment="передал коллеге")
    contract.refresh_from_db()
    assert contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    customer_request.refresh_from_db()
    assert customer_request.status == customer_request.Status.FORWARDED


def test_forward_by_non_signatory_is_forbidden(awaiting_contract, contractor: User):
    _, customer_request, _ = awaiting_contract
    with pytest.raises(services.NotTheSignatoryError):
        services.forward_signature_request(customer_request, user=contractor)


# --- decline_for_revision: awaiting_signatures -> under_review -------------


def test_decline_for_revision_reopens_and_annuls_signatures(
    awaiting_contract, customer: User, contractor: User
):
    contract, customer_request, contractor_request = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    services.sign(customer_request, user=customer, version_hash=version_hash)

    services.decline_for_revision(
        contractor_request, user=contractor, comment="не согласен с суммой"
    )

    contract.refresh_from_db()
    assert contract.negotiation_status == _STATUS.UNDER_REVIEW
    assert contract.frozen_version_id is None
    assert Signature.objects.filter(contract=contract).count() == 0
    assert not contract.signature_requests.filter(status="pending").exists()
    # ContractVersion — append-only история, НЕ удаляется.
    assert ContractVersion.objects.filter(contract=contract).exists()


def test_decline_for_revision_from_pending_signature_is_invalid_transition(
    frozen_contract: Contract, customer: User, contractor: User
):
    """decline_for_revision адресуется SignatureRequest — до его создания
    (ещё pending_signature) действовать нечем; это подтверждает, что
    единственный путь reopen — через реальный запрос подписи."""
    request = services.route_signatory(
        frozen_contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    services.forward_signature_request(request, user=customer)
    frozen_contract.refresh_from_db()
    assert frozen_contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    with pytest.raises(services.SignatureRequestNotPendingError):
        services.decline_for_revision(request, user=customer, comment="x")


def test_decline_for_revision_by_non_signatory_is_forbidden(awaiting_contract, contractor: User):
    _, customer_request, _ = awaiting_contract
    with pytest.raises(services.NotTheSignatoryError):
        services.decline_for_revision(customer_request, user=contractor, comment="x")


# --- ADR-124: return_for_revision / reject / withdraw из заморозки ----------


def _assert_round_annulled(contract: Contract) -> None:
    """Общие последствия выхода из заморозки (`_annul_signing_round`):
    pending-запросов нет, подписи раунда удалены, `frozen_version` снят,
    ContractVersion — append-only, остаётся."""
    contract.refresh_from_db()
    assert contract.frozen_version_id is None
    assert Signature.objects.filter(contract=contract).count() == 0
    assert not contract.signature_requests.filter(status="pending").exists()
    assert ContractVersion.objects.filter(contract=contract).exists()


def _last_event(contract: Contract, topic: str) -> OutboxEvent:
    return OutboxEvent.objects.filter(topic=topic, subject__id=str(contract.id)).latest(
        "occurred_at"
    )


def test_return_for_revision_from_pending_signature_reopens(
    frozen_contract: Contract, contractor: User
):
    """pending_signature -> under_review — контрагент, БЕЗ запроса подписи
    (в отличие от decline_for_revision)."""
    services.return_for_revision(frozen_contract, user=contractor, comment="поправьте срок")
    assert frozen_contract.negotiation_status == _STATUS.UNDER_REVIEW
    _assert_round_annulled(frozen_contract)
    event = _last_event(frozen_contract, "negotiation.reopened")
    assert event.payload["reason"] == "returned_for_revision"
    assert event.payload["comment"] == "поправьте срок"
    assert event.payload["annulled_signature_request_ids"] == []
    assert event.payload["annulled_signature_ids"] == []


def test_return_for_revision_from_awaiting_signatures_annuls_requests_and_signatures(
    awaiting_contract, customer: User, contractor: User
):
    """awaiting_signatures -> under_review: инициатор, чья подпись уже
    стоит, возвращает договор — обе заявки аннулированы, его подпись
    удалена, id попадают в событие."""
    contract, customer_request, contractor_request = awaiting_contract
    signature = services.sign(
        customer_request, user=customer, version_hash=contract.frozen_version.integrity_hash
    )
    services.return_for_revision(contract, user=customer, comment="передумал по сумме")
    assert contract.negotiation_status == _STATUS.UNDER_REVIEW
    _assert_round_annulled(contract)
    contractor_request.refresh_from_db()
    assert contractor_request.status == contractor_request.Status.DECLINED_FOR_REVISION
    event = _last_event(contract, "negotiation.reopened")
    assert event.payload["reason"] == "returned_for_revision"
    assert event.payload["annulled_signature_request_ids"] == [str(contractor_request.id)]
    assert event.payload["annulled_signature_ids"] == [str(signature.id)]


def test_return_for_revision_from_draft_is_invalid_transition(customer: User, contractor: User):
    contractor_profile = make_person_profile(contractor)
    draft = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        title="Черновик",
    )
    with pytest.raises(InvalidTransitionError):
        services.return_for_revision(draft, user=customer, comment="x")


def test_return_for_revision_from_under_review_is_invalid_transition(
    under_review_contract: Contract, customer: User
):
    with pytest.raises(InvalidTransitionError):
        services.return_for_revision(under_review_contract, user=customer, comment="x")


def test_return_for_revision_from_signed_is_invalid_transition(customer: User, contractor: User):
    """Подписанный договор неизменяем — вернуть на доработку нельзя."""
    signed = make_signed_contract(customer=customer, contractor=contractor)
    with pytest.raises(InvalidTransitionError):
        services.return_for_revision(signed, user=customer, comment="x")
    signed.refresh_from_db()
    assert signed.negotiation_status == _STATUS.SIGNED
    assert signed.frozen_version_id is not None


def test_return_for_revision_by_stranger_is_not_a_party(frozen_contract: Contract):
    stranger = make_user("f0009")
    with pytest.raises(services.NotAPartyError):
        services.return_for_revision(frozen_contract, user=stranger, comment="x")


def test_reject_from_pending_signature_terminates_and_annuls_round(
    frozen_contract: Contract, contractor: User
):
    services.reject_negotiation(frozen_contract, user=contractor)
    assert frozen_contract.negotiation_status == _STATUS.REJECTED_BY_COUNTERPARTY
    _assert_round_annulled(frozen_contract)
    event = _last_event(frozen_contract, "negotiation.rejected")
    assert event.payload["annulled_signature_request_ids"] == []


def test_reject_from_awaiting_signatures_annuls_requests_and_signatures(
    awaiting_contract, customer: User, contractor: User
):
    contract, customer_request, contractor_request = awaiting_contract
    signature = services.sign(
        customer_request, user=customer, version_hash=contract.frozen_version.integrity_hash
    )
    services.reject_negotiation(contract, user=contractor)
    assert contract.negotiation_status == _STATUS.REJECTED_BY_COUNTERPARTY
    _assert_round_annulled(contract)
    event = _last_event(contract, "negotiation.rejected")
    assert event.payload["annulled_signature_request_ids"] == [str(contractor_request.id)]
    assert event.payload["annulled_signature_ids"] == [str(signature.id)]


def test_reject_from_frozen_by_initiator_is_forbidden(frozen_contract: Contract, customer: User):
    with pytest.raises(services.NotCounterpartyError):
        services.reject_negotiation(frozen_contract, user=customer)
    frozen_contract.refresh_from_db()
    assert frozen_contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert frozen_contract.frozen_version_id is not None


def test_withdraw_from_pending_signature_terminates_and_annuls_round(
    frozen_contract: Contract, customer: User
):
    services.withdraw_negotiation(frozen_contract, user=customer)
    assert frozen_contract.negotiation_status == _STATUS.WITHDRAWN_BY_INITIATOR
    _assert_round_annulled(frozen_contract)
    event = _last_event(frozen_contract, "negotiation.withdrawn")
    assert event.payload["annulled_signature_ids"] == []


def test_withdraw_from_awaiting_signatures_annuls_requests_and_signatures(
    awaiting_contract, customer: User, contractor: User
):
    contract, customer_request, contractor_request = awaiting_contract
    signature = services.sign(
        contractor_request, user=contractor, version_hash=contract.frozen_version.integrity_hash
    )
    services.withdraw_negotiation(contract, user=customer)
    assert contract.negotiation_status == _STATUS.WITHDRAWN_BY_INITIATOR
    _assert_round_annulled(contract)
    event = _last_event(contract, "negotiation.withdrawn")
    assert event.payload["annulled_signature_request_ids"] == [str(customer_request.id)]
    assert event.payload["annulled_signature_ids"] == [str(signature.id)]


def test_withdraw_from_frozen_by_counterparty_is_forbidden(
    frozen_contract: Contract, contractor: User
):
    with pytest.raises(services.NotInitiatorError):
        services.withdraw_negotiation(frozen_contract, user=contractor)
    frozen_contract.refresh_from_db()
    assert frozen_contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert frozen_contract.frozen_version_id is not None


def test_decline_for_revision_still_works_after_return_for_revision_added(
    awaiting_contract, contractor: User
):
    """Старый жест подписанта (по запросу) не сломан общим хелпером:
    reason у события остаётся `declined_for_revision`."""
    contract, _customer_request, contractor_request = awaiting_contract
    services.decline_for_revision(contractor_request, user=contractor, comment="по запросу")
    assert contract.negotiation_status == _STATUS.UNDER_REVIEW
    _assert_round_annulled(contract)
    event = _last_event(contract, "negotiation.reopened")
    assert event.payload["reason"] == "declined_for_revision"


# --- expire_signature_request: awaiting_signatures -> pending_signature ----


def test_expire_pending_request_returns_to_pending_signature(awaiting_contract):
    contract, customer_request, _ = awaiting_contract
    services.expire_signature_request(customer_request)
    contract.refresh_from_db()
    customer_request.refresh_from_db()
    assert contract.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert customer_request.status == customer_request.Status.EXPIRED


def test_expire_already_signed_request_is_a_no_op(awaiting_contract, customer: User):
    contract, customer_request, _ = awaiting_contract
    version_hash = contract.frozen_version.integrity_hash
    services.sign(customer_request, user=customer, version_hash=version_hash)
    services.expire_signature_request(customer_request)
    contract.refresh_from_db()
    customer_request.refresh_from_db()
    assert contract.negotiation_status == _STATUS.AWAITING_SIGNATURES
    assert customer_request.status == customer_request.Status.SIGNED


# --- Amendment-FSM parity (Э4.5 — сеам) -------------------------------------


def test_negotiation_fsm_transition_table_is_the_shared_amendment_contract():
    """tech-spec.md §6.1: «Contract и Amendment — общая FSM». Amendment
    (Э4.5, apps/contracts/tests/test_amendments.py) действительно проведена
    через ЭТОТ ЖЕ объект `NEGOTIATION_FSM` — см.
    `test_amendment_reuses_the_exact_same_fsm_object_as_contract`. Этот тест
    фиксирует ТОЧНЫЙ набор переходов графа: регрессия здесь означает, что
    кто-то расщепил машину или тайно изменил граф, на который опирается
    и Contract, и Amendment одновременно."""
    expected = {
        ("send", "draft"),
        ("revise", "under_review"),
        ("withdraw", "under_review"),
        ("reject", "under_review"),
        ("freeze", "under_review"),
        ("route_signatory", "pending_signature"),
        ("route_signatory", "awaiting_signatures"),
        ("sign", "awaiting_signatures"),
        ("complete_signing", "awaiting_signatures"),
        ("forward_signature_request", "awaiting_signatures"),
        ("expire_signature_request", "awaiting_signatures"),
        ("decline_for_revision", "awaiting_signatures"),
        # ADR-124: выход из заморозки любой стороной / терминалы из заморозки.
        ("return_for_revision", "pending_signature"),
        ("return_for_revision", "awaiting_signatures"),
        ("reject", "pending_signature"),
        ("reject", "awaiting_signatures"),
        ("withdraw", "pending_signature"),
        ("withdraw", "awaiting_signatures"),
    }
    actual = set(services.NEGOTIATION_FSM._by_name_and_source.keys())
    assert actual == expected


def test_total_leaf_amount_matches_snapshot_total(frozen_contract: Contract):
    """Санити-проверка: total_amount в snapshot действительно берётся из
    milestones.total_leaf_amount (не константа/опечатка)."""
    total = milestones_services.total_leaf_amount(frozen_contract)
    version = frozen_contract.frozen_version
    assert version.snapshot["total_amount"] == {
        "amount": str(total.amount),
        "currency": total.currency,
    }


def test_snapshot_contains_payment_order(under_review_contract: Contract, customer: User):
    """ADR-151: порядок оплаты — условие договора под integrity_hash."""
    add_leaf_milestone(under_review_contract, user=customer)
    version = services.freeze_contract(under_review_contract, user=customer)
    assert version.snapshot["payment_order"] == "after_acceptance"
    assert version.snapshot["payment_method"] == "cash"
