import re

import pytest

from apps.accounts import services
from apps.accounts.models import User, UserDevice
from apps.accounts.providers import FakeSMSGateway

pytestmark = pytest.mark.django_db


def _sent_code(gateway: FakeSMSGateway) -> str:
    phone, message = gateway.sent[-1]
    match = re.search(r"\d{6}", message)
    assert match, f"код не найден в сообщении: {message!r}"
    return match.group()


def test_request_otp_sends_code_via_gateway():
    gateway = FakeSMSGateway()
    services.request_otp("+79990100001", gateway=gateway)
    assert len(gateway.sent) == 1
    assert gateway.sent[0][0] == "+79990100001"


def test_request_otp_rate_limited_after_limit():
    gateway = FakeSMSGateway()
    phone = "+79990100002"
    for _ in range(services.OTP_REQUEST_LIMIT):
        services.request_otp(phone, gateway=gateway)
    with pytest.raises(services.OTPRateLimitedError):
        services.request_otp(phone, gateway=gateway)


def test_otp_rate_limit_does_not_leak_phone_into_logs(caplog):
    """docs/tasks/fundament-2.md ЭФ.6 приёмка: "греп по логам не находит
    телефонов" — здесь на конкретном реальном пути утечки (сообщение
    исключения services.OTPRateLimitedError несёт телефон открытым текстом,
    структурный лог рядом с ним — нет, common/logging.py:redact_pii)."""
    gateway = FakeSMSGateway()
    phone = "+79990100077"
    for _ in range(services.OTP_REQUEST_LIMIT):
        services.request_otp(phone, gateway=gateway)

    with caplog.at_level("WARNING"), pytest.raises(services.OTPRateLimitedError):
        services.request_otp(phone, gateway=gateway)

    rendered = "\n".join(record.getMessage() for record in caplog.records)
    assert phone not in rendered
    assert "otp.request_rate_limited" in rendered


def test_verify_otp_creates_user_with_basic_level_and_hidden_trust_id():
    gateway = FakeSMSGateway()
    phone = "+79990100003"
    services.request_otp(phone, gateway=gateway)
    code = _sent_code(gateway)

    user, tokens = services.verify_otp(phone, code)

    assert user.phone == phone
    assert user.verification_level == User.VerificationLevel.BASIC
    assert user.has_business_status is False
    assert user.trust_id  # сгенерирован
    assert tokens.access and tokens.refresh


def test_verify_otp_wrong_code_raises():
    gateway = FakeSMSGateway()
    phone = "+79990100004"
    services.request_otp(phone, gateway=gateway)
    with pytest.raises(services.OTPInvalidCodeError):
        services.verify_otp(phone, "000000")


def test_verify_otp_without_request_raises_expired():
    with pytest.raises(services.OTPCodeExpiredError):
        services.verify_otp("+79990100005", "111111")


def test_verify_otp_code_is_single_use():
    gateway = FakeSMSGateway()
    phone = "+79990100006"
    services.request_otp(phone, gateway=gateway)
    code = _sent_code(gateway)
    services.verify_otp(phone, code)
    with pytest.raises(services.OTPCodeExpiredError):
        services.verify_otp(phone, code)


def test_verify_otp_too_many_wrong_attempts_locks_out():
    gateway = FakeSMSGateway()
    phone = "+79990100007"
    services.request_otp(phone, gateway=gateway)
    for _ in range(services.OTP_VERIFY_ATTEMPT_LIMIT):
        with pytest.raises(services.OTPInvalidCodeError):
            services.verify_otp(phone, "000000")
    with pytest.raises(services.OTPRateLimitedError):
        services.verify_otp(phone, "000000")


def test_verify_otp_existing_user_keeps_verification_level():
    gateway = FakeSMSGateway()
    phone = "+79990100008"
    services.request_otp(phone, gateway=gateway)
    user, _ = services.verify_otp(phone, _sent_code(gateway))
    user.verification_level = User.VerificationLevel.VERIFIED
    user.save(update_fields=["verification_level"])

    services.request_otp(phone, gateway=gateway)
    user2, _ = services.verify_otp(phone, _sent_code(gateway))

    assert user2.pk == user.pk
    assert user2.verification_level == User.VerificationLevel.VERIFIED


def test_refresh_token_pair_rotates_and_rejects_reused_old_token(settings):
    """Без grace-окна (ADR-108) повтор старого токена — отказ; с окном см.
    test_rotated_refresh_reused_inside_grace_returns_same_new_pair."""
    settings.REFRESH_ROTATION_GRACE_SECONDS = 0
    gateway = FakeSMSGateway()
    phone = "+79990100009"
    services.request_otp(phone, gateway=gateway)
    _, tokens = services.verify_otp(phone, _sent_code(gateway))

    rotated = services.refresh_token_pair(tokens.refresh)
    assert rotated.refresh != tokens.refresh
    assert rotated.access != tokens.access

    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair(tokens.refresh)


def test_logout_blacklists_refresh_then_reuse_rejected():
    gateway = FakeSMSGateway()
    phone = "+79990100010"
    services.request_otp(phone, gateway=gateway)
    _, tokens = services.verify_otp(phone, _sent_code(gateway))

    services.logout(tokens.refresh)

    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair(tokens.refresh)


