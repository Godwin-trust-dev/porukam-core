import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.entities import services
from apps.entities.models import BusinessEntity, OwnershipEpoch, TaxIdentifier
from apps.entities.providers import FakeEntityRegistryProvider, RegistryEntityData
from apps.identity import services as identity_services
from apps.identity.providers import FakeEsiaProvider

pytestmark = pytest.mark.django_db

_esia = FakeEsiaProvider()
_registry = FakeEntityRegistryProvider()


def _verify(user: User, *, full_name: str, tax_id: str) -> None:
    """Проводит пользователя через фейк-ЕСИА (apps.identity, 3.2) — тот же
    единственный путь поднять verification_level/personal_tax_id_hash, что
    и в реальном флоу (не пишет поля User напрямую)."""
    _url, state = identity_services.build_authorize_url(user, provider=_esia)
    identity_services.complete_verification(
        user, code=f"{full_name}|{tax_id}", state=state, provider=_esia
    )
    user.refresh_from_db()


@pytest.fixture
def creator() -> User:
    return User.objects.create(trust_id="trust-entities-svc-creator", phone="+79990700001")


# --- register_business_entity -------------------------------------------------


def test_register_unknown_tax_id_raises(creator: User):
    with pytest.raises(services.EntityNotFoundInRegistryError):
        services.register_business_entity(
            "no-such-inn", country="RU", created_by=creator, provider=_registry
        )


def test_register_liquidated_entity_raises(creator: User):
    with pytest.raises(services.EntityLiquidatedError):
        services.register_business_entity(
            FakeEntityRegistryProvider.LIQUIDATED_INN,
            country="RU",
            created_by=creator,
            provider=_registry,
        )


def test_register_creates_unclaimed_entity_with_initial_epoch(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    assert entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED
    assert entity.verified_against_registry is True
    epoch = entity.ownership_epochs.get()
    assert epoch.epoch_number == 1
    assert epoch.detected_via == OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION


def test_register_same_tax_id_twice_is_idempotent(creator: User):
    first = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    second = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    assert first.id == second.id
    assert BusinessEntity.objects.count() == 1


# --- try_auto_claim / has_business_status (Р1, обязательный тест, "деньги") ---


def test_owner_identity_match_claims_own_sole_proprietor_and_grants_business_status(creator: User):
    """«claim собственного ИП по ИНН → стал true» (etap-3.md 3.4)."""
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )

    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )

    entity.refresh_from_db()
    creator.refresh_from_db()
    assert entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    assert entity.claim_method == BusinessEntity.ClaimMethod.OWNER_IDENTITY_MATCH
    assert entity.claimed_by_id == creator.id
    assert creator.has_business_status is True


def test_director_identity_match_claims_foreign_llc_without_business_status(creator: User):
    """«verified-пользователь стал Representative чужого ООО →
    has_business_status остался false» (etap-3.md 3.4, domain-model.md
    §3.2.2: директорство чужого юрлица бизнес-статуса физлицу не даёт)."""
    _verify(
        creator,
        full_name="Иван Петрович Директоров",
        tax_id="000000000000",  # ИНН физлица — не совпадает с ИНН юрлица
    )

    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )

    entity.refresh_from_db()
    creator.refresh_from_db()
    assert entity.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    assert entity.claim_method == BusinessEntity.ClaimMethod.DIRECTOR_IDENTITY_MATCH
    assert entity.director_user_id == creator.id
    assert creator.has_business_status is False


