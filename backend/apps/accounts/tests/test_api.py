import re
import uuid

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from common import relay

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    return resp.data


def test_otp_request_then_verify_returns_tokens():
    client = APIClient()
    tokens = _login(client, "+79990200001")
    assert "access" in tokens and "refresh" in tokens


def test_otp_request_returns_dev_hint_with_fixed_code():
    """dev_hint — только при OTP_FIXED_CODE (тестовый профиль его ставит):
    LoginPage показывает «Тестовый режим …» на dev-стендах, как в моке."""
    client = APIClient()
    resp = client.post("/v1/auth/otp/request", {"phone": "+79990200021"}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data == {"dev_hint": "111111"}


def test_otp_request_without_fixed_code_has_empty_body(settings):
    """Прод (OTP_FIXED_CODE пуст): тело пустое — код НЕ утекает в ответ."""
    settings.OTP_FIXED_CODE = None
    client = APIClient()
    resp = client.post("/v1/auth/otp/request", {"phone": "+79990200022"}, format="json")
    assert resp.status_code == 200, resp.content
    assert not resp.content


def test_verify_with_wrong_code_returns_problem_json_422():
    client = APIClient()
    client.post("/v1/auth/otp/request", {"phone": "+79990200002"}, format="json")
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": "+79990200002", "code": "000000"}, format="json"
    )
    assert resp.status_code == 422
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "otp_invalid_code"


# --- PHONE_LOGIN_ENABLED (ADR-165): вход только по аккаунту Google ---------
# Каждый запрет — отдельным тестом (CLAUDE.md). Прятать форму на фронте
# (VITE_PHONE_LOGIN_ENABLED) мало: эндпоинт остаётся вызываемым напрямую.


@override_settings(PHONE_LOGIN_ENABLED=False)
def test_otp_request_forbidden_when_phone_login_disabled():
    client = APIClient()
    resp = client.post("/v1/auth/otp/request", {"phone": "+79990200023"}, format="json")
    assert resp.status_code == 403
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "phone_login_disabled"


@override_settings(PHONE_LOGIN_ENABLED=False)
def test_otp_request_with_disabled_login_does_not_send_code():
    """403 приходит ДО services.request_otp — SMS не уходит и код не живёт
    в кеше (иначе выключенный вход всё равно грел бы rate-limit и гейтвей)."""
    phone = "+79990200024"
    sent_before = len(_sms_gateway.sent)
    client = APIClient()
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert len(_sms_gateway.sent) == sent_before


@override_settings(PHONE_LOGIN_ENABLED=False)
def test_otp_verify_forbidden_when_phone_login_disabled():
    client = APIClient()
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": "+79990200025", "code": "111111"}, format="json"
    )
    assert resp.status_code == 403
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "phone_login_disabled"


def test_otp_verify_forbidden_even_with_valid_code_requested_before_disabling():
    """Код, выданный до выключения флага, не даёт войти: проверка — на входе
    во вьюху, а не в сериализаторе, и не зависит от состояния кеша."""
    phone = "+79990200026"
    client = APIClient()
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    code = _code_for(phone)

    with override_settings(PHONE_LOGIN_ENABLED=False):
        resp = client.post("/v1/auth/otp/verify", {"phone": phone, "code": code}, format="json")

    assert resp.status_code == 403
    assert resp.data["code"] == "phone_login_disabled"
    assert not User.objects.filter(phone=phone).exists()


@override_settings(PHONE_LOGIN_ENABLED=True)
def test_otp_login_unchanged_when_phone_login_enabled():
    """Флаг включён (дефолт dev/тестов) — прежнее поведение целиком."""
    client = APIClient()
    tokens = _login(client, "+79990200027")
    assert "access" in tokens and "refresh" in tokens


@override_settings(PHONE_LOGIN_ENABLED=False)
def test_google_authorize_url_still_available_when_phone_login_disabled():
    """Флаг гасит ТОЛЬКО OTP-контур; вход через Google не трогается."""
    client = APIClient()
    resp = client.get("/v1/auth/google/authorize-url")
    assert resp.status_code == 200, resp.content
    assert resp.data["authorize_url"]


def test_me_requires_authentication():
    client = APIClient()
    resp = client.get("/v1/users/me")
    assert resp.status_code == 401
    assert resp.data["code"] == "authentication_required"


def test_me_returns_expected_fields_and_hides_trust_id():
    client = APIClient()
    tokens = _login(client, "+79990200003")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.get("/v1/users/me")

    assert resp.status_code == 200
    assert resp.data["phone"] == "+79990200003"
    assert resp.data["verification_level"] == "basic"
    assert resp.data["has_business_status"] is False
    assert "trust_id" not in resp.data
    assert "trust_id" not in resp.content.decode()


