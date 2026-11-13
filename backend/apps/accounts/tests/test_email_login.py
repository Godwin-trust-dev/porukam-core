"""Вход и регистрация по e-mail кодом из письма (ADR-168).

Каждый запрет — отдельным тестом (CLAUDE.md). Адреса у тестов РАЗНЫЕ: кеш
(Redis) между тестами не откатывается, счётчики лимитов живут по ключу
`otp:email:*` от нормализованного адреса.
"""

from __future__ import annotations

from unittest import mock

import pytest
from django.test import override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.models import SocialLoginAccount, User
from apps.notifications.providers import FakeEmailProvider
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

CODE = "111111"  # OTP_FIXED_CODE тестового профиля


def _request(client: APIClient, email: str, **extra: str):
    return client.post("/v1/auth/email/request", {"email": email}, format="json", **extra)


def _verify(client: APIClient, email: str, code: str = CODE):
    return client.post("/v1/auth/email/verify", {"email": email, "code": code}, format="json")


def _login(client: APIClient, email: str) -> dict:
    resp = _request(client, email)
    assert resp.status_code == 200, resp.content
    resp = _verify(client, email)
    assert resp.status_code == 200, resp.content
    return resp.data


# --- request ---------------------------------------------------------------


def test_email_request_then_verify_returns_tokens():
    client = APIClient()
    tokens = _login(client, "login-basic@example.com")
    assert "access" in tokens and "refresh" in tokens
    user = User.objects.get(email="login-basic@example.com")
    assert user.email_verified_at is not None
    assert user.verification_level == User.VerificationLevel.BASIC
    # Страна НЕ проставляется (ADR-148): вход по почте о ней ничего не говорит.
    assert user.country_code is None
    assert not user.has_usable_password()


def test_email_request_returns_dev_hint_with_fixed_code():
    """dev_hint — тот же механизм, что у телефона: только при OTP_FIXED_CODE
    (в проде он пуст, тело остаётся пустым)."""
    client = APIClient()
    resp = _request(client, "login-hint@example.com")
    assert resp.status_code == 200, resp.content
    assert resp.data == {"dev_hint": CODE}


def test_email_request_without_fixed_code_has_empty_body(settings):
    settings.OTP_FIXED_CODE = None
    client = APIClient()
    resp = _request(client, "login-nohint@example.com")
    assert resp.status_code == 200, resp.content
    assert not resp.content


def test_email_request_rejects_malformed_address():
    client = APIClient()
    resp = _request(client, "не-адрес")
    assert resp.status_code == 400
    assert resp["Content-Type"].startswith("application/problem+json")


def test_email_request_does_not_reveal_whether_account_exists():
    """Ответ для незнакомого адреса — тот же, что для существующего."""
    client = APIClient()
    _login(client, "login-known@example.com")
    known = _request(client, "login-known@example.com")
    unknown = _request(client, "login-unknown@example.com")
    assert known.status_code == unknown.status_code == 200
    assert known.data == unknown.data


def test_email_request_rate_limited_after_limit():
    client = APIClient()
    email = "login-limit@example.com"
    for _ in range(3):  # OTP_REQUEST_LIMIT
        assert _request(client, email).status_code == 200
    resp = _request(client, email)
    assert resp.status_code == 429
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "otp_rate_limited"
    # Retry-After — машиночитаемая пауза (ADR-168): длина окна запросов.
    assert resp["Retry-After"] == "600"


def test_email_case_and_spaces_share_one_rate_limit_key():
    """«Foo@X.com» и «foo@x.com» — один вход: иначе лимит обходится сменой
    регистра, а `User.email` и так лежит с CI-collation."""
    client = APIClient()
    for raw in ("  Case@Example.com ", "CASE@example.com", "case@EXAMPLE.com"):
        assert _request(client, raw).status_code == 200
    resp = _request(client, "case@example.com")
    assert resp.status_code == 429
    assert resp.data["code"] == "otp_rate_limited"


def test_email_case_insensitive_verify_finds_same_user():
    client = APIClient()
    assert _request(client, "MiXeD@Example.com").status_code == 200
    assert _verify(client, "mixed@example.com").status_code == 200
    assert User.objects.filter(email__iexact="mixed@example.com").count() == 1
    assert User.objects.get(email__iexact="mixed@example.com").email == "mixed@example.com"


# --- письмо ----------------------------------------------------------------


