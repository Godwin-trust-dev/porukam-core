"""Общие мелкие фабрики для тестов Э4.4 (не test_*.py — pytest не собирает
как тесты, pyproject.toml `python_files`). Тот же приём, что
apps/milestones/tests/_helpers.py."""

from __future__ import annotations

from decimal import Decimal

from apps.accounts.models import User
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty, SignatureRequest
from apps.milestones import services as milestones_services
from apps.profiles.models import Profile


def make_user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-signing-{suffix}", phone=f"+7999087{suffix}")


def make_person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def make_under_review_contract(*, customer: User, contractor: User) -> Contract:
    """free_c2c «Услуга» между двумя физлицами — сценарий приёмки Э4.4
    (etap-4.md): черновик -> отправка на согласование."""
    contractor_profile = make_person_profile(contractor)
    draft = contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Ремонт крана",
    )
    return contracts_services.send_for_review(draft, user=customer)


def add_leaf_milestone(contract: Contract, *, user: User, amount: str = "10000.00") -> None:
    milestones_services.create_milestone(
        contract, user=user, title="Работа", amount=Decimal(amount), currency="RUB"
    )


def make_frozen_contract(*, customer: User, contractor: User) -> Contract:
    """under_review -> pending_signature, вернуть договор (свежий из БД —
    freeze_contract пишет frozen_version/negotiation_status на объекте,
    возвращает ContractVersion, не Contract)."""
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer)
    contracts_services.freeze_contract(contract, user=customer)
    contract.refresh_from_db()
    return contract


def route_both_sides(contract: Contract, *, customer: User, contractor: User, version_id):
    customer_request = contracts_services.route_signatory(
        contract,
        user=customer,
        side=ContractParty.Role.CUSTOMER,
        version_id=version_id,
        signatory_user_id=customer.id,
    )
    contractor_request = contracts_services.route_signatory(
        contract,
        user=contractor,
        side=ContractParty.Role.CONTRACTOR,
        version_id=version_id,
        signatory_user_id=contractor.id,
    )
    return customer_request, contractor_request


def sign_both(
    contract: Contract,
    *,
    customer: User,
    contractor: User,
    customer_request: SignatureRequest,
    contractor_request: SignatureRequest,
    version_hash: str,
):
    contracts_services.sign(customer_request, user=customer, version_hash=version_hash)
    return contracts_services.sign(contractor_request, user=contractor, version_hash=version_hash)


def make_signed_contract(*, customer: User, contractor: User) -> Contract:
    """under_review -> ... -> signed (Э4.4 полностью пройден) — стартовая
    точка для тестов Э4.5 (допник заводится только к подписанному
    договору)."""
    contract = make_frozen_contract(customer=customer, contractor=contractor)
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
    contract.refresh_from_db()
    return contract
