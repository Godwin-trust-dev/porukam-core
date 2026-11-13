from __future__ import annotations

import pytest

from apps.accounts.models import User
from apps.authority import services
from apps.authority.models import ContractAssignment, Representative, SigningAuthority
from apps.authority.providers import FakePoaRegistryProvider
from apps.entities import services as entities_services
from apps.entities.models import BusinessEntity
from apps.entities.providers import FakeEntityRegistryProvider
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider
from common.money import Money

pytestmark = pytest.mark.django_db

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )
    user.refresh_from_db()


@pytest.fixture
def director() -> User:
    return User.objects.create(trust_id="trust-authority-svc-director", phone="+79990910001")


@pytest.fixture
def stranger() -> User:
    return User.objects.create(trust_id="trust-authority-svc-stranger", phone="+79990910002")


@pytest.fixture
def claimed_llc(director: User) -> BusinessEntity:
    """ru_ooo — has_separated_ownership() = True, claim'нута верным директором."""
    _verify(
        director,
        full_name="Иван Петрович Директоров",
        tax_id=FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
    )
    entity = entities_services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=director,
        provider=_registry,
    )
    entity.refresh_from_db()
    assert entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    return entity


@pytest.fixture
def claimed_sole_proprietor(director: User) -> BusinessEntity:
    """ru_ip — has_separated_ownership() = False (claim через ИНН физлица,
    personal_tax_id_hash проставляется самой _verify/complete_verification)."""
    _verify(
        director,
        full_name="Пётр Сергеевич Кузнецов",
        tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
    )
    entity = entities_services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=director,
        provider=_registry,
    )
    entity.refresh_from_db()
    assert entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    return entity


# --- grant_representative ---------------------------------------------------


def test_grant_first_representative_needs_no_permission(
    director: User, claimed_llc: BusinessEntity
):
    rep = services.grant_representative(
        claimed_llc, director, director, role=Representative.Role.ADMINISTRATOR
    )
    assert rep.is_active
    assert Representative.Permission.MANAGE_REPRESENTATIVES in rep.permissions


def test_grant_second_representative_requires_manage_representatives_permission(
    director: User, stranger: User, claimed_llc: BusinessEntity
):
    services.grant_representative(
        claimed_llc, director, director, role=Representative.Role.ADMINISTRATOR
    )
    third = User.objects.create(trust_id="trust-authority-svc-third", phone="+79990910003")

    with pytest.raises(services.RepresentativePermissionDeniedError):
        services.grant_representative(claimed_llc, stranger, third, role=Representative.Role.MEMBER)


def test_role_preset_fills_default_permissions(director: User, claimed_llc: BusinessEntity):
    rep = services.grant_representative(
        claimed_llc, director, director, role=Representative.Role.MEMBER
    )
    assert set(rep.permissions) == {
        Representative.Permission.COMMUNICATE,
        Representative.Permission.UPLOAD_EVIDENCE,
    }


def test_grant_representative_requires_operable_entity(director: User):
    unclaimed = BusinessEntity.objects.create(
        country_of_registration="RU", local_form_code="ru_ooo", name="Чужое", created_by=director
    )
    with pytest.raises(entities_services.EntityNotOperableError):
        services.grant_representative(
            unclaimed, director, director, role=Representative.Role.MEMBER
        )


# --- grant_signing_authority (ADR-004) --------------------------------------


def test_manual_review_forbidden_for_separated_ownership_form(
    director: User, claimed_llc: BusinessEntity
):
    with pytest.raises(services.ManualReviewNotAllowedForSeparatedOwnershipError):
        services.grant_signing_authority(
            claimed_llc, director, director, basis=SigningAuthority.Basis.MANUAL_REVIEW
        )


def test_manual_review_allowed_for_sole_proprietor(
    director: User, claimed_sole_proprietor: BusinessEntity
):
    authority = services.grant_signing_authority(
        claimed_sole_proprietor, director, director, basis=SigningAuthority.Basis.MANUAL_REVIEW
    )
    assert authority.is_active


def test_registry_verified_director_requires_name_match(
    director: User, stranger: User, claimed_llc: BusinessEntity
):
    with pytest.raises(services.DirectorMismatchError):
        services.grant_signing_authority(
            claimed_llc, director, stranger, basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR
        )


def test_registry_verified_director_succeeds_for_matching_director(
    director: User, claimed_llc: BusinessEntity
):
    authority = services.grant_signing_authority(
        claimed_llc, director, director, basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR
    )
    assert authority.basis == SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR


def test_grant_signing_authority_stores_money_pair(director: User, claimed_llc: BusinessEntity):
    authority = services.grant_signing_authority(
        claimed_llc,
        director,
        director,
        basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR,
        max_amount=Money("50000.00", "RUB"),
    )
    assert authority.max_amount_value == 50000
    assert authority.max_amount_currency == "RUB"


def test_can_sign_amount_validates_against_limit(director: User, claimed_llc: BusinessEntity):
    authority = services.grant_signing_authority(
        claimed_llc,
        director,
        director,
        basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR,
        max_amount=Money("50000.00", "RUB"),
    )
    assert services.can_sign_amount(authority, Money("50000.00", "RUB")) is True
    assert services.can_sign_amount(authority, Money("50000.01", "RUB")) is False


def test_can_sign_amount_unlimited_without_max_amount(director: User, claimed_llc: BusinessEntity):
    authority = services.grant_signing_authority(
        claimed_llc, director, director, basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR
    )
    assert services.can_sign_amount(authority, Money("999999999.00", "RUB")) is True


def test_revoke_signing_authority_deactivates(director: User, claimed_llc: BusinessEntity):
    authority = services.grant_signing_authority(
        claimed_llc, director, director, basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR
    )
    services.revoke_signing_authority(authority, director)
    authority.refresh_from_db()
    assert authority.is_active is False


# --- is_valid_now (МЧД) ------------------------------------------------------


def test_is_valid_now_checks_poa_registry_for_notarized_basis(
    director: User, claimed_llc: BusinessEntity
):
    authority = SigningAuthority.objects.create(
        user=director,
        business_entity=claimed_llc,
        basis=SigningAuthority.Basis.NOTARIZED_POA,
        poa_registry_id="revoked-123",
    )
    assert services.is_valid_now(authority, poa_provider=FakePoaRegistryProvider()) is False

    authority.poa_registry_id = "active-456"
    authority.save(update_fields=["poa_registry_id"])
    assert services.is_valid_now(authority, poa_provider=FakePoaRegistryProvider()) is True


def test_is_valid_now_ignores_poa_registry_for_registry_verified_director(
    director: User, claimed_llc: BusinessEntity
):
    authority = SigningAuthority.objects.create(
        user=director,
        business_entity=claimed_llc,
        basis=SigningAuthority.Basis.REGISTRY_VERIFIED_DIRECTOR,
    )
    assert services.is_valid_now(authority, poa_provider=FakePoaRegistryProvider()) is True


def test_is_valid_now_false_when_inactive(director: User, claimed_llc: BusinessEntity):
    authority = SigningAuthority.objects.create(
        user=director,
        business_entity=claimed_llc,
        basis="registry_verified_director",
        is_active=False,
    )
    assert services.is_valid_now(authority, poa_provider=FakePoaRegistryProvider()) is False


# --- dispute integration: revoke_all_signing_authorities --------------------


def test_dispute_claim_revokes_hijacker_authorities(
    director: User, stranger: User, claimed_llc: BusinessEntity
):
    """domain-model.md §3.2.2/§4 revoke_all_authorities: возврат карточки
    законному директору аннулирует уже выданные права подписи. Хайджекер
    получает NOTARIZED_POA (единственное основание без ФИО/формо-проверок
    при выдаче в Р1 — MANUAL_REVIEW заблокирован для ru_ooo, REGISTRY_
    VERIFIED_DIRECTOR требует совпадения ФИО с реальным директором)."""
    hijacker_authority = services.grant_signing_authority(
        claimed_llc,
        director,
        stranger,
        basis=SigningAuthority.Basis.NOTARIZED_POA,
        proof={"poa_registry_id": "hijacked-poa-1"},
    )
    assert hijacker_authority.is_active

    entities_services.dispute_claim(claimed_llc, director, proof=None)

    hijacker_authority.refresh_from_db()
    assert hijacker_authority.is_active is False


# --- ContractAssignment (модель + сервис, без HTTP) -------------------------


def test_assign_and_revoke_contract_assignment(director: User, claimed_llc: BusinessEntity):
    rep = services.grant_representative(
        claimed_llc, director, director, role=Representative.Role.MEMBER
    )
    assignment = services.assign_to_contract(rep, director, contract_id=director.id)
    assert assignment.revoked_at is None

    services.revoke_assignment(assignment)
    assignment.refresh_from_db()
    assert assignment.revoked_at is not None
    assert ContractAssignment.objects.filter(pk=assignment.pk).exists()