def test_unverified_user_does_not_auto_claim(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    assert entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED


def test_verified_but_mismatched_owner_does_not_claim(creator: User):
    _verify(creator, full_name="Кто-то Ещё", tax_id="999999999999")
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    assert entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED


def test_try_auto_claim_is_noop_for_already_claimed_entity(creator: User):
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    other = User.objects.create(trust_id="trust-entities-svc-other", phone="+79990700002")
    _verify(other, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)
    assert services.try_auto_claim(entity, other) is False


# --- claim_business_entity (POST /claim) -------------------------------------


def test_claim_manual_review_sets_pending(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    claimant = User.objects.create(trust_id="trust-entities-svc-manual", phone="+79990700003")

    result = services.claim_business_entity(
        entity, claimant, method=BusinessEntity.ClaimMethod.MANUAL_REVIEW, proof={}
    )
    assert result.claim_status == BusinessEntity.ClaimStatus.PENDING
    assert result.claim_method == BusinessEntity.ClaimMethod.MANUAL_REVIEW


def test_claim_unimplemented_method_raises(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    with pytest.raises(services.ClaimMethodNotAvailableError):
        services.claim_business_entity(
            entity,
            creator,
            method=BusinessEntity.ClaimMethod.NOTARIZED_POA,
            proof={},
        )


def test_claim_owner_identity_match_without_matching_verification_raises(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    with pytest.raises(services.ClaimMethodNotSatisfiedError):
        services.claim_business_entity(
            entity, creator, method=BusinessEntity.ClaimMethod.OWNER_IDENTITY_MATCH, proof={}
        )


def test_claim_owner_identity_match_succeeds_after_late_verification(creator: User):
    """Онбординг раньше верификации — повторная явная попытка через POST
    /claim должна доклеить claim, когда пользователь верифицируется позже."""
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    assert entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED

    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    result = services.claim_business_entity(
        entity, creator, method=BusinessEntity.ClaimMethod.OWNER_IDENTITY_MATCH, proof={}
    )
    assert result.claim_status == BusinessEntity.ClaimStatus.CLAIMED


# --- dispute_claim (ADR-042: директор по реестру всегда побеждает) ----------


def test_dispute_by_registry_director_reclaims_entity(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    hijacker = User.objects.create(trust_id="trust-entities-svc-hijacker", phone="+79990700004")
    services.claim_business_entity(
        entity, hijacker, method=BusinessEntity.ClaimMethod.MANUAL_REVIEW, proof={}
    )
    entity.claim_status = BusinessEntity.ClaimStatus.CLAIMED
    entity.claimed_by = hijacker
    entity.save(update_fields=["claim_status", "claimed_by"])

    real_director = User.objects.create(
        trust_id="trust-entities-svc-director", phone="+79990700005"
    )
    _verify(real_director, full_name="Иван Петрович Директоров", tax_id="111111111111")

    result = services.dispute_claim(entity, real_director)
    assert result.claim_status == BusinessEntity.ClaimStatus.CLAIMED
    assert result.claimed_by_id == real_director.id
    assert result.claim_method == BusinessEntity.ClaimMethod.DIRECTOR_IDENTITY_MATCH


def test_dispute_without_director_match_stays_disputed(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    claimant = User.objects.create(trust_id="trust-entities-svc-claimant", phone="+79990700006")
    result = services.dispute_claim(entity, claimant, proof={"note": "я тоже директор"})
    assert result.claim_status == BusinessEntity.ClaimStatus.DISPUTED


# --- assert_entity_operable / update_business_entity (ADR-042) --------------


def test_assert_entity_operable_raises_for_unclaimed(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    with pytest.raises(services.EntityNotOperableError):
        services.assert_entity_operable(entity)


def test_assert_entity_operable_passes_for_claimed(creator: User):
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    services.assert_entity_operable(entity)  # не должно поднять исключение


def test_update_business_entity_requires_operable(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    with pytest.raises(services.EntityNotOperableError):
        services.update_business_entity(entity, creator, tax_regime_code="ru_usn")


def test_update_business_entity_requires_claimant(creator: User):
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    stranger = User.objects.create(trust_id="trust-entities-svc-stranger", phone="+79990700007")
    with pytest.raises(services.EntityPermissionDeniedError):
        services.update_business_entity(entity, stranger, tax_regime_code="ru_usn")


def test_update_business_entity_by_claimant_succeeds(creator: User):
    _verify(
        creator, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    result = services.update_business_entity(
        entity, creator, tax_regime_code="ru_npd", bank_details={"account": "40802..."}
    )
    assert result.tax_regime_code == "ru_npd"
    assert result.bank_details_encrypted is not None
    assert result.encryption_key_ref is not None


# --- reconcile_ownership_epoch (фоновая сверка директора) -------------------


def test_reconcile_opens_new_epoch_when_director_changes(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    changed_registry = FakeEntityRegistryProvider(
        records={
            FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN: RegistryEntityData(
                found=True,
                name='ООО "Ромашка"',
                local_form_code="ru_ooo",
                tax_identifiers=(),
                director_full_name="Новый Директоров",
                is_active_in_registry=True,
            )
        }
    )

    new_epoch = services.reconcile_ownership_epoch(entity, provider=changed_registry)

    assert new_epoch is not None
    assert new_epoch.epoch_number == 2
    entity.refresh_from_db()
    assert entity.director_full_name == "Новый Директоров"
    assert entity.director_user_id is None
    old_epoch = entity.ownership_epochs.get(epoch_number=1)
    assert old_epoch.ended_at is not None


def test_reconcile_is_noop_when_director_unchanged(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    result = services.reconcile_ownership_epoch(entity, provider=_registry)
    assert result is None
    assert entity.ownership_epochs.count() == 1


def test_reconcile_is_noop_without_tax_identifier(creator: User):
    entity = BusinessEntity.objects.create(
        country_of_registration="RU", local_form_code="ru_ooo", name="Без ИНН", created_by=creator
    )
    OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=1,
        started_at=timezone.now(),
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )
    assert services.reconcile_ownership_epoch(entity, provider=_registry) is None


def test_reconcile_is_noop_when_entity_disappears_from_registry(creator: User):
    entity = services.register_business_entity(
        FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
        country="RU",
        created_by=creator,
        provider=_registry,
    )
    empty_registry = FakeEntityRegistryProvider(
        records={FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN: RegistryEntityData(found=False)}
    )
    assert services.reconcile_ownership_epoch(entity, provider=empty_registry) is None


def test_tax_identifier_type_constant_matches_model():
    assert services._INN == TaxIdentifier.IdType.INN