def _sent_letter(email: str, *, accept_language: str) -> dict[str, object]:
    provider = FakeEmailProvider()
    client = APIClient()
    with mock.patch("apps.notifications.services.get_email_provider", return_value=provider):
        resp = _request(client, email, HTTP_ACCEPT_LANGUAGE=accept_language)
    assert resp.status_code == 200, resp.content
    assert len(provider.sent) == 1, provider.sent
    to, message = provider.sent[0]
    assert to == email
    return message


def test_letter_with_code_goes_out_in_request_language_ru():
    message = _sent_letter("letter-ru@example.com", accept_language="ru")
    assert message["locale"] == "ru"
    assert message["subject"] == "Код для входа"
    # ADR-172: код едет ОТДЕЛЬНЫМ полем (в письме — крупной плашкой), в тексте
    # остаётся только приписка про срок и «если это не вы».
    assert message["code"] == CODE
    assert CODE not in str(message["body"])
    assert "Код действует" in str(message["body"])


def test_letter_with_code_goes_out_in_request_language_en():
    message = _sent_letter("letter-en@example.com", accept_language="en")
    assert message["locale"] == "en"
    assert message["subject"] == "Your sign-in code"
    assert message["code"] == CODE
    assert "The code is valid for" in str(message["body"])


def test_letter_falls_back_to_english_without_accept_language():
    """Пользователя ещё нет — спросить `User.locale` не у кого; фолбэк писем
    (ADR-111) — en, а не DEFAULT_LOCALE."""
    message = _sent_letter("letter-nolang@example.com", accept_language="")
    assert message["locale"] == "en"


def test_undelivered_letter_does_not_break_request():
    """Провайдер лёг — вход не падает: код в кеше живёт, человек нажмёт
    «отправить ещё раз»."""
    client = APIClient()
    with mock.patch(
        "apps.notifications.services.get_email_provider",
        side_effect=lambda: _BrokenEmailProvider(),
    ):
        resp = _request(client, "letter-broken@example.com")
    assert resp.status_code == 200, resp.content
    assert _verify(client, "letter-broken@example.com").status_code == 200


class _BrokenEmailProvider(FakeEmailProvider):
    def send_to_address(self, email, message):  # type: ignore[no-untyped-def]
        from apps.notifications.providers import DeliveryResult

        return DeliveryResult(delivered=False, provider_message_id="", status="network_error")


# --- verify ----------------------------------------------------------------


def test_verify_with_wrong_code_returns_problem_json():
    client = APIClient()
    assert _request(client, "verify-wrong@example.com").status_code == 200
    resp = _verify(client, "verify-wrong@example.com", code="000000")
    assert resp.status_code == 422
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "otp_invalid_code"
    assert not User.objects.filter(email="verify-wrong@example.com").exists()


def test_verify_without_request_returns_code_expired():
    client = APIClient()
    resp = _verify(client, "verify-never@example.com")
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_code_expired"


def test_verify_second_time_with_same_code_returns_code_expired():
    """Код одноразовый — после успешного входа он из кеша удалён."""
    client = APIClient()
    _login(client, "verify-once@example.com")
    resp = _verify(client, "verify-once@example.com")
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_code_expired"


def test_verify_attempt_limit():
    client = APIClient()
    email = "verify-attempts@example.com"
    assert _request(client, email).status_code == 200
    for _ in range(5):  # OTP_VERIFY_ATTEMPT_LIMIT
        assert _verify(client, email, code="000000").status_code == 422
    resp = _verify(client, email)  # верный код уже не спасает
    assert resp.status_code == 429
    assert resp.data["code"] == "otp_rate_limited"
    # Столько же, сколько живёт ПОЧТОВЫЙ код (EMAIL_OTP_CODE_TTL_SECONDS,
    # дефолт 15 минут), а не телефонные 300 секунд.
    assert resp["Retry-After"] == "900"


def test_repeat_login_returns_same_user():
    client = APIClient()
    _login(client, "verify-repeat@example.com")
    user_id = User.objects.get(email="verify-repeat@example.com").id
    verified_at = User.objects.get(pk=user_id).email_verified_at
    _login(client, "verify-repeat@example.com")
    assert User.objects.filter(email="verify-repeat@example.com").count() == 1
    # Подтверждение не переписывается на каждый вход — это дата ПЕРВОГО
    # доказательства владения ящиком.
    assert User.objects.get(pk=user_id).email_verified_at == verified_at


