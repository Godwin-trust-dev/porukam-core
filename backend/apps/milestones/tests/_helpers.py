"""Общие мелкие фабрики для тестов apps.milestones (не test_*.py — pytest не
собирает как тесты, pyproject.toml `python_files`)."""

from __future__ import annotations

from apps.accounts.models import User
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.profiles.models import Profile


def make_user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-milestones-{suffix}", phone=f"+7999086{suffix}")


def make_person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def make_contract(
    *, customer: User, contractor: User, contract_type_code: str = "services_individual", **kwargs
) -> Contract:
    contractor_profile = make_person_profile(contractor)
    # ADR-151: у займа порядок оплаты неприменим (лист-этап — сам денежный
    # транш), задать его не может даже фикстура — `create_draft` отвечает
    # `PaymentOrderNotApplicableError`.
    if contracts_services.payment_order_applicable(contract_type_code):
        kwargs.setdefault("payment_order", Contract.PaymentOrder.AFTER_ACCEPTANCE)
    return contracts_services.create_draft(
        user=customer,
        my_role=ContractParty.Role.CUSTOMER,
        contract_type_code=contract_type_code,
        counterparty_profile_id=contractor_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        **kwargs,
    )
