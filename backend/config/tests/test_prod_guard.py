"""Guard прод-настроек (ADR-201): каждый запрет — отдельным тестом.

Тестируется чистая функция над словарём настроек — settings не перезагружаются
(полный импорт config.settings.production в тестах невозможен: обязательные env).
"""

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.settings.prod_guard import (
    VALVE_KEYS,
    collect_production_violations,
    enforce_production_settings,
)

GOOD_SECRET = "k" * 50


def good() -> dict[str, object]:
    """Эталон прод-.env из шаблона прод-окружения."""
    return {
        "SECRET_KEY": GOOD_SECRET,
        "DEBUG": False,
        "ALLOWED_HOSTS": ["porukam.app"],
        "OTP_FIXED_CODE": None,
        "PHONEBOOK_HASH_PEPPER": "p" * 40,
        "GOOGLE_LOGIN_PROVIDER": "real",
        "PHONE_LOGIN_ENABLED": False,
        "PROD_ALLOW_FAKE_PROVIDERS": [],
        "NOTIFICATIONS_PUSH_PROVIDER": "webpush",
        "NOTIFICATIONS_NATIVE_PUSH_PROVIDERS": "",
        "NOTIFICATIONS_EMAIL_PROVIDER": "resend",
        "AUDIT_VAULT_TSA_PROVIDER": "rfc3161",
        "PROFILE_AVATAR_STORE": "s3",
        "GROUP_LOGO_STORE": None,
        "EVIDENCE_OBJECT_STORE": "s3",
        "ARCHIVE_OBJECT_STORE": "s3",
        "EVIDENCE_DRIVE_PROVIDER": "real",
    }


def with_(**kw: object) -> dict[str, object]:
    cfg = good()
    cfg.update(kw)
    return cfg


def test_good_settings_pass():
    assert collect_production_violations(good()) == []
    enforce_production_settings(good())


# --- жёсткие запреты ---


@pytest.mark.parametrize("value", ["fake", "", None, "Fake"])
def test_google_login_not_real_forbidden(value):
    v = collect_production_violations(with_(GOOGLE_LOGIN_PROVIDER=value))
    assert len(v) == 1 and "GOOGLE_LOGIN_PROVIDER" in v[0]


def test_google_login_not_bypassed_by_valve():
    cfg = with_(GOOGLE_LOGIN_PROVIDER="fake", PROD_ALLOW_FAKE_PROVIDERS=["GOOGLE_LOGIN_PROVIDER"])
    v = collect_production_violations(cfg)
    assert any("GOOGLE_LOGIN_PROVIDER должен" in x for x in v)
    # и само имя клапана Google — неизвестное
    assert any("неизвестное имя" in x for x in v)


def test_otp_fixed_code_forbidden():
    v = collect_production_violations(with_(OTP_FIXED_CODE="111111"))
    assert len(v) == 1 and "OTP_FIXED_CODE" in v[0]


def test_otp_fixed_code_not_bypassed_by_valve():
    cfg = with_(OTP_FIXED_CODE="111111", PROD_ALLOW_FAKE_PROVIDERS=["OTP_FIXED_CODE"])
    assert any("OTP_FIXED_CODE задан" in x for x in collect_production_violations(cfg))


@pytest.mark.parametrize(
    "secret",
    [
        "",
        None,
        "short",
        "x" * 31,
        "change-me-in-every-environment" + "x" * 10,
        "a" * 40 + "INSECURE",
    ],
)
def test_weak_secret_key_forbidden(secret):
    v = collect_production_violations(with_(SECRET_KEY=secret))
    assert len(v) == 1 and "SECRET_KEY" in v[0]


def test_pepper_placeholder_forbidden():
    v = collect_production_violations(with_(PHONEBOOK_HASH_PEPPER="change-me-per-environment"))
    assert len(v) == 1 and "PEPPER" in v[0]


def test_debug_true_forbidden():
    v = collect_production_violations(with_(DEBUG=True))
    assert len(v) == 1 and "DEBUG" in v[0]


def test_wildcard_allowed_hosts_forbidden():
    v = collect_production_violations(with_(ALLOWED_HOSTS=["porukam.app", "*"]))
    assert len(v) == 1 and "ALLOWED_HOSTS" in v[0]


def test_unknown_valve_name_is_violation():
    v = collect_production_violations(with_(PROD_ALLOW_FAKE_PROVIDERS=["TYPO_PROVIDER"]))
    assert len(v) == 1 and "TYPO_PROVIDER" in v[0]