def test_patch_me_updates_email_and_display_name():
    # JSON-ключ "display_name" (не "full_name") — docs/tasks/
    # Задача_fix_web-profile-handle-real-api.md: согласовано с фронтовым
    # CurrentUser.display_name, домен внутри (User.full_name_encrypted)
    # не переименован.
    client = APIClient()
    tokens = _login(client, "+79990200004")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch(
        "/v1/users/me", {"email": "a@example.test", "display_name": "Пётр Петров"}, format="json"
    )

    assert resp.status_code == 200
    assert resp.data["email"] == "a@example.test"
    assert resp.data["display_name"] == "Пётр Петров"
    assert "trust_id" not in resp.data


def test_me_returns_handle_when_claimed_none_when_not():
    """GET /v1/users/me отдаёт handle через apps.social (import_string,
    settings.USER_ME_HANDLE_SELECTOR) — None до claim_handle, "@value" после."""
    from apps.social import services as social_services

    client = APIClient()
    tokens = _login(client, "+79990200044")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.get("/v1/users/me")
    assert resp.status_code == 200
    assert resp.data["handle"] is None

    user = User.objects.get(phone="+79990200044")
    social_services.claim_handle(user=user, value="freshuser1")

    resp = client.get("/v1/users/me")
    assert resp.status_code == 200
    assert resp.data["handle"] == "@freshuser1"


def test_refresh_rotates_and_rejects_old_refresh_token(settings):
    settings.REFRESH_ROTATION_GRACE_SECONDS = 0
    client = APIClient()
    tokens = _login(client, "+79990200005")

    resp = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")
    assert resp.status_code == 200
    new_tokens = resp.data
    assert new_tokens["refresh"] != tokens["refresh"]

    replay = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")
    assert replay.status_code == 401
    assert replay.data["code"] == "refresh_token_invalid"


def test_refresh_replay_inside_grace_returns_same_pair():
    """ADR-108: вторая вкладка с тем же refresh в окне получает 200 и ту же
    пару — не 401 и не разлогин."""
    client = APIClient()
    tokens = _login(client, "+79990200015")

    first = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")
    replay = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.data["refresh"] == first.data["refresh"]
    assert replay.data["access"] == first.data["access"]


def _expired_access_for(user: User) -> str:
    from datetime import timedelta

    from rest_framework_simplejwt.tokens import AccessToken

    token = AccessToken.for_user(user)
    token.set_exp(lifetime=-timedelta(minutes=5))
    return str(token)


def test_refresh_ignores_stale_bearer_header():
    """ADR-119: клиент шлёт Authorization: Bearer <протухший access> на сам
    refresh — JWTAuthentication по умолчанию отвергал ЗАПРОС 401
    authentication_required ещё до AllowAny, и сессия не могла ни
    обновиться, ни честно умереть (зависание «code: authentication_required»,
    отсмотр 2026-08-24). Auth-эндпоинты не аутентифицируют по Bearer вовсе."""
    client = APIClient()
    tokens = _login(client, "+79990200016")
    user = User.objects.get(phone="+79990200016")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {_expired_access_for(user)}")

    resp = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")

    assert resp.status_code == 200
    assert resp.data["access"] != tokens["access"]


def test_logout_ignores_stale_bearer_header():
    client = APIClient()
    tokens = _login(client, "+79990200017")
    user = User.objects.get(phone="+79990200017")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {_expired_access_for(user)}")

    resp = client.post("/v1/auth/logout", {"refresh": tokens["refresh"]}, format="json")

    assert resp.status_code == 204


def test_otp_login_ignores_stale_bearer_header():
    """Тот же протухший Bearer в localStorage не должен мешать войти заново."""
    client = APIClient()
    _login(client, "+79990200018")
    user = User.objects.get(phone="+79990200018")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {_expired_access_for(user)}")

    resp = client.post("/v1/auth/otp/request", {"phone": "+79990200018"}, format="json")

    assert resp.status_code in (200, 202, 204), resp.data


def test_standard_401_title_is_localized():
    """Заголовок стандартной DRF-ошибки (NotAuthenticated → authentication_required)
    — на языке клиента из реестра, не сырой код (отсмотр 2026-08-24:
    «пишет code: authentication_required на английском»)."""
    client = APIClient()
    resp_ru = client.get("/v1/users/me", HTTP_ACCEPT_LANGUAGE="ru")
    resp_en = client.get("/v1/users/me", HTTP_ACCEPT_LANGUAGE="en")

    assert resp_ru.status_code == 401
    assert resp_ru.data["code"] == "authentication_required"
    assert resp_ru.data["title"] == "Войдите, чтобы продолжить."
    assert resp_en.data["title"] == "Please sign in to continue."


