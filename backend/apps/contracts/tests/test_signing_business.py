"""ADR-096: business-подписание — SigningAuthority в контуре подписания.

Каждый запрет — отдельным тестом (CLAUDE.md): фильтр по лимиту суммы,
неактивное/истёкшее право, отозванная МЧД, перепроверка при подписи.
Person-путь не дублируется (test_signing*.py) — здесь только границы
business-ветки и след права в SignatureRequest/Signature."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.authority import services as authority_services
from apps.authority.models import SigningAuthority
from apps.authority.providers import FakePoaRegistryProvider
from apps.contracts import services
from apps.contracts.models import AmendmentChange, Contract, ContractParty
from apps.entities.models import BusinessEntity
from apps.milestones import services as milestones_services
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_BASIS = SigningAuthority.Basis


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-biz-sign-{suffix}", phone=f"+7999089{suffix}")


@pytest.fixture
def customer() -> User:
    user = _user("0001")
    Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=user, profile_visibility="link_and_deals"
    )
    return user


@pytest.fixture
def director() -> User:
    return _user("0002")


@pytest.fixture
def entity(director: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Подрядчик",
        created_by=director,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=director,
    )


def _frozen_business_contract(
    customer: User, director: User, entity: BusinessEntity, *, amount: str = "25000.00"
) -> Contract:
    """Заказчик-физлицо, исполнитель — юрлицо; дерево из одного листа
    `amount`, заморожен (единственное состояние, где реально маршрутизируется
    подпись)."""
    customer_profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=customer)
    contract = services.create_draft(
        user=director,
        my_role=_ROLE.CONTRACTOR,
        my_acting_as=ContractParty.ActingAs.BUSINESS,
        my_entity_id=entity.id,
        contract_type_code="services_business",
        counterparty_profile_id=customer_profile.id,
        payment_method=Contract.PaymentMethod.CASH,
        payment_order=Contract.PaymentOrder.AFTER_ACCEPTANCE,
        title="Разработка сайта",
    )
    services.send_for_review(contract, user=director)
    milestones_services.create_milestone(
        contract, user=director, title="Работа", amount=Decimal(amount), currency="RUB"
    )
    services.freeze_contract(contract, user=director)
    contract.refresh_from_db()
    return contract


def _authority(director: User, entity: BusinessEntity, **overrides) -> SigningAuthority:
    fields: dict = {
        "user": director,
        "business_entity": entity,
        "basis": _BASIS.REGISTRY_VERIFIED_DIRECTOR,
    }
    fields.update(overrides)
    return SigningAuthority.objects.create(**fields)


# --- list_signatories: business-ветка ----------------------------------------


def test_business_side_lists_valid_authority(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(director, entity)

    options = services.list_signatories(contract, side=_ROLE.CONTRACTOR)
    assert options == [
        {
            "user_id": director.id,
            "basis": _BASIS.REGISTRY_VERIFIED_DIRECTOR,
            "authority_id": authority.id,
        }
    ]


def test_business_side_without_authorities_is_empty(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    assert services.list_signatories(contract, side=_ROLE.CONTRACTOR) == []


def test_person_side_is_unchanged_by_business_branch(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity)
    assert services.list_signatories(contract, side=_ROLE.CUSTOMER) == [
        {"user_id": customer.id, "basis": "person"}
    ]


def test_authority_over_amount_limit_is_filtered_out(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity, amount="25000.00")
    _authority(director, entity, max_amount_value=Decimal("10000.00"), max_amount_currency="RUB")
    assert services.list_signatories(contract, side=_ROLE.CONTRACTOR) == []


def test_authority_at_exact_amount_limit_passes(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity, amount="25000.00")
    authority = _authority(
        director, entity, max_amount_value=Decimal("25000.00"), max_amount_currency="RUB"
    )
    options = services.list_signatories(contract, side=_ROLE.CONTRACTOR)
    assert [o["authority_id"] for o in options] == [authority.id]


def test_inactive_authority_is_filtered_out(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity, is_active=False)
    assert services.list_signatories(contract, side=_ROLE.CONTRACTOR) == []


def test_expired_authority_is_filtered_out(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity, expires_at=timezone.now() - timedelta(days=1))
    assert services.list_signatories(contract, side=_ROLE.CONTRACTOR) == []


def test_revoked_poa_is_filtered_out(customer, director, entity):
    """FakePoaRegistryProvider: префикс `revoked-` = отозвана по реестру
    (перепроверка МЧД-оснований при каждом обращении, domain-model.md §4)."""
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity, basis=_BASIS.NOTARIZED_POA, poa_registry_id="revoked-poa-1")
    assert services.list_signatories(contract, side=_ROLE.CONTRACTOR) == []


def test_active_poa_passes(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(
        director, entity, basis=_BASIS.NOTARIZED_POA, poa_registry_id="poa-active-1"
    )
    options = services.list_signatories(contract, side=_ROLE.CONTRACTOR)
    assert [o["authority_id"] for o in options] == [authority.id]


def test_strongest_basis_wins_per_user(customer, director, entity):
    """Два права одного пользователя -> один элемент, сильнейшее основание
    (реестровый директор сильнее ручной экспертизы)."""
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity, basis=_BASIS.MANUAL_REVIEW)
    strongest = _authority(director, entity, basis=_BASIS.REGISTRY_VERIFIED_DIRECTOR)

    options = services.list_signatories(contract, side=_ROLE.CONTRACTOR)
    assert len(options) == 1
    assert options[0]["authority_id"] == strongest.id
    assert options[0]["basis"] == _BASIS.REGISTRY_VERIFIED_DIRECTOR


# --- route_signatory / sign: фиксация и перепроверка права -------------------


def _route(contract: Contract, director: User) -> services.SignatureRequest:
    return services.route_signatory(
        contract,
        user=director,
        side=_ROLE.CONTRACTOR,
        version_id=contract.frozen_version_id,
        signatory_user_id=director.id,
    )


def test_route_records_authority_on_request(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(director, entity)

    request = _route(contract, director)
    assert request.signing_authority_id == authority.id


def test_route_person_side_leaves_authority_null(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    request = services.route_signatory(
        contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    assert request.signing_authority_id is None


def test_route_business_without_authority_is_not_eligible(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    with pytest.raises(services.SignatoryNotEligibleError):
        _route(contract, director)


def test_sign_writes_real_basis_and_authority_snapshot(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(director, entity, basis=_BASIS.NOTARIZED_POA, poa_registry_id="poa-7")

    request = _route(contract, director)
    signature = services.sign(
        request, user=director, version_hash=contract.frozen_version.integrity_hash
    )

    assert signature.signature_basis == _BASIS.NOTARIZED_POA
    assert signature.entity_snapshot["entity_id"] == str(entity.id)
    assert signature.entity_snapshot["signing_authority"] == {
        "id": str(authority.id),
        "basis": _BASIS.NOTARIZED_POA,
        "poa_registry_id": "poa-7",
    }


def test_sign_blocked_if_authority_revoked_after_routing(customer, director, entity):
    """Перепроверка ПРИ ПОДПИСИ (ADR-096): право отозвано между
    маршрутизацией и подписью -> 409 signing_authority_invalid."""
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(director, entity)
    request = _route(contract, director)

    authority.is_active = False
    authority.save(update_fields=["is_active"])

    with pytest.raises(authority_services.SigningAuthorityNoLongerValidError):
        services.sign(request, user=director, version_hash=contract.frozen_version.integrity_hash)


def test_sign_blocked_if_authority_expired_after_routing(customer, director, entity):
    contract = _frozen_business_contract(customer, director, entity)
    authority = _authority(director, entity)
    request = _route(contract, director)

    authority.expires_at = timezone.now() - timedelta(minutes=1)
    authority.save(update_fields=["expires_at"])

    with pytest.raises(authority_services.SigningAuthorityNoLongerValidError):
        services.sign(request, user=director, version_hash=contract.frozen_version.integrity_hash)


def test_assert_can_sign_rechecks_poa_registry():
    """МЧД отозвана по реестру ПОСЛЕ выдачи права — ловится инъекцией
    провайдера (тот же вход, что у is_valid_now)."""
    director = _user("0042")
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Отзыв",
        created_by=director,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=director,
    )
    authority = SigningAuthority.objects.create(
        user=director, business_entity=entity, basis=_BASIS.NOTARIZED_POA, poa_registry_id="poa-9"
    )
    revoking_provider = FakePoaRegistryProvider(revoked_ids=frozenset({"poa-9"}))
    with pytest.raises(authority_services.SigningAuthorityNoLongerValidError):
        authority_services.assert_can_sign(
            authority.id, amount=None, poa_provider=revoking_provider
        )


def test_full_business_signing_reaches_signed(customer, director, entity):
    """Полный путь: обе стороны маршрутизируют и подписывают — договор
    `signed`, у business-подписи настоящий basis, у person — "person"."""
    contract = _frozen_business_contract(customer, director, entity)
    _authority(director, entity)
    version_hash = contract.frozen_version.integrity_hash

    customer_request = services.route_signatory(
        contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    contract.refresh_from_db()
    director_request = _route(contract, director)

    person_signature = services.sign(customer_request, user=customer, version_hash=version_hash)
    contract.refresh_from_db()
    business_signature = services.sign(director_request, user=director, version_hash=version_hash)

    contract.refresh_from_db()
    assert contract.negotiation_status == "signed"
    assert person_signature.signature_basis == "person"
    assert business_signature.signature_basis == _BASIS.REGISTRY_VERIFIED_DIRECTOR


# --- допники: лимит по итоговой сумме с учётом дельты ------------------------


def _signed_business_contract(customer, director, entity, *, amount: str) -> Contract:
    contract = _frozen_business_contract(customer, director, entity, amount=amount)
    _authority(director, entity)  # безлимитное право для первичного подписания
    version_hash = contract.frozen_version.integrity_hash
    customer_request = services.route_signatory(
        contract,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=contract.frozen_version_id,
        signatory_user_id=customer.id,
    )
    contract.refresh_from_db()
    director_request = _route(contract, director)
    services.sign(customer_request, user=customer, version_hash=version_hash)
    contract.refresh_from_db()
    services.sign(director_request, user=director, version_hash=version_hash)
    contract.refresh_from_db()
    return contract


def test_amendment_limit_checked_against_total_with_delta(customer, director, entity):
    """Договор 10 000, право с лимитом 15 000 — договор подписан; допник
    +10 000 (итог 20 000) тем же правом не маршрутизируется (ADR-096:
    подписант авторизует НОВУЮ сумму)."""
    contract = _signed_business_contract(customer, director, entity, amount="10000.00")
    # заменяем безлимитное право сетапа на лимитированное
    SigningAuthority.objects.filter(business_entity=entity).update(is_active=False)
    _authority(director, entity, max_amount_value=Decimal("15000.00"), max_amount_currency="RUB")

    amendment = services.create_amendment(
        contract,
        user=director,
        reason="доп. работы",
        changes=[
            {
                "type": AmendmentChange.Type.ADD_MILESTONE,
                "payload": {"title": "Ещё работа", "amount": "10000.00", "currency": "RUB"},
            }
        ],
    )
    services.send_amendment_for_review(amendment, user=director)
    services.freeze_amendment(amendment, user=director)
    amendment.refresh_from_db()

    with pytest.raises(services.SignatoryNotEligibleError):
        services.route_amendment_signatory(
            amendment,
            user=director,
            side=_ROLE.CONTRACTOR,
            version_id=amendment.frozen_version_id,
            signatory_user_id=director.id,
        )
