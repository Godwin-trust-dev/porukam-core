import pytest

from apps.accounts.models import User
from apps.identity import services
from apps.identity.models import IdentityVerification
from apps.identity.providers import FakeEsiaProvider
from apps.identity.selectors import get_verified_full_name

pytestmark = pytest.mark.django_db

_provider = FakeEsiaProvider()


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-identity-svc-1", phone="+79990300010")


def test_build_authorize_url_returns_url_and_state(user):
    url, state = services.build_authorize_url(user, provider=_provider)
    assert state
    assert state in url


def test_complete_verification_raises_full_flow(user):
    _url, state = services.build_authorize_url(user, provider=_provider)

    verification = services.complete_verification(
        user, code="Иван Иванов|7701234567", state=state, provider=_provider
    )

    user.refresh_from_db()
    assert user.verification_level == User.VerificationLevel.VERIFIED
    assert user.personal_tax_id_hash
    assert verification.status == IdentityVerification.Status.SUCCEEDED
    assert verification.provider == _provider.provider_code
    assert get_verified_full_name(verification) == "Иван Иванов"


def test_complete_verification_does_not_touch_own_full_name(user):
    """verified_full_name_encrypted (доказанное) отдельно от
    user.full_name_encrypted (заявленное самим пользователем, apps.accounts)."""
    _url, state = services.build_authorize_url(user, provider=_provider)
    services.complete_verification(
        user, code="Иван Иванов|7701234567", state=state, provider=_provider
    )
    user.refresh_from_db()
    assert user.full_name_encrypted is None


def test_complete_verification_unknown_state_raises(user):
    with pytest.raises(services.EsiaStateInvalidError):
        services.complete_verification(
            user, code="Иван Иванов|7701234567", state="unknown-state", provider=_provider
        )


def test_complete_verification_state_is_single_use(user):
    _url, state = services.build_authorize_url(user, provider=_provider)
    services.complete_verification(
        user, code="Иван Иванов|7701234567", state=state, provider=_provider
    )
    with pytest.raises(services.EsiaStateInvalidError):
        services.complete_verification(
            user, code="Иван Иванов|7701234567", state=state, provider=_provider
        )


def test_complete_verification_state_belongs_to_another_user_raises(user):
    other = User.objects.create(trust_id="trust-identity-svc-2", phone="+79990300011")
    _url, state = services.build_authorize_url(other, provider=_provider)

    with pytest.raises(services.EsiaStateInvalidError):
        services.complete_verification(
            user, code="Иван Иванов|7701234567", state=state, provider=_provider
        )


def test_complete_verification_invalid_code_raises_and_consumes_state(user):
    _url, state = services.build_authorize_url(user, provider=_provider)

    with pytest.raises(services.EsiaCodeInvalidError):
        services.complete_verification(
            user, code="not-a-valid-code", state=state, provider=_provider
        )

    user.refresh_from_db()
    assert user.verification_level == User.VerificationLevel.GUEST

    # state одноразовый: даже провалившаяся попытка его расходует.
    with pytest.raises(services.EsiaStateInvalidError):
        services.complete_verification(
            user, code="Иван Иванов|7701234567", state=state, provider=_provider
        )