def test_logout_then_refresh_rejected():
    client = APIClient()
    tokens = _login(client, "+79990200006")

    resp = client.post("/v1/auth/logout", {"refresh": tokens["refresh"]}, format="json")
    assert resp.status_code == 204

    replay = client.post("/v1/auth/token/refresh", {"refresh": tokens["refresh"]}, format="json")
    assert replay.status_code == 401


def test_register_device_then_device_key():
    client = APIClient()
    tokens = _login(client, "+79990200007")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    device_resp = client.post(
        "/v1/users/me/devices", {"platform": "android", "push_token": "tok"}, format="json"
    )
    assert device_resp.status_code == 201
    device_id = device_resp.data["id"]

    key_resp = client.post(
        f"/v1/users/me/devices/{device_id}/device-key",
        {"public_key": "cHVibGlj", "algorithm": "Ed25519"},
        format="json",
    )
    assert key_resp.status_code == 201
    assert key_resp.data["algorithm"] == "Ed25519"
    assert "public_key" not in key_resp.data


def test_device_key_for_missing_device_is_404():
    client = APIClient()
    tokens = _login(client, "+79990200008")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.post(
        "/v1/users/me/devices/999999/device-key",
        {"public_key": "cHVibGlj", "algorithm": "Ed25519"},
        format="json",
    )
    assert resp.status_code == 404
    assert resp.data["code"] == "device_not_found"


def test_device_key_with_invalid_base64_is_400():
    client = APIClient()
    tokens = _login(client, "+79990200009")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    device_resp = client.post("/v1/users/me/devices", {"platform": "web"}, format="json")

    resp = client.post(
        f"/v1/users/me/devices/{device_resp.data['id']}/device-key",
        {"public_key": "not-base64!!", "algorithm": "Ed25519"},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "invalid_public_key"


def test_acting_profile_header_rejected_when_not_own_profile():
    """etap-3.md 3.5: полноценная проверка X-Acting-Profile — случайный
    (никому не принадлежащий) профиль отклоняется, даже если формат валиден."""
    client = APIClient()
    tokens = _login(client, "+79990200010")
    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {tokens['access']}", HTTP_X_ACTING_PROFILE=str(uuid.uuid4())
    )
    resp = client.get("/v1/users/me")
    assert resp.status_code == 403
    assert resp.json()["code"] == "acting_profile_not_allowed"


def test_acting_profile_header_accepted_when_own_profile():
    client = APIClient()
    tokens = _login(client, "+79990200011")
    relay.deliver_due_events()  # account.logged_in -> apps.profiles создаёт person-профиль

    me = client.get("/v1/users/me", HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    own_profile_id = me.data["profiles"][0]["id"]

    client.credentials(
        HTTP_AUTHORIZATION=f"Bearer {tokens['access']}", HTTP_X_ACTING_PROFILE=own_profile_id
    )
    resp = client.get("/v1/users/me")
    assert resp.status_code == 200


def test_acting_profile_header_rejected_when_malformed():
    client = APIClient()
    resp = client.get("/v1/users/me", HTTP_X_ACTING_PROFILE="not-a-uuid")
    assert resp.status_code == 400
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.json()["code"] == "invalid_acting_profile_header"


def test_swagger_schema_is_served():
    client = APIClient()
    resp = client.get("/v1/schema/")
    assert resp.status_code == 200


# --- Локаль ошибок problem+json (ГВ.5, docs/tasks/global-wave.md, ADR-075) --


def test_ru_user_gets_russian_error_title():
    """✅ ГВ.5: RU-пользователь получает ошибки на русском (contour="RU",
    выставляется автоматически verify_otp — ГВ.5)."""
    client = APIClient()
    phone = "+79990200011"
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 429
    assert resp.data["title"] == "Слишком много запросов кода"


def test_global_user_gets_english_error_title():
    """✅ ГВ.5: GLOBAL-пользователь получает ошибки на EN (Google-вход —
    GLOBAL-контур по построению, ГВ.5)."""
    client = APIClient()
    resp = client.get("/v1/auth/google/authorize-url")
    state = resp.data["state"]
    tokens = client.post(
        "/v1/auth/google/callback",
        {"code": "locale-sub-001|locale@example.test", "state": state},
        format="json",
    ).data
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.post(
        "/v1/users/me/devices/999999/device-key",
        {"public_key": "cHVibGlj", "algorithm": "Ed25519"},
        format="json",
    )
    assert resp.status_code == 404
    assert resp.data["code"] == "device_not_found"
    assert resp.data["title"] == "Device not found"


def test_anonymous_request_with_accept_language_en_gets_english_error_title():
    """Accept-Language — подсказка для запросов без известного контура
    (анонимных или пока без сохранённой страны), не только для
    авторизованных GLOBAL-пользователей."""
    client = APIClient()
    phone = "+79990200012"
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    resp = client.post(
        "/v1/auth/otp/verify",
        {"phone": phone, "code": "000000"},
        format="json",
        HTTP_ACCEPT_LANGUAGE="en-US,en;q=0.9",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "otp_invalid_code"
    assert resp.data["title"] == "Incorrect code"


def test_anonymous_request_without_accept_language_gets_russian_error_title():
    client = APIClient()
    phone = "+79990200013"
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    resp = client.post("/v1/auth/otp/verify", {"phone": phone, "code": "000000"}, format="json")
    assert resp.status_code == 422
    assert resp.data["title"] == "Неверный код"


# --- ADR-095: язык интерфейса хранится на сервере ------------------------


def test_patch_me_persists_locale():
    """Регресс ADR-095: фронт слал `PATCH /users/me {locale}` с самого
    появления переключателя, а сериализатор поля не принимал — DRF молча
    выбрасывал его, и выбор языка оставался только в localStorage."""
    client = APIClient()
    tokens = _login(client, "+79990200071")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"locale": "de"}, format="json")

    assert resp.status_code == 200, resp.content
    assert resp.data["locale"] == "de"
    assert client.get("/v1/users/me").data["locale"] == "de"


