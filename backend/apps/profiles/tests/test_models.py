"""БД-инварианты apps.profiles — на живом PostgreSQL."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.entities.models import BusinessEntity
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-profiles-model-1", phone="+79990830001")


@pytest.fixture
def entity(user: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        tax_regime_code="ru_osn",
        name="ООО Ромашка",
        created_by=user,
    )


def test_person_profile_with_owner_entity_is_rejected(entity: BusinessEntity):
    with pytest.raises(IntegrityError), transaction.atomic():
        Profile.objects.create(
            kind=Profile.Kind.PERSON,
            owner_entity=entity,
            profile_visibility=Profile.Visibility.PUBLIC,
        )


def test_business_profile_with_owner_user_is_rejected(user: User):
    with pytest.raises(IntegrityError), transaction.atomic():
        Profile.objects.create(
            kind=Profile.Kind.BUSINESS,
            owner_user=user,
            profile_visibility=Profile.Visibility.PUBLIC,
        )


def test_business_profile_requires_public_visibility_at_db_level(entity: BusinessEntity):
    """Дельта §1.4 (Р5): CHECK как последний рубеж, даже если сервис-слой
    обойти напрямую через ORM."""
    with pytest.raises(IntegrityError), transaction.atomic():
        Profile.objects.create(
            kind=Profile.Kind.BUSINESS,
            owner_entity=entity,
            profile_visibility=Profile.Visibility.LINK_AND_DEALS,
        )


def test_business_profile_public_is_allowed(entity: BusinessEntity):
    profile = Profile.objects.create(
        kind=Profile.Kind.BUSINESS,
        owner_entity=entity,
        profile_visibility=Profile.Visibility.PUBLIC,
    )
    assert profile.pk is not None


def test_one_person_profile_per_user(user: User):
    Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=user, profile_visibility=Profile.Visibility.PUBLIC
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        Profile.objects.create(
            kind=Profile.Kind.PERSON, owner_user=user, profile_visibility=Profile.Visibility.PUBLIC
        )
