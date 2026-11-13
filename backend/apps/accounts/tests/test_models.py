import uuid

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import DeviceKey, User, UserDevice


@pytest.fixture
def user(db) -> User:
    return User.objects.create(
        trust_id="trust-1", phone="+79990000001", verification_level=User.VerificationLevel.BASIC
    )


@pytest.mark.django_db
def test_user_gets_uuid7_pk():
    user = User.objects.create(trust_id="trust-x", phone="+79990000002")
    assert isinstance(user.id, uuid.UUID)
    assert user.id.version == 7


@pytest.mark.django_db
def test_defaults():
    user = User.objects.create(trust_id="trust-y", phone="+79990000003")
    assert user.verification_level == User.VerificationLevel.GUEST
    assert user.has_business_status is False
    assert user.is_active is True
    assert user.is_banned is False
    # docs/tasks/etap-3-delta-adr059.md §1.3: NULL до явного выбора, НИКАКОГО
    # дефолта True — регистрация не завершается, пока это NULL.
    assert user.discoverable_by_phone is None
    assert user.discoverable_by_handle is True


@pytest.mark.django_db
def test_trust_id_must_be_unique(user):
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create(trust_id=user.trust_id, phone="+79990000009")


@pytest.mark.django_db
def test_phone_uniqueness_is_case_insensitive():
    """db_collation=case_insensitive — аналог citext (tech-spec.md §5.2.1)."""
    User.objects.create(trust_id="trust-a", phone="user@Example.test", email=None)
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create(trust_id="trust-b", phone="USER@example.TEST")


@pytest.mark.django_db
def test_email_uniqueness_is_case_insensitive():
    User.objects.create(trust_id="trust-c", phone="+79990000004", email="a@Example.test")
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create(trust_id="trust-d", phone="+79990000005", email="A@example.TEST")


@pytest.mark.django_db
def test_user_device_cascades_on_user_delete(user):
    device = UserDevice.objects.create(user=user, platform=UserDevice.Platform.ANDROID)
    DeviceKey.objects.create(device=device, user=user, public_key=b"pub", algorithm="Ed25519")
    user.delete()
    assert not UserDevice.objects.filter(pk=device.pk).exists()
    assert not DeviceKey.objects.exists()
