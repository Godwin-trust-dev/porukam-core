import pytest
from rest_framework.exceptions import APIException

from apps.accounts.models import User
from apps.identity.permissions import require_verification


class _FakeRequest:
    def __init__(self, user):
        self.user = user


class _AnonymousUser:
    is_authenticated = False


@pytest.mark.django_db
def test_allows_when_level_meets_requirement():
    user = User.objects.create(
        trust_id="trust-perm-1",
        phone="+79990400001",
        verification_level=User.VerificationLevel.VERIFIED,
    )
    permission = require_verification(User.VerificationLevel.VERIFIED)()
    assert permission.has_permission(_FakeRequest(user), None) is True


@pytest.mark.django_db
def test_denies_with_403_verification_required_when_level_too_low():
    user = User.objects.create(trust_id="trust-perm-2", phone="+79990400002")
    permission = require_verification(User.VerificationLevel.VERIFIED)()

    with pytest.raises(APIException) as exc_info:
        permission.has_permission(_FakeRequest(user), None)

    exc = exc_info.value
    assert exc.status_code == 403
    assert exc.code == "verification_required"
    assert exc.context == {"required_level": User.VerificationLevel.VERIFIED}


def test_denies_unauthenticated_without_raising():
    permission = require_verification(User.VerificationLevel.VERIFIED)()
    assert permission.has_permission(_FakeRequest(_AnonymousUser()), None) is False
