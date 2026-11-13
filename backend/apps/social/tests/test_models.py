"""БД-инварианты apps.social — на живом PostgreSQL (CLAUDE.md: CHECK/EXCLUDE
не проверяются на sqlite)."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.social.models import AddressableGroup, Handle

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-social-model-1", phone="+79990800001")


def test_handle_requires_exactly_one_owner(user: User):
    with pytest.raises(IntegrityError), transaction.atomic():
        Handle.objects.create(user=None, group=None, value="nobody")


def test_handle_cannot_have_both_owners(user: User):
    group = AddressableGroup.objects.create(kind="community", leader=user, name="G")
    with pytest.raises(IntegrityError), transaction.atomic():
        Handle.objects.create(user=user, group=group, value="both")


def test_handle_value_unique_only_among_active(user: User):
    other = User.objects.create(trust_id="trust-social-model-2", phone="+79990800002")
    taken = Handle.objects.create(user=user, value="ivan")
    with pytest.raises(IntegrityError), transaction.atomic():
        Handle.objects.create(user=other, value="ivan")

    taken.is_active = False
    taken.changed_at = timezone.now()
    taken.save(update_fields=["is_active", "changed_at"])

    # свободен, как только прежний владелец деактивирован
    released = Handle.objects.create(user=other, value="ivan")
    assert released.value == "ivan"
