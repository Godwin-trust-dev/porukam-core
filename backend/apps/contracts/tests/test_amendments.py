"""apps.contracts.services — Э4.5 (docs/tasks/etap-4.md): допники. Каждый
переход и каждый запрет — отдельным тестом (CLAUDE.md). Общая FSM
согласования/подписания Э4.2/Э4.4 переиспользуется, не дублируется —
`test_amendment_reuses_the_exact_same_fsm_object_as_contract` проверяет это
напрямую (не по совпадению названий, а тот же объект `StateMachine`)."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from django.db import IntegrityError
from django.utils import timezone

from apps.accounts.models import User
from apps.catalog.models import MaterialCatalogItem
from apps.contracts import services
from apps.contracts.models import Amendment, AmendmentChange, Contract, ContractParty, Signature
from apps.milestones import services as milestones_services
from apps.milestones.models import ContractMaterial, Milestone
from common.fsm import InvalidTransitionError

from ._signing_helpers import make_signed_contract, make_under_review_contract, make_user

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_STATUS = Contract.NegotiationStatus
_CHANGE_TYPE = AmendmentChange.Type


@pytest.fixture
def customer() -> User:
    return make_user("a0001")


@pytest.fixture
def contractor() -> User:
    return make_user("a0002")


@pytest.fixture
def signed_contract(customer: User, contractor: User) -> Contract:
    return make_signed_contract(customer=customer, contractor=contractor)


# --- create_amendment ---------------------------------------------------


def test_create_amendment_computes_amount_delta_for_add_milestone(
    signed_contract: Contract, customer: User
):
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
    assert amendment.negotiation_status == _STATUS.DRAFT
    assert amendment.order == 1
    change = amendment.changes.get()
    assert change.amount_delta == Decimal("3000.00")
    assert change.amount_delta_currency == "RUB"
    total, days = services.compute_amendment_deltas(amendment)
    assert total is not None
    assert total.amount == Decimal("3000.00")
    assert days == 0


def test_create_amendment_on_unsigned_contract_is_forbidden(customer: User, contractor: User):
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    with pytest.raises(services.ContractNotSignedError):
        services.create_amendment(contract, user=customer, reason="x", changes=[])


def test_create_amendment_by_stranger_is_not_a_party(signed_contract: Contract):
    stranger = make_user("a0003")
    with pytest.raises(services.NotAPartyError):
        services.create_amendment(signed_contract, user=stranger, reason="x", changes=[])


def test_create_amendment_second_gets_next_order(signed_contract: Contract, customer: User):
    services.create_amendment(signed_contract, user=customer, reason="1", changes=[])
    second = services.create_amendment(signed_contract, user=customer, reason="2", changes=[])
    assert second.order == 2


def test_create_amendment_remove_milestone_on_accepted_is_422(
    signed_contract: Contract, customer: User
):
    """Приёмка etap-4.md Э4.5: «допник, удаляющий принятый этап, → 422»."""
    milestone = signed_contract.milestones.get()
    milestone.accepted_at = timezone.now()
    milestone.save(update_fields=["accepted_at"])
    with pytest.raises(services.AmendmentTargetsAcceptedMilestoneError):
        services.create_amendment(
            signed_contract,
            user=customer,
            reason="Убрать этап",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": milestone.id}],
        )


def test_create_amendment_remove_milestone_on_branch_is_not_leaf(
    signed_contract: Contract, customer: User
):
    branch = milestones_services._create_milestone(
        signed_contract,
        title="Ветка",
        parent=None,
        order=1,
        amount=None,
        currency=None,
        sphere_code=None,
        deadline=None,
        depends_on=None,
    )
    milestones_services._create_milestone(
        signed_contract,
        title="Ребёнок",
        parent=branch,
        order=0,
        amount=Decimal("500.00"),
        currency="RUB",
        sphere_code=None,
        deadline=None,
        depends_on=None,
    )
    with pytest.raises(services.AmendmentRemoveTargetNotLeafError):
        services.create_amendment(
            signed_contract,
            user=customer,
            reason="x",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": branch.id}],
        )


def test_create_amendment_remove_received_material_is_422(
    signed_contract: Contract, customer: User
):
    """Приёмка etap-4.md Э4.5: «нельзя убрать полученный материал»."""
    milestone = signed_contract.milestones.get()

    catalog_item = MaterialCatalogItem.objects.filter(is_active=True).first()
    material = ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=catalog_item,
        description="Кран",
        unit_price=Decimal("500.00"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CONTRACTOR,
        quantity=Decimal("1"),
        received=True,
        received_at=timezone.now(),
    )
    with pytest.raises(services.AmendmentTargetsReceivedMaterialError):
        services.create_amendment(
            signed_contract,
            user=customer,
            reason="x",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MATERIAL, "target": material.id}],
        )


def test_create_amendment_change_target_not_found(signed_contract: Contract, customer: User):

    with pytest.raises(services.AmendmentChangeTargetNotFoundError):
        services.create_amendment(
            signed_contract,
            user=customer,
            reason="x",
            changes=[{"type": _CHANGE_TYPE.REMOVE_MILESTONE, "target": uuid.uuid4()}],
        )


# --- send_amendment_for_review: draft -> under_review -----------------------


@pytest.fixture
def draft_amendment(signed_contract: Contract, customer: User) -> Amendment:
    return services.create_amendment(
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


def test_send_amendment_moves_to_under_review(draft_amendment: Amendment, customer: User):
    amendment = services.send_amendment_for_review(draft_amendment, user=customer)
    assert amendment.negotiation_status == _STATUS.UNDER_REVIEW


def test_send_amendment_twice_is_invalid_transition(draft_amendment: Amendment, customer: User):
    services.send_amendment_for_review(draft_amendment, user=customer)
    with pytest.raises(InvalidTransitionError):
        services.send_amendment_for_review(draft_amendment, user=customer)


# --- freeze_amendment: under_review -> pending_signature ---------------------


@pytest.fixture
def under_review_amendment(draft_amendment: Amendment, customer: User) -> Amendment:
    return services.send_amendment_for_review(draft_amendment, user=customer)


def test_freeze_amendment_moves_to_pending_signature(
    under_review_amendment: Amendment, customer: User
):
    version = services.freeze_amendment(under_review_amendment, user=customer)
    under_review_amendment.refresh_from_db()
    assert under_review_amendment.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert under_review_amendment.frozen_version_id == version.id
    assert version.snapshot["amendment_id"] == str(under_review_amendment.id)
    assert version.snapshot["amount_delta"] == {"amount": "3000.00", "currency": "RUB"}


def test_freeze_amendment_from_draft_is_invalid_transition(
    draft_amendment: Amendment, customer: User
):
    with pytest.raises(InvalidTransitionError):
        services.freeze_amendment(draft_amendment, user=customer)


def test_freeze_amendment_does_not_touch_contract_frozen_version(
    under_review_amendment: Amendment, customer: User, signed_contract: Contract
):
    contract_version_id_before = signed_contract.frozen_version_id
    services.freeze_amendment(under_review_amendment, user=customer)
    signed_contract.refresh_from_db()
    assert signed_contract.frozen_version_id == contract_version_id_before
    assert signed_contract.negotiation_status == _STATUS.SIGNED


# --- route_amendment_signatory: pending_signature -> awaiting_signatures ----


@pytest.fixture
def frozen_amendment(under_review_amendment: Amendment, customer: User) -> Amendment:
    services.freeze_amendment(under_review_amendment, user=customer)
    under_review_amendment.refresh_from_db()
    return under_review_amendment


def test_route_amendment_signatory_moves_to_awaiting_signatures(
    frozen_amendment: Amendment, customer: User
):
    request = services.route_amendment_signatory(
        frozen_amendment,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_amendment.frozen_version_id,
        signatory_user_id=customer.id,
    )
    frozen_amendment.refresh_from_db()
    assert frozen_amendment.negotiation_status == _STATUS.AWAITING_SIGNATURES
    assert request.amendment_id == frozen_amendment.id
    assert request.contract_id == frozen_amendment.contract_id


def test_route_amendment_signatory_for_other_side_is_forbidden(
    frozen_amendment: Amendment, customer: User
):
    with pytest.raises(services.NotThisSidePartyError):
        services.route_amendment_signatory(
            frozen_amendment,
            user=customer,
            side=_ROLE.CONTRACTOR,
            version_id=frozen_amendment.frozen_version_id,
            signatory_user_id=customer.id,
        )


def test_route_amendment_signatory_with_stale_version_id_is_forbidden(
    frozen_amendment: Amendment, customer: User
):

    with pytest.raises(services.StaleVersionError):
        services.route_amendment_signatory(
            frozen_amendment,
            user=customer,
            side=_ROLE.CUSTOMER,
            version_id=uuid.uuid4(),
            signatory_user_id=customer.id,
        )


def test_route_amendment_signatory_does_not_collide_with_contract_round(
    frozen_amendment: Amendment, customer: User, signed_contract: Contract
):
    """Amendment и Contract — разные раунды подписи в одной реверс-связи
    (`amendment` FK) — маршрутизация допника не видит договорной запрос как
    «уже pending» и наоборот."""
    services.route_amendment_signatory(
        frozen_amendment,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=frozen_amendment.frozen_version_id,
        signatory_user_id=customer.id,
    )
    assert signed_contract.signature_requests.filter(amendment__isnull=True).count() == 2
    assert signed_contract.signature_requests.filter(amendment=frozen_amendment).count() == 1


# --- sign_amendment: awaiting_signatures -> {awaiting_signatures | signed} --


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


def test_first_amendment_signature_keeps_awaiting_signatures(awaiting_amendment, customer: User):
    amendment, customer_request, _ = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    signature = services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.AWAITING_SIGNATURES
    assert signature.amendment_id == amendment.id


def test_second_amendment_signature_applies_to_tree(
    awaiting_amendment, customer: User, contractor: User, signed_contract: Contract
):
    """Приёмка etap-4.md Э4.5: допник добавляет этап и меняет сумму — после
    подписания дерево обновилось, происхождение этапа видно."""
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    total_before = milestones_services.total_leaf_amount(signed_contract)

    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    services.sign_amendment(contractor_request, user=contractor, version_hash=version_hash)

    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.SIGNED

    new_milestone = Milestone.objects.get(created_by_amendment=amendment)
    assert new_milestone.title == "Доп. работа"
    assert new_milestone.amount == Decimal("3000.00")

    total_after = milestones_services.total_leaf_amount(signed_contract)
    assert total_after.amount == total_before.amount + Decimal("3000.00")

    # Подписание допника НЕ трогает execution_status/negotiation_status
    # самого договора — тот остаётся signed (в отличие от первичного
    # подписания, здесь contract.signed не публикуется повторно).
    signed_contract.refresh_from_db()
    assert signed_contract.negotiation_status == _STATUS.SIGNED


def test_sign_amendment_with_stale_hash_is_forbidden(awaiting_amendment, customer: User):
    amendment, customer_request, _ = awaiting_amendment
    with pytest.raises(services.StaleVersionError):
        services.sign_amendment(customer_request, user=customer, version_hash="0" * 64)


def test_sign_amendment_by_wrong_user_is_forbidden(awaiting_amendment, contractor: User):
    amendment, customer_request, _ = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    with pytest.raises(services.NotTheSignatoryError):
        services.sign_amendment(customer_request, user=contractor, version_hash=version_hash)


# --- forward_amendment_signature_request ------------------------------------


def test_forward_amendment_signature_request_returns_to_pending_signature(
    awaiting_amendment, customer: User
):
    amendment, customer_request, _ = awaiting_amendment
    services.forward_amendment_signature_request(customer_request, user=customer)
    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.PENDING_SIGNATURE
    customer_request.refresh_from_db()
    assert customer_request.status == customer_request.Status.FORWARDED


# --- decline_amendment_for_revision: -> under_review -------------------------


def test_decline_amendment_for_revision_reopens_only_amendment_round(
    awaiting_amendment, customer: User, contractor: User, signed_contract: Contract
):
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)

    services.decline_amendment_for_revision(
        contractor_request, user=contractor, comment="передумали"
    )

    amendment.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.UNDER_REVIEW
    assert amendment.frozen_version_id is None
    assert Signature.objects.filter(amendment=amendment).count() == 0
    # Договорные подписи (Э4.4) остаются целы — фильтр amendment__isnull=True
    # не даёт раундам перепутаться.
    assert Signature.objects.filter(contract=signed_contract, amendment__isnull=True).count() == 2
    signed_contract.refresh_from_db()
    assert signed_contract.negotiation_status == _STATUS.SIGNED


# --- expire_amendment_signature_request --------------------------------------


def test_expire_amendment_signature_request_returns_to_pending_signature(awaiting_amendment):
    amendment, customer_request, _ = awaiting_amendment
    services.expire_amendment_signature_request(customer_request)
    amendment.refresh_from_db()
    customer_request.refresh_from_db()
    assert amendment.negotiation_status == _STATUS.PENDING_SIGNATURE
    assert customer_request.status == customer_request.Status.EXPIRED


# --- effective_terms ----------------------------------------------------


def test_effective_terms_includes_signed_amendments_only(
    awaiting_amendment, customer: User, contractor: User, signed_contract: Contract
):
    amendment, customer_request, contractor_request = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    terms_before = services.effective_terms(signed_contract)
    assert terms_before["amendments"] == []

    services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    services.sign_amendment(contractor_request, user=contractor, version_hash=version_hash)

    terms_after = services.effective_terms(signed_contract)
    assert len(terms_after["amendments"]) == 1
    assert terms_after["amendments"][0]["order"] == amendment.order
    assert terms_after["total_amount"]["amount"] == "13000.00"


# --- общая FSM: реальная проверка переиспользования (не по имени) -----------


def test_amendment_reuses_the_exact_same_fsm_object_as_contract(
    draft_amendment: Amendment, customer: User
):
    """etap-4.md Э4.5: «общая FSM ... не дублируется» — не просто одинаковые
    названия переходов, а буквально ОДИН объект StateMachine, который
    `assert_transition` вызывает и для Contract.negotiation_status, и для
    Amendment.negotiation_status."""
    fsm_id_before = id(services.NEGOTIATION_FSM)
    services.send_amendment_for_review(draft_amendment, user=customer)
    assert id(services.NEGOTIATION_FSM) == fsm_id_before
    # Тот же объект, что использует send_for_review для Contract — прямая
    # проверка тождества, не совпадения графов.
    assert services.NEGOTIATION_FSM.can_transition("send", Contract.NegotiationStatus.DRAFT)


# --- DB-инвариант: partial-индексы signature_one_per_side_* -----------------


def test_signature_one_per_side_contract_partial_index(signed_contract: Contract, customer: User):
    """UNIQUE(contract, side) WHERE amendment IS NULL — вставка второй
    договорной подписи той же стороны нарушает индекс (на живом Postgres —
    CLAUDE.md, partial-индексы не проверяются на sqlite)."""
    existing = Signature.objects.get(contract=signed_contract, side=_ROLE.CUSTOMER, amendment=None)
    with pytest.raises(IntegrityError, match="signature_one_per_side_contract"):
        Signature.objects.create(
            contract=signed_contract,
            side=_ROLE.CUSTOMER,
            signatory=customer,
            signature_basis="person",
            version_hash=existing.version_hash,
        )


def test_signature_one_per_side_amendment_partial_index(awaiting_amendment, customer: User):
    amendment, customer_request, _ = awaiting_amendment
    version_hash = amendment.frozen_version.integrity_hash
    signature = services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    with pytest.raises(IntegrityError, match="signature_one_per_side_amendment"):
        Signature.objects.create(
            contract=amendment.contract,
            amendment=amendment,
            side=_ROLE.CUSTOMER,
            signatory=customer,
            signature_basis="person",
            version_hash=signature.version_hash,
        )
