import pytest

from apps.accounts.models import User
from apps.identity.models import IdentityVerification


@pytest.fixture
def user(db) -> User:
    return User.objects.create(trust_id="trust-identity-1", phone="+79990300001")


@pytest.mark.django_db
def test_defaults(user):
    verification = IdentityVerification.objects.create(
        user=user, provider="esia_fake", level=IdentityVerification.Level.VERIFIED
    )
    assert verification.status == IdentityVerification.Status.PENDING
    assert verification.verified_attributes == {}
    assert verification.expires_at is None


@pytest.mark.django_db
def test_cascades_on_user_delete(user):
    IdentityVerification.objects.create(
        user=user, provider="esia_fake", level=IdentityVerification.Level.VERIFIED
    )
    user.delete()
    assert not IdentityVerification.objects.exists()