# --- fake-провайдеры: по одному тесту на провайдера ---


@pytest.mark.parametrize(
    "name",
    [
        "NOTIFICATIONS_PUSH_PROVIDER",
        "NOTIFICATIONS_EMAIL_PROVIDER",
        "AUDIT_VAULT_TSA_PROVIDER",
        "PROFILE_AVATAR_STORE",
        "EVIDENCE_OBJECT_STORE",
        "ARCHIVE_OBJECT_STORE",
        "EVIDENCE_DRIVE_PROVIDER",
    ],
)
def test_fake_provider_forbidden_and_valve_allows(name):
    v = collect_production_violations(with_(**{name: "fake"}))
    assert len(v) == 1 and name in v[0]
    # клапан снимает именно этого провайдера (регистр не важен)
    assert (
        collect_production_violations(
            with_(**{name: "fake", "PROD_ALLOW_FAKE_PROVIDERS": [name.lower()]})
        )
        == []
    )


def test_valve_covers_only_listed_provider():
    cfg = with_(
        NOTIFICATIONS_EMAIL_PROVIDER="fake",
        EVIDENCE_OBJECT_STORE="fake",
        PROD_ALLOW_FAKE_PROVIDERS=["NOTIFICATIONS_EMAIL_PROVIDER"],
    )
    v = collect_production_violations(cfg)
    assert len(v) == 1 and "EVIDENCE_OBJECT_STORE" in v[0]


def test_push_fake_ok_when_only_native_channels():
    cfg = with_(
        NOTIFICATIONS_PUSH_PROVIDER="fake", NOTIFICATIONS_NATIVE_PUSH_PROVIDERS="rustore,fcm"
    )
    assert collect_production_violations(cfg) == []


def test_group_logo_store_fake_forbidden_and_valve():
    v = collect_production_violations(with_(GROUP_LOGO_STORE="fake"))
    assert len(v) == 1 and "GROUP_LOGO_STORE" in v[0]
    assert (
        collect_production_violations(
            with_(GROUP_LOGO_STORE="fake", PROD_ALLOW_FAKE_PROVIDERS=["GROUP_LOGO_STORE"])
        )
        == []
    )


def test_fake_sms_ok_when_phone_login_disabled():
    assert collect_production_violations(with_(PHONE_LOGIN_ENABLED=False)) == []


def test_phone_login_enabled_forbidden_without_real_sms():
    v = collect_production_violations(with_(PHONE_LOGIN_ENABLED=True))
    assert len(v) == 1 and "PHONE_LOGIN_ENABLED" in v[0]


def test_phone_login_enabled_allowed_by_valve():
    cfg = with_(PHONE_LOGIN_ENABLED=True, PROD_ALLOW_FAKE_PROVIDERS=["SMS_GATEWAY"])
    assert collect_production_violations(cfg) == []


def test_valve_accepts_comma_string_and_spaces():
    cfg = with_(
        NOTIFICATIONS_EMAIL_PROVIDER="fake",
        EVIDENCE_DRIVE_PROVIDER="fake",
        PROD_ALLOW_FAKE_PROVIDERS="notifications_email_provider , EVIDENCE_DRIVE_PROVIDER",
    )
    assert collect_production_violations(cfg) == []


def test_all_violations_reported_at_once():
    cfg = with_(
        GOOGLE_LOGIN_PROVIDER="fake",
        OTP_FIXED_CODE="111111",
        SECRET_KEY="change-me",
        DEBUG=True,
        ALLOWED_HOSTS=["*"],
        EVIDENCE_OBJECT_STORE="fake",
    )
    with pytest.raises(ImproperlyConfigured) as exc:
        enforce_production_settings(cfg)
    text = str(exc.value)
    for marker in (
        "GOOGLE_LOGIN_PROVIDER",
        "OTP_FIXED_CODE",
        "SECRET_KEY",
        "DEBUG",
        "ALLOWED_HOSTS",
        "EVIDENCE_OBJECT_STORE",
    ):
        assert marker in text
    assert "ADR-201" in text


def test_valve_keys_do_not_include_google_or_otp():
    assert "GOOGLE_LOGIN_PROVIDER" not in VALVE_KEYS
    assert "OTP_FIXED_CODE" not in VALVE_KEYS