def test_login_publishes_account_logged_in_with_method_email():
    client = APIClient()
    _login(client, "verify-event@example.com")
    user = User.objects.get(email="verify-event@example.com")
    event = OutboxEvent.objects.filter(topic="account.logged_in").latest("occurred_at")
    assert event.subject == {"type": "user", "id": str(user.id)}
    assert event.payload["created"] is True
    assert event.payload["method"] == "email"


# --- правило связывания (ADR-168 §3) ---------------------------------------


def _google_user(*, sub: str, link_email: str, user_email: str | None = None) -> User:
    user = User.objects.create(
        trust_id=f"trust-email-login-{sub}",
        verification_level=User.VerificationLevel.BASIC,
        email=user_email,
    )
    SocialLoginAccount.objects.create(user=user, provider="google", sub=sub, email=link_email)
    return user


def test_google_linked_email_logs_into_the_same_account():
    """Почта Google-связки подтверждена самим Google — вход по коду ведёт в
    ТОТ ЖЕ аккаунт, а не заводит второй."""
    existing = _google_user(sub="g-1", link_email="google-one@example.com")
    client = APIClient()
    _login(client, "google-one@example.com")
    assert User.objects.filter(social_login_accounts__sub="g-1").count() == 1
    existing.refresh_from_db()
    assert existing.email == "google-one@example.com"
    assert existing.email_verified_at is not None


def test_google_linked_email_match_is_case_insensitive():
    existing = _google_user(sub="g-2", link_email="Google-Two@Example.com")
    client = APIClient()
    _login(client, "google-two@example.com")
    assert User.objects.count() == 1
    existing.refresh_from_db()
    assert existing.email_verified_at is not None


def test_google_linked_user_keeps_own_self_service_email():
    """Доказано владение только тем ящиком, куда пришёл код: чужой (другой)
    `User.email` не перетирается."""
    existing = _google_user(
        sub="g-3", link_email="google-three@example.com", user_email="other-three@example.com"
    )
    client = APIClient()
    _login(client, "google-three@example.com")
    existing.refresh_from_db()
    assert existing.email == "other-three@example.com"
    assert existing.email_verified_at is None


def test_unverified_email_of_another_user_is_released_and_new_account_created():
    """Чужой НЕподтверждённый `User.email` (вписан через PATCH /users/me) не
    даёт войти в тот аккаунт: адрес обнуляется, вход идёт в новый."""
    squatter = User.objects.create(
        trust_id="trust-email-squatter-1",
        verification_level=User.VerificationLevel.BASIC,
        email="claimed@example.com",
    )
    client = APIClient()
    _login(client, "claimed@example.com")

    squatter.refresh_from_db()
    assert squatter.email is None
    owner = User.objects.get(email="claimed@example.com")
    assert owner.pk != squatter.pk
    assert owner.email_verified_at is not None

    event = OutboxEvent.objects.get(topic="account.email_unlinked")
    assert event.subject == {"type": "user", "id": str(squatter.id)}
    assert event.payload["claimed_by_user_id"] == str(owner.id)
    # Адрес в payload не дублируется (ПД в ленте/аудите).
    assert "claimed@example.com" not in str(event.payload)


def test_unverified_email_release_is_case_insensitive():
    squatter = User.objects.create(
        trust_id="trust-email-squatter-2",
        verification_level=User.VerificationLevel.BASIC,
        email="Claimed-Two@Example.com",
    )
    client = APIClient()
    _login(client, "claimed-two@example.com")
    squatter.refresh_from_db()
    assert squatter.email is None
    assert User.objects.filter(email="claimed-two@example.com").exclude(pk=squatter.pk).exists()


def test_verified_owner_wins_over_new_registration():
    """Второй вход тем же адресом — тот же аккаунт (правило 1), нового нет."""
    client = APIClient()
    _login(client, "owner-again@example.com")
    before = User.objects.count()
    _login(client, "Owner-Again@example.com")
    assert User.objects.count() == before


def test_squatter_email_is_released_even_when_google_user_takes_it():
    """Случай «и связка, и захватчик»: связка выигрывает, захватчик теряет
    незаслуженную заявку на адрес."""
    linked = _google_user(sub="g-4", link_email="both@example.com")
    squatter = User.objects.create(
        trust_id="trust-email-squatter-3",
        verification_level=User.VerificationLevel.BASIC,
        email="both@example.com",
    )
    client = APIClient()
    _login(client, "both@example.com")

    squatter.refresh_from_db()
    linked.refresh_from_db()
    assert squatter.email is None
    assert linked.email == "both@example.com"
    assert linked.email_verified_at is not None


