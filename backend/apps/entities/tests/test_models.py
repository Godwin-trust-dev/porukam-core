from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.entities.models import BusinessEntity, OwnershipEpoch, TaxIdentifier

pytestmark = pytest.mark.django_db


@pytest.fixture
def creator() -> User:
    return User.objects.create(trust_id="trust-entities-model-1", phone="+79990600001")


@pytest.fixture
def entity(creator: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name='ООО "Тест"',
        created_by=creator,
    )


def test_defaults(entity: BusinessEntity):
    assert entity.claim_status == BusinessEntity.ClaimStatus.UNCLAIMED
    assert entity.claim_method is None
    assert entity.verification_status == BusinessEntity.VerificationStatus.DRAFT


def test_tax_identifier_unique_per_type_and_value(entity: BusinessEntity, creator: User):
    other_entity = BusinessEntity.objects.create(
        country_of_registration="RU", local_form_code="ru_ooo", name="Другое", created_by=creator
    )
    TaxIdentifier.objects.create(entity=entity, id_type=TaxIdentifier.IdType.INN, value="123")
    with transaction.atomic(), pytest.raises(IntegrityError):
        TaxIdentifier.objects.create(
            entity=other_entity, id_type=TaxIdentifier.IdType.INN, value="123"
        )


def test_ownership_epochs_may_not_overlap_in_time(entity: BusinessEntity):
    """EXCLUDE-констрейнт (GiST) — только на живом PostgreSQL (CLAUDE.md)."""
    now = timezone.now()
    OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=1,
        started_at=now,
        ended_at=now + timedelta(days=10),
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )
    with transaction.atomic(), pytest.raises(IntegrityError):
        OwnershipEpoch.objects.create(
            entity=entity,
            epoch_number=2,
            started_at=now + timedelta(days=5),
            ended_at=None,
            detected_via=OwnershipEpoch.DetectedVia.SCHEDULED_REGISTRY_CHECK,
        )


def test_ownership_epochs_may_follow_sequentially(entity: BusinessEntity):
    now = timezone.now()
    OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=1,
        started_at=now,
        ended_at=now + timedelta(days=10),
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )
    second = OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=2,
        started_at=now + timedelta(days=10),
        ended_at=None,
        detected_via=OwnershipEpoch.DetectedVia.SCHEDULED_REGISTRY_CHECK,
    )
    assert second.pk is not None


def test_ownership_epochs_of_different_entities_may_overlap(creator: User, entity: BusinessEntity):
    other_entity = BusinessEntity.objects.create(
        country_of_registration="RU", local_form_code="ru_ooo", name="Другое", created_by=creator
    )
    now = timezone.now()
    OwnershipEpoch.objects.create(
        entity=entity,
        epoch_number=1,
        started_at=now,
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )
    other_epoch = OwnershipEpoch.objects.create(
        entity=other_entity,
        epoch_number=1,
        started_at=now,
        detected_via=OwnershipEpoch.DetectedVia.INITIAL_VERIFICATION,
    )
    assert other_epoch.pk is not None
