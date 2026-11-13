"""БД-инварианты apps.authority — на живом PostgreSQL."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.authority.models import Representative, SigningAuthority
from apps.entities.models import BusinessEntity

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-authority-model-1", phone="+79990900001")


@pytest.fixture
def entity(user: User) -> BusinessEntity:
    return BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Ромашка",
        created_by=user,
    )


def test_representative_unique_per_user_and_entity(user: User, entity: BusinessEntity):
    Representative.objects.create(user=user, business_entity=entity, role="member")
    with pytest.raises(IntegrityError), transaction.atomic():
        Representative.objects.create(user=user, business_entity=entity, role="manager")


def test_signing_authority_requires_both_amount_fields_or_neither(
    user: User, entity: BusinessEntity
):
    SigningAuthority.objects.create(
        user=user, business_entity=entity, basis="registry_verified_director"
    )  # без лимита — ок
    SigningAuthority.objects.create(
        user=user,
        business_entity=entity,
        basis="manual_review",
        max_amount_value="50000.00",
        max_amount_currency="RUB",
    )  # с лимитом — ок

    with pytest.raises(IntegrityError), transaction.atomic():
        SigningAuthority.objects.create(
            user=user, business_entity=entity, basis="manual_review", max_amount_value="10.00"
        )