def test_patch_users_me_email_resets_verification():
    """Подтверждение относится к КОНКРЕТНОМУ ящику: смена адреса руками его
    сбрасывает, иначе владелец нового адреса вошёл бы в чужой аккаунт."""
    client = APIClient()
    tokens = _login(client, "patch-reset@example.com")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    resp = client.patch("/v1/users/me", {"email": "patch-other@example.com"}, format="json")
    assert resp.status_code == 200, resp.content
    user = User.objects.get(email="patch-other@example.com")
    assert user.email_verified_at is None


# --- EMAIL_LOGIN_ENABLED (ADR-168 §2) --------------------------------------


@override_settings(EMAIL_LOGIN_ENABLED=False)
def test_email_request_forbidden_when_email_login_disabled():
    client = APIClient()
    resp = _request(client, "disabled-one@example.com")
    assert resp.status_code == 403
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "email_login_disabled"


@override_settings(EMAIL_LOGIN_ENABLED=False)
def test_disabled_login_does_not_send_letter():
    """403 приходит ДО сервиса — письмо не уходит и rate-limit не греется."""
    provider = FakeEmailProvider()
    client = APIClient()
    with mock.patch("apps.notifications.services.get_email_provider", return_value=provider):
        _request(client, "disabled-two@example.com")
    assert provider.sent == []


@override_settings(EMAIL_LOGIN_ENABLED=False)
def test_email_verify_forbidden_when_email_login_disabled():
    client = APIClient()
    resp = _verify(client, "disabled-three@example.com")
    assert resp.status_code == 403
    assert resp.data["code"] == "email_login_disabled"


def test_verify_forbidden_even_with_code_requested_before_disabling():
    client = APIClient()
    email = "disabled-four@example.com"
    assert _request(client, email).status_code == 200
    with override_settings(EMAIL_LOGIN_ENABLED=False):
        resp = _verify(client, email)
    assert resp.status_code == 403
    assert resp.data["code"] == "email_login_disabled"
    assert not User.objects.filter(email=email).exists()