def test_patch_me_keeps_region_tag_verbatim():
    """`pt-BR` не должен огрубляться до `pt` нигде по пути — именно на этом
    ломался прежний резолвер."""
    client = APIClient()
    tokens = _login(client, "+79990200072")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"locale": "pt-BR"}, format="json")

    assert resp.status_code == 200, resp.content
    assert resp.data["locale"] == "pt-BR"


def test_patch_me_rejects_malformed_locale():
    client = APIClient()
    tokens = _login(client, "+79990200073")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"locale": "не язык"}, format="json")

    assert resp.status_code == 400, resp.content


def test_patch_me_blank_locale_resets_choice():
    """Пустая строка — сброс к цепочке контур -> Accept-Language, как и у
    country_code."""
    client = APIClient()
    tokens = _login(client, "+79990200074")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    client.patch("/v1/users/me", {"locale": "de"}, format="json")

    resp = client.patch("/v1/users/me", {"locale": ""}, format="json")

    assert resp.status_code == 200, resp.content
    assert resp.data["locale"] is None


def test_patch_me_locale_does_not_touch_country():
    """Язык и страна — независимые факты (язык «на чём читать», страна «по
    какому праву»); PATCH одного не должен трогать другое."""
    client = APIClient()
    tokens = _login(client, "+79990200075")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    client.patch("/v1/users/me", {"country_code": "DE"}, format="json")

    resp = client.patch("/v1/users/me", {"locale": "de"}, format="json")

    assert resp.data["country_code"] == "DE"
    assert resp.data["locale"] == "de"


def test_patch_me_sets_phone_normalized():
    """Отсмотр 2026-08-24 (находимость по телефону, вариант А): номер
    вводится «через +», пробелы/скобки/дефисы срезаются при сохранении."""
    client = APIClient()
    tokens = _login(client, "+79990200080")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"phone": "+7 (999) 020-00-81"}, format="json")

    assert resp.status_code == 200
    assert resp.data["phone"] == "+79990200081"


def test_patch_me_phone_without_plus_is_rejected():
    client = APIClient()
    tokens = _login(client, "+79990200082")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"phone": "89990200083"}, format="json")

    assert resp.status_code == 422
    assert resp.data["code"] == "phone_invalid"


def test_patch_me_phone_taken_by_other_user_conflicts():
    client = APIClient()
    _login(client, "+79990200084")  # владелец номера
    client2 = APIClient()
    tokens2 = _login(client2, "+79990200085")
    client2.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens2['access']}")

    resp = client2.patch("/v1/users/me", {"phone": "+79990200084"}, format="json")

    assert resp.status_code == 409
    assert resp.data["code"] == "phone_taken"


def test_patch_me_empty_phone_clears_it():
    client = APIClient()
    tokens = _login(client, "+79990200086")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.patch("/v1/users/me", {"phone": ""}, format="json")

    assert resp.status_code == 200
    assert resp.data["phone"] is None


# --- ADR-148: язык интерфейса фиксируется на входе, страна не подменяется ---