def test_refresh_with_garbage_token_raises():
    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair("not-a-real-token")


def test_update_profile_encrypts_full_name_roundtrip():
    from apps.accounts.selectors import get_full_name

    user = User.objects.create(trust_id="trust-profile-1", phone="+79990100011")
    services.update_profile(user, full_name="Иван Иванов")
    user.refresh_from_db()
    assert get_full_name(user) == "Иван Иванов"


def test_update_profile_does_not_touch_has_business_status_or_trust_id():
    user = User.objects.create(trust_id="trust-profile-2", phone="+79990100012")
    services.update_profile(user, email="a@example.test", full_name="Имя")
    user.refresh_from_db()
    assert user.has_business_status is False
    assert user.trust_id == "trust-profile-2"


def test_set_business_status_is_the_only_intended_mutation_path():
    user = User.objects.create(trust_id="trust-biz-1", phone="+79990100013")
    services.set_business_status(user, True)
    user.refresh_from_db()
    assert user.has_business_status is True


def test_set_phone_discoverability_is_the_only_intended_mutation_path():
    user = User.objects.create(trust_id="trust-discoverable-1", phone="+79990100015")
    assert user.discoverable_by_phone is None
    services.set_phone_discoverability(user, True)
    user.refresh_from_db()
    assert user.discoverable_by_phone is True
    services.set_phone_discoverability(user, False)
    user.refresh_from_db()
    assert user.discoverable_by_phone is False


def test_register_device_allows_multiple_devices_same_platform():
    user = User.objects.create(trust_id="trust-dev-1", phone="+79990100014")
    d1 = services.register_device(user, platform=UserDevice.Platform.ANDROID)
    d2 = services.register_device(user, platform=UserDevice.Platform.ANDROID)
    assert d1.pk != d2.pk
    assert UserDevice.objects.filter(user=user).count() == 2


def test_register_device_key_for_foreign_device_raises_not_found():
    owner = User.objects.create(trust_id="trust-dev-2", phone="+79990100015")
    stranger = User.objects.create(trust_id="trust-dev-3", phone="+79990100016")
    device = services.register_device(owner, platform=UserDevice.Platform.WEB)

    with pytest.raises(services.DeviceNotFoundError):
        services.register_device_key(stranger, device.pk, public_key=b"pub", algorithm="Ed25519")


def test_register_device_key_success():
    user = User.objects.create(trust_id="trust-dev-4", phone="+79990100017")
    device = services.register_device(user, platform=UserDevice.Platform.WEB)
    key = services.register_device_key(user, device.pk, public_key=b"pub", algorithm="Ed25519")
    assert key.device_id == device.pk
    assert bytes(key.public_key) == b"pub"


# --- Grace-окно ротации refresh (ADR-108) -------------------------------------


def _fresh_pair(phone: str) -> services.TokenPair:
    gateway = FakeSMSGateway()
    services.request_otp(phone, gateway=gateway)
    _, tokens = services.verify_otp(phone, _sent_code(gateway))
    return tokens


def test_rotated_refresh_reused_inside_grace_returns_same_new_pair():
    """Две вкладки с одним refresh: вторая, предъявив уже провёрнутый токен в
    окне, получает ТУ ЖЕ пару, что и первая, — не 401."""
    tokens = _fresh_pair("+79990100020")

    rotated = services.refresh_token_pair(tokens.refresh)
    graced = services.refresh_token_pair(tokens.refresh)

    assert graced.refresh == rotated.refresh
    assert graced.access == rotated.access


def test_rotated_refresh_reused_after_grace_is_rejected(settings):
    settings.REFRESH_ROTATION_GRACE_SECONDS = 0
    tokens = _fresh_pair("+79990100021")

    services.refresh_token_pair(tokens.refresh)
    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair(tokens.refresh)


def test_grace_pair_is_itself_rotatable_once():
    """Выданная через окно пара — обычная: её refresh проворачивается, старый
    (из окна) после этого снова в окне, но уже своего jti."""
    tokens = _fresh_pair("+79990100022")
    rotated = services.refresh_token_pair(tokens.refresh)
    graced = services.refresh_token_pair(tokens.refresh)

    next_pair = services.refresh_token_pair(graced.refresh)
    assert next_pair.refresh != rotated.refresh


def test_logged_out_refresh_gets_no_grace():
    """Окно ставит только ротация: отозванный через logout токен — 401 сразу."""
    tokens = _fresh_pair("+79990100023")
    services.logout(tokens.refresh)
    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair(tokens.refresh)


def test_tampered_token_gets_no_grace():
    """Окно не обходит проверку подписи: подделанный токен с тем же jti — 401."""
    tokens = _fresh_pair("+79990100024")
    services.refresh_token_pair(tokens.refresh)
    head, body, _sig = tokens.refresh.split(".")
    with pytest.raises(services.RefreshTokenInvalidError):
        services.refresh_token_pair(f"{head}.{body}.AAAA")


def test_access_token_lifetime_is_one_hour(settings):
    from datetime import timedelta

    assert settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"] == timedelta(minutes=60)