@override_settings(EMAIL_LOGIN_ENABLED=False)
def test_patch_users_me_email_still_works_when_login_disabled():
    """Флаг закрывает ВХОД, а не наличие почты в профиле (тот же принцип, что
    у PHONE_LOGIN_ENABLED и привязки телефона, ADR-165)."""
    user = User.objects.create(
        trust_id="trust-email-patch-1",
        verification_level=User.VerificationLevel.BASIC,
        phone="+79990900001",
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    resp = client.patch("/v1/users/me", {"email": "still-editable@example.com"}, format="json")
    assert resp.status_code == 200, resp.content
    user.refresh_from_db()
    assert user.email == "still-editable@example.com"
    assert user.email_verified_at is None


# --- демо-аккаунт для ревью сторов (ADR-168 §7) ----------------------------

REVIEWER = "reviewer@porukam.app"
REVIEWER_CODE = "424242"


@override_settings(EMAIL_LOGIN_REVIEWER_EMAIL=REVIEWER, EMAIL_LOGIN_REVIEWER_CODE=REVIEWER_CODE)
def test_reviewer_fixed_code_logs_in_and_sends_no_letter():
    provider = FakeEmailProvider()
    client = APIClient()
    with mock.patch("apps.notifications.services.get_email_provider", return_value=provider):
        assert _request(client, REVIEWER).status_code == 200
    assert provider.sent == []  # ящика у проверяющего нет — слать некуда

    resp = _verify(client, REVIEWER, code=REVIEWER_CODE)
    assert resp.status_code == 200, resp.content
    user = User.objects.get(email=REVIEWER)
    assert user.email_verified_at is not None


@override_settings(EMAIL_LOGIN_REVIEWER_EMAIL=REVIEWER, EMAIL_LOGIN_REVIEWER_CODE=REVIEWER_CODE)
def test_reviewer_verify_without_request_still_works():
    """Код проверяющего живёт в настройке, а не в кеше — истекать нечему."""
    client = APIClient()
    assert _verify(client, REVIEWER, code=REVIEWER_CODE).status_code == 200


@override_settings(EMAIL_LOGIN_REVIEWER_EMAIL=REVIEWER, EMAIL_LOGIN_REVIEWER_CODE=REVIEWER_CODE)
def test_reviewer_code_does_not_work_for_any_other_address():
    """ГЛАВНОЕ отличие от OTP_FIXED_CODE: код действует ровно для одного
    адреса, а не пускает под любым."""
    client = APIClient()
    email = "not-reviewer@example.com"
    assert _request(client, email).status_code == 200
    resp = _verify(client, email, code=REVIEWER_CODE)
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_invalid_code"


@override_settings(EMAIL_LOGIN_REVIEWER_EMAIL=REVIEWER, EMAIL_LOGIN_REVIEWER_CODE=REVIEWER_CODE)
def test_reviewer_wrong_code_is_rejected():
    client = APIClient()
    resp = _verify(client, REVIEWER, code="000000")
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_invalid_code"


def test_reviewer_path_is_off_when_settings_are_empty():
    """Дефолт (обе настройки пусты) — механизма нет: адрес обычный, письмо
    уходит, фиксированный код ревью не действует."""
    provider = FakeEmailProvider()
    client = APIClient()
    with mock.patch("apps.notifications.services.get_email_provider", return_value=provider):
        assert _request(client, REVIEWER).status_code == 200
    assert len(provider.sent) == 1
    resp = _verify(client, REVIEWER, code=REVIEWER_CODE)
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_invalid_code"


@override_settings(
    EMAIL_LOGIN_ENABLED=False,
    EMAIL_LOGIN_REVIEWER_EMAIL=REVIEWER,
    EMAIL_LOGIN_REVIEWER_CODE=REVIEWER_CODE,
)
def test_reviewer_login_is_closed_by_the_flag_too():
    client = APIClient()
    resp = _verify(client, REVIEWER, code=REVIEWER_CODE)
    assert resp.status_code == 403
    assert resp.data["code"] == "email_login_disabled"


# --- срок кода из письма (EMAIL_OTP_CODE_TTL_SECONDS, замечание 07.09) ------


def test_email_code_ttl_comes_from_setting():
    """Код в кеше живёт ровно EMAIL_OTP_CODE_TTL_SECONDS, а не телефонные
    5 минут: письмо идёт дольше SMS (замечание владельца 07.09)."""
    client = APIClient()
    with (
        override_settings(EMAIL_OTP_CODE_TTL_SECONDS=1234),
        mock.patch("apps.accounts.services.cache.set") as cache_set,
    ):
        assert _request(client, "ttl-setting@example.com").status_code == 200
    assert cache_set.call_args.kwargs["timeout"] == 1234


def test_email_code_ttl_default_is_fifteen_minutes():
    client = APIClient()
    with mock.patch("apps.accounts.services.cache.set") as cache_set:
        assert _request(client, "ttl-default@example.com").status_code == 200
    assert cache_set.call_args.kwargs["timeout"] == 15 * 60


def test_phone_code_ttl_is_not_touched_by_email_setting():
    """Телефонный TTL остаётся 5 минут — настройка почты его не трогает."""
    from apps.accounts import services

    with override_settings(EMAIL_OTP_CODE_TTL_SECONDS=60 * 60):
        assert services.OTP_CODE_TTL_SECONDS == 5 * 60
        assert services.email_otp_ttl_seconds() == 60 * 60


def test_login_letter_states_ttl_from_setting():
    """Число минут в письме = настройка, а не зашитая «5 минут»."""
    provider = FakeEmailProvider()
    client = APIClient()
    with (
        override_settings(EMAIL_OTP_CODE_TTL_SECONDS=15 * 60),
        mock.patch("apps.notifications.services.get_email_provider", return_value=provider),
    ):
        assert (
            _request(client, "ttl-letter@example.com", HTTP_ACCEPT_LANGUAGE="ru").status_code == 200
        )
    _address, message = provider.sent[-1]
    assert "Код действует 15 минут" in str(message["body"])


def test_email_verify_rate_limit_retry_after_uses_email_ttl():
    """Retry-After у 429 на /auth/email/verify — срок ПОЧТОВОГО кода."""
    client = APIClient()
    email = "ttl-retry@example.com"
    assert _request(client, email).status_code == 200
    with override_settings(EMAIL_OTP_CODE_TTL_SECONDS=600):
        for _ in range(6):
            resp = _verify(client, email, code="000000")
    assert resp.status_code == 429
    assert resp.data["code"] == "otp_rate_limited"
    assert resp["Retry-After"] == "600"


def test_email_request_no_dev_hint_in_production_profile(settings):
    """ADR-201, двойная защита: в production dev_hint не отдаётся даже при OTP_FIXED_CODE."""
    settings.OTP_FIXED_CODE = CODE
    settings.PRODUCTION_PROFILE = True
    client = APIClient()
    resp = _request(client, "login-prodhint@example.com")
    assert resp.status_code == 200, resp.content
    assert not resp.content