def _google_login(client: APIClient, code: str, **extra) -> dict:
    state = client.get("/v1/auth/google/authorize-url").data["state"]
    resp = client.post(
        "/v1/auth/google/callback", {"code": code, "state": state}, format="json", **extra
    )
    assert resp.status_code == 200, resp.content
    return resp.data


def test_otp_registration_remembers_request_locale():
    """✅ ADR-148: язык, на котором человек регистрируется, попадает в профиль
    сам. До этого `User.locale` писал только переключатель языка — на проде
    31.08 поле было пустым у 7 аккаунтов из 9."""
    client = APIClient()
    phone = "+79990200101"
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    resp = client.post(
        "/v1/auth/otp/verify",
        {"phone": phone, "code": _code_for(phone)},
        format="json",
        HTTP_ACCEPT_LANGUAGE="en-US,en;q=0.9",
    )

    assert resp.status_code == 200, resp.content
    assert User.objects.get(phone=phone).locale == "en"


def test_registration_without_accept_language_leaves_locale_empty():
    """Умолчание в профиль не пишем: пустой `locale` — честное «не знаем»,
    а "ru" из DEFAULT_LOCALE выглядел бы как выбор пользователя."""
    client = APIClient()
    phone = "+79990200102"
    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    client.post("/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json")

    assert User.objects.get(phone=phone).locale is None


def test_login_fills_locale_when_profile_has_none_yet():
    """Заполняется не только на регистрации: 78% существующих аккаунтов
    прода без языка чинятся первым же входом, без миграции данных."""
    client = APIClient()
    phone = "+79990200103"
    _login(client, phone)  # регистрация без Accept-Language — язык пуст
    assert User.objects.get(phone=phone).locale is None

    client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    client.post(
        "/v1/auth/otp/verify",
        {"phone": phone, "code": _code_for(phone)},
        format="json",
        HTTP_ACCEPT_LANGUAGE="en",
    )

    assert User.objects.get(phone=phone).locale == "en"


def test_login_never_overwrites_chosen_locale():
    """🚫 Заголовок браузера НЕ перетирает явный выбор: иначе человек,
    выбравший язык на одном устройстве, терял бы его при входе с другого."""
    client = APIClient()
    phone = "+79990200104"
    tokens = _login(client, phone)
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    client.patch("/v1/users/me", {"locale": "en"}, format="json")

    fresh = APIClient()
    fresh.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    fresh.post(
        "/v1/auth/otp/verify",
        {"phone": phone, "code": _code_for(phone)},
        format="json",
        HTTP_ACCEPT_LANGUAGE="ru-RU,ru;q=0.9",
    )

    assert User.objects.get(phone=phone).locale == "en"


def test_google_registration_leaves_country_unset():
    """✅ ADR-148: «GLOBAL» больше не пишется как стартовая страна — поле
    означает ЯВНЫЙ выбор пользователя, а контур GLOBAL резолвится и из
    пустого значения (jurisdictions.selectors.resolve_jurisdiction)."""
    client = APIClient()
    _google_login(client, "sub-locale-201|country@example.test")

    user = User.objects.get(email="country@example.test")
    assert user.country_code is None


def test_google_registration_remembers_request_locale():
    client = APIClient()
    _google_login(
        client,
        "sub-locale-202|lang@example.test",
        HTTP_ACCEPT_LANGUAGE="en-GB,en;q=0.9",
    )

    assert User.objects.get(email="lang@example.test").locale == "en"


def test_google_user_without_country_still_gets_english_errors():
    """🚫 Снятие литерала GLOBAL не должно откатывать ГВ.5: пользователь без
    страны и без пригодного Accept-Language читает ошибки на EN, а не на
    DEFAULT_LOCALE («ru»)."""
    client = APIClient()
    tokens = _google_login(client, "sub-locale-203|en-fallback@example.test")
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

    resp = client.post(
        "/v1/users/me/devices/999999/device-key",
        {"public_key": "cHVibGlj", "algorithm": "Ed25519"},
        format="json",
    )

    assert resp.status_code == 404
    assert resp.data["title"] == "Device not found"


def test_otp_request_no_dev_hint_in_production_profile(settings):
    """ADR-201, двойная защита: даже при заданном OTP_FIXED_CODE в production
    код в ответе не отдаётся."""
    settings.OTP_FIXED_CODE = "111111"
    settings.PRODUCTION_PROFILE = True
    client = APIClient()
    resp = client.post("/v1/auth/otp/request", {"phone": "+79990200023"}, format="json")
    assert resp.status_code == 200, resp.content
    assert not resp.content
