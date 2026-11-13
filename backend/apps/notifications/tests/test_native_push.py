"""Нативный push-канал мобильной обёртки (ADR-176): регистрация токенов
устройств, отправка через RuStore/FCM/HMS, композит с Web Push.

Юрканал остаётся ЛК (`placed_in_cabinet_at`, ADR-057) — здесь только
дублирующий канал. Наружу тесты не ходят: `httpx.post` мокается на модуле
providers (тот же приём, что у apps.accounts.tests.test_real_google_oauth_provider
— `responses`/`respx` в dev-зависимостях нет).
"""

from __future__ import annotations

import json
from typing import Any
from unittest import mock

import httpx
import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.notifications import providers, selectors, services
from apps.notifications.models import DeviceToken, PushSubscription
from common import circuit

pytestmark = pytest.mark.django_db

TOKEN = "rustore-token-abc123"
APP_ID = "porukam.app"

MESSAGE: dict[str, object] = {
    "subject": "Этап «{milestone_title}» сдан",
    "body": "Договор «{contract_title}», {counterparty_name}, {amount} {currency}",
    "template": "milestone.submitted",
    "payload": {
        "milestone_title": "Плитка",
        "contract_title": "Ремонт кухни",
        "counterparty_name": "Иван Петров",
        "amount": "100.00",
        "currency": "RUB",
    },
    "contract_id": "01a02359-6ef5-7466-8712-ef63299b169a",
}


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-native-{suffix}", phone=f"+7999092{suffix}")


def _token(user: User, *, provider: str = "rustore", token: str = TOKEN) -> DeviceToken:
    return services.register_device_token(user, provider=provider, token=token, app_id=APP_ID)


def _response(status_code: int, *, json_body: Any = None, text: str = "") -> httpx.Response:
    request = httpx.Request("POST", "https://example.invalid/")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    return httpx.Response(status_code, text=text, request=request)


@pytest.fixture(autouse=True)
def _clean_provider_state():
    """Кэш access-токенов и счётчики circuit — состояние ПРОЦЕССА (module-level
    dict в обоих случаях): без сброса тест видит чужой токен и чужие счётчики."""
    providers._reset_access_tokens_for_tests()
    circuit._reset_for_tests()
    yield
    providers._reset_access_tokens_for_tests()
    circuit._reset_for_tests()


@pytest.fixture
def fcm_service_account(settings):
    """Настоящий RSA-ключ (2048 бит, генерируется на месте): JWT подписывается
    `cryptography`, и проверить путь «ключ -> assertion -> access_token» можно
    только на реальном ключе. В git секретов нет — ключ живёт один тест."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    settings.FCM_SERVICE_ACCOUNT_JSON = json.dumps(
        {
            "type": "service_account",
            "project_id": "fcm-proj",
            "client_email": "push@fcm-proj.iam.gserviceaccount.com",
            "private_key": pem,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )
    return settings


@pytest.fixture
def native_only(settings):
    """Нативный канал включён, Web Push — нет: get_push_provider отдаёт
    NativePushProvider в одиночку."""
    settings.NOTIFICATIONS_NATIVE_PUSH_PROVIDERS = "rustore,fcm,hms"
    settings.NOTIFICATIONS_PUSH_PROVIDER = "fake"
    settings.RUSTORE_PUSH_PROJECT_ID = "proj-1"
    settings.RUSTORE_PUSH_SERVICE_TOKEN = "svc-token"
    settings.HMS_APP_ID = "hms-app"
    settings.HMS_APP_SECRET = "hms-secret"
    settings.FCM_PROJECT_ID = "fcm-proj"
    return settings


# --- services ---------------------------------------------------------------


def test_register_is_idempotent_by_token():
    user = _user("001")
    first = _token(user)
    second = services.register_device_token(
        user, provider="fcm", token=TOKEN, app_id="porukam.rustore"
    )
    assert first.id == second.id
    assert DeviceToken.objects.count() == 1
    assert second.provider == "fcm"
    assert second.app_id == "porukam.rustore"


def test_register_reassigns_token_to_new_user():
    """Токен принадлежит УСТРОЙСТВУ: вошёл другой аккаунт — пуши получает он."""
    old, new = _user("002"), _user("003")
    _token(old)
    _token(new)
    assert DeviceToken.objects.get(token=TOKEN).user_id == new.id
    assert not selectors.list_device_tokens(old).exists()


def test_register_rejects_unknown_provider():
    with pytest.raises(services.UnknownPushProviderError):
        services.register_device_token(_user("004"), provider="apns", token=TOKEN, app_id=APP_ID)
    assert DeviceToken.objects.count() == 0


def test_register_rejects_empty_token():
    with pytest.raises(services.EmptyDeviceTokenError):
        services.register_device_token(_user("005"), provider="fcm", token="", app_id=APP_ID)
    assert DeviceToken.objects.count() == 0


def test_unregister_is_idempotent_and_scoped_to_owner():
    user, stranger = _user("006"), _user("007")
    _token(user)
    services.unregister_device_token(stranger, token=TOKEN)  # чужой — no-op
    assert DeviceToken.objects.count() == 1
    services.unregister_device_token(user, token=TOKEN)
    services.unregister_device_token(user, token=TOKEN)  # повторно — no-op
    assert DeviceToken.objects.count() == 0


def test_purge_personal_data_deletes_device_tokens():
    """ADR-169: токен адресует конкретный телефон — уходит вместе с аккаунтом,
    иначе на телефон ушедшего человека продолжали бы приходить пуши."""
    user = _user("008")
    _token(user)
    PushSubscription.objects.create(
        user=user, endpoint="https://push.example.com/x", p256dh="p", auth="a"
    )
    services.purge_personal_data(user.id)
    assert DeviceToken.objects.filter(user_id=user.id).count() == 0
    assert PushSubscription.objects.filter(user_id=user.id).count() == 0


# --- выбор провайдера -------------------------------------------------------


def test_provider_stays_webpush_without_native(settings):
    settings.NOTIFICATIONS_NATIVE_PUSH_PROVIDERS = ""
    settings.NOTIFICATIONS_PUSH_PROVIDER = "webpush"
    assert isinstance(providers.get_push_provider(), providers.WebPushProvider)


def test_provider_native_only_when_webpush_off(native_only):
    assert isinstance(providers.get_push_provider(), providers.NativePushProvider)


def test_provider_composite_when_both_on(native_only):
    native_only.NOTIFICATIONS_PUSH_PROVIDER = "webpush"
    provider = providers.get_push_provider()
    assert isinstance(provider, providers.CompositePushProvider)


def test_enabled_native_providers_drops_unknown_names(settings):
    settings.NOTIFICATIONS_NATIVE_PUSH_PROVIDERS = "rustore, apns ,fcm"
    assert providers.enabled_native_providers() == ("rustore", "fcm")


# --- NativePushProvider -----------------------------------------------------


def test_native_no_device_token(native_only):
    result = providers.NativePushProvider().send(_user("009"), MESSAGE)
    assert result.delivered is False
    assert result.status == "no_device_token"


def test_native_rustore_ok(native_only):
    user = _user("010")
    _token(user)
    with mock.patch.object(
        providers.httpx, "post", return_value=_response(200, json_body={})
    ) as post:
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is True
    assert result.status == "sent_1"
    assert result.provider_message_id == "native"
    assert circuit.states()["push_rustore"].successes == 1
    (url,) = post.call_args.args
    assert url == "https://vkpns.rustore.ru/v1/projects/proj-1/messages:send"
    assert post.call_args.kwargs["headers"] == {"Authorization": "Bearer svc-token"}


def test_native_payload_has_no_amounts_or_names(native_only):
    """ADR-110 п.4 / ADR-141 / ADR-180: через серверы RuStore/Google/Huawei
    проходит только {title, body, url} — ни суммы, ни имени контрагента;
    заголовок — название договора, тело — короткий subject (ADR-180)."""
    user = _user("011")
    _token(user)
    with mock.patch.object(
        providers.httpx, "post", return_value=_response(200, json_body={})
    ) as post:
        providers.NativePushProvider().send(user, MESSAGE)
    body = post.call_args.kwargs["json"]["message"]
    assert body["notification"] == {
        "title": "Ремонт кухни",
        "body": "Этап «Плитка» сдан",
    }
    assert body["data"] == {"url": "/contracts/01a02359-6ef5-7466-8712-ef63299b169a#stages"}
    raw = json.dumps(body, ensure_ascii=False)
    assert "100.00" not in raw and "Иван" not in raw and "RUB" not in raw


def test_native_rustore_404_deletes_dead_token(native_only):
    user = _user("012")
    _token(user)
    with mock.patch.object(providers.httpx, "post", return_value=_response(404, json_body={})):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "gone_rustore"
    assert DeviceToken.objects.count() == 0
    assert "push_rustore" not in circuit.states()  # мёртвый токен — не отказ провайдера


def test_native_rustore_invalid_registration_token_is_gone(native_only):
    """400 INVALID_ARGUMENT про registration token — приложение переустановлено."""
    user = _user("013")
    _token(user)
    response = _response(400, text='{"code":3,"message":"The registration token is not valid"}')
    with mock.patch.object(providers.httpx, "post", return_value=response):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.status == "gone_rustore"
    assert DeviceToken.objects.count() == 0


def test_native_error_keeps_token_and_records_failure(native_only):
    user = _user("014")
    _token(user)
    with mock.patch.object(providers.httpx, "post", return_value=_response(500, json_body={})):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "error_rustore"
    assert DeviceToken.objects.count() == 1  # сеть/5xx токен не убивает
    assert circuit.states()["push_rustore"].failures == 1


def test_native_network_error_is_provider_failure(native_only):
    user = _user("015")
    _token(user)
    with mock.patch.object(providers.httpx, "post", side_effect=httpx.ConnectError("boom")):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.status == "error_rustore"
    assert DeviceToken.objects.count() == 1


def test_native_disabled_provider_is_skipped_but_token_kept(settings):
    """RuStore выключен настройками — токен не трогаем: включат обратно, и
    устройство снова живо."""
    settings.NOTIFICATIONS_NATIVE_PUSH_PROVIDERS = "fcm"
    user = _user("016")
    _token(user, provider="rustore")
    with mock.patch.object(providers.httpx, "post") as post:
        result = providers.NativePushProvider().send(user, MESSAGE)
    post.assert_not_called()
    assert result.status == "no_device_token"
    assert DeviceToken.objects.count() == 1


def test_native_one_live_of_two_is_delivered(native_only):
    """Мёртвый токен из двух — доставлено (SMS-фолбэк не нужен, ADR-057)."""
    user = _user("017")
    _token(user, provider="rustore", token="dead-token")
    _token(user, provider="rustore", token="alive-token")

    def _post(url: str, **kwargs: Any) -> httpx.Response:
        token = kwargs["json"]["message"]["token"]
        return _response(200 if token == "alive-token" else 404, json_body={})

    with mock.patch.object(providers.httpx, "post", side_effect=_post):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is True
    assert result.status == "sent_1"
    assert list(DeviceToken.objects.values_list("token", flat=True)) == ["alive-token"]


def test_native_hms_invalid_token_is_gone(native_only):
    """HMS отвечает 200 всегда, реальный итог — в поле `code` (80300007)."""
    user = _user("018")
    _token(user, provider="hms", token="hms-token")
    responses = [
        _response(200, json_body={"access_token": "hms-access", "expires_in": 3600}),
        _response(200, json_body={"code": "80300007", "msg": "All tokens are invalid"}),
    ]
    with mock.patch.object(providers.httpx, "post", side_effect=responses):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.status == "gone_hms"
    assert DeviceToken.objects.count() == 0


def test_native_hms_ok_sends_data_as_json_string(native_only):
    """У HMS `data` — СТРОКА, а не объект: единственное отличие формата."""
    user = _user("019")
    _token(user, provider="hms", token="hms-token")
    responses = [
        _response(200, json_body={"access_token": "hms-access", "expires_in": 3600}),
        _response(200, json_body={"code": "80000000", "msg": "Success"}),
    ]
    with mock.patch.object(providers.httpx, "post", side_effect=responses) as post:
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is True and result.status == "sent_1"
    body = post.call_args.kwargs["json"]["message"]
    assert body["token"] == ["hms-token"]
    assert json.loads(body["data"]) == {
        "url": "/contracts/01a02359-6ef5-7466-8712-ef63299b169a#stages"
    }
    assert body["android"]["notification"]["click_action"] == {"type": 3}


def test_native_fcm_unregistered_is_gone(native_only, fcm_service_account):
    user = _user("020")
    _token(user, provider="fcm", token="fcm-token")
    responses = [
        _response(200, json_body={"access_token": "ya29.fake", "expires_in": 3600}),
        _response(404, json_body={"error": {"status": "UNREGISTERED"}}),
    ]
    with mock.patch.object(providers.httpx, "post", side_effect=responses):
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.status == "gone_fcm"
    assert DeviceToken.objects.count() == 0


def test_native_fcm_ok_signs_jwt_and_sends_high_priority(native_only, fcm_service_account):
    """Токен сервисного аккаунта добывается своим JWT (google-auth в
    зависимостях нет): проверяем, что подпись сложилась и заголовок доехал."""
    user = _user("021")
    _token(user, provider="fcm", token="fcm-token")
    responses = [
        _response(200, json_body={"access_token": "ya29.fake", "expires_in": 3600}),
        _response(200, json_body={"name": "projects/fcm-proj/messages/1"}),
    ]
    with mock.patch.object(providers.httpx, "post", side_effect=responses) as post:
        result = providers.NativePushProvider().send(user, MESSAGE)
    assert result.delivered is True
    token_call, send_call = post.call_args_list
    assert token_call.args[0] == "https://oauth2.googleapis.com/token"
    assert token_call.kwargs["data"]["grant_type"] == (
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
    assert token_call.kwargs["data"]["assertion"].count(".") == 2
    assert send_call.args[0] == ("https://fcm.googleapis.com/v1/projects/fcm-proj/messages:send")
    assert send_call.kwargs["headers"] == {"Authorization": "Bearer ya29.fake"}
    assert send_call.kwargs["json"]["message"]["android"] == {"priority": "high"}


def test_native_fcm_without_keys_is_error_not_crash(native_only):
    """Провайдер включён, ключей нет — отказ провайдера, а не исключение
    посреди рассылки (упавшая задача не разослала бы остальным)."""
    native_only.FCM_SERVICE_ACCOUNT_JSON = ""
    user = _user("022")
    _token(user, provider="fcm", token="fcm-token")
    with mock.patch.object(providers.httpx, "post") as post:
        result = providers.NativePushProvider().send(user, MESSAGE)
    post.assert_not_called()
    assert result.status == "error_fcm"
    assert DeviceToken.objects.count() == 1


# --- CompositePushProvider --------------------------------------------------


def _composite(native_only):
    native_only.NOTIFICATIONS_PUSH_PROVIDER = "webpush"
    native_only.WEBPUSH_VAPID_PRIVATE_KEY = "priv"
    native_only.WEBPUSH_VAPID_CONTACT = "support@example.com"
    return providers.get_push_provider()


def test_composite_delivers_both_channels(native_only):
    user = _user("023")
    _token(user)
    PushSubscription.objects.create(
        user=user, endpoint="https://push.example.com/one", p256dh="p", auth="a"
    )
    provider = _composite(native_only)
    with (
        mock.patch.object(providers.httpx, "post", return_value=_response(200, json_body={})),
        mock.patch("pywebpush.webpush"),
    ):
        result = provider.send(user, MESSAGE)
    assert result.delivered is True
    assert result.status == "native_sent1+web_sent1"


def test_composite_web_only_when_no_device_token(native_only):
    user = _user("024")
    PushSubscription.objects.create(
        user=user, endpoint="https://push.example.com/two", p256dh="p", auth="a"
    )
    provider = _composite(native_only)
    with (
        mock.patch.object(providers.httpx, "post") as post,
        mock.patch("pywebpush.webpush"),
    ):
        result = provider.send(user, MESSAGE)
    post.assert_not_called()
    assert result.delivered is True
    assert result.status == "native_none+web_sent1"


def test_composite_native_only_when_no_subscription(native_only):
    user = _user("025")
    _token(user)
    provider = _composite(native_only)
    with mock.patch.object(providers.httpx, "post", return_value=_response(200, json_body={})):
        result = provider.send(user, MESSAGE)
    assert result.delivered is True
    assert result.status == "native_sent1+web_none"
    assert result.provider_message_id == "native"


def test_composite_neither_channel(native_only):
    user = _user("026")
    provider = _composite(native_only)
    result = provider.send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "native_none+web_none"


def test_composite_status_fits_delivery_attempt_column(native_only):
    """`DeliveryAttempt.status` — CharField(32); склеенный статус обязан
    помещаться, иначе запись попытки упала бы уже ПОСЛЕ доставки."""
    from apps.notifications.models import DeliveryAttempt

    max_length = DeliveryAttempt._meta.get_field("status").max_length
    native = providers._short_status("error_rustore")
    web = providers._short_status("no_subscription")
    worst = f"native_{native}+web_{web}"
    assert len(worst) <= max_length
    assert len("native_sent99+web_sent99") <= max_length


# --- HTTP-слой --------------------------------------------------------------


def test_device_tokens_require_authentication():
    client = APIClient()
    assert client.post("/v1/device-tokens", {}, format="json").status_code == 401
    assert client.post("/v1/device-tokens/unregister", {}, format="json").status_code == 401


def test_device_token_register_http():
    user = _user("027")
    client = APIClient()
    client.force_authenticate(user=user)
    body = {"provider": "rustore", "token": TOKEN, "app_id": APP_ID, "platform": "android"}
    resp = client.post("/v1/device-tokens", body, format="json")
    assert resp.status_code == 201, resp.content
    assert set(resp.data) == {"id", "provider", "app_id", "platform", "created_at"}
    assert resp.data["provider"] == "rustore"
    assert resp.data["app_id"] == APP_ID
    assert resp.data["platform"] == "android"
    # Сам токен в ответе не повторяем — он у клиента уже есть.
    assert TOKEN not in json.dumps(resp.data, default=str)
    row = DeviceToken.objects.get(token=TOKEN)
    assert row.user_id == user.id

    # Повторная регистрация того же токена — снова 201, без дублей.
    again = client.post("/v1/device-tokens", body, format="json")
    assert again.status_code == 201
    assert DeviceToken.objects.count() == 1
    assert again.data["id"] == resp.data["id"]


def test_device_token_register_reassigns_owner_http():
    old, new = _user("028"), _user("029")
    body = {"provider": "fcm", "token": TOKEN, "app_id": APP_ID, "platform": "android"}
    for user in (old, new):
        client = APIClient()
        client.force_authenticate(user=user)
        assert client.post("/v1/device-tokens", body, format="json").status_code == 201
    assert DeviceToken.objects.count() == 1
    assert DeviceToken.objects.get(token=TOKEN).user_id == new.id


def test_device_token_platform_defaults_to_android():
    user = _user("030")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.post(
        "/v1/device-tokens",
        {"provider": "hms", "token": TOKEN, "app_id": APP_ID},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["platform"] == "android"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (
            {"provider": "apns", "token": TOKEN, "app_id": APP_ID},
            "unknown_push_provider",
        ),
        ({"provider": "fcm", "token": "", "app_id": APP_ID}, "empty_device_token"),
    ],
)
def test_device_token_register_422(body, code):
    user = _user("031")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.post("/v1/device-tokens", body, format="json")
    assert resp.status_code == 422, resp.content
    assert resp.json()["code"] == code
    assert DeviceToken.objects.count() == 0


def test_device_token_unregister_http():
    user, stranger = _user("032"), _user("033")
    _token(user)
    client = APIClient()
    client.force_authenticate(user=stranger)
    # Чужой токен — 204, но не удалён (существование чужих устройств не
    # раскрываем и удалить их нельзя).
    assert (
        client.post("/v1/device-tokens/unregister", {"token": TOKEN}, format="json").status_code
        == 204
    )
    assert DeviceToken.objects.count() == 1

    client.force_authenticate(user=user)
    assert (
        client.post("/v1/device-tokens/unregister", {"token": TOKEN}, format="json").status_code
        == 204
    )
    assert DeviceToken.objects.count() == 0
    # Повторно — тоже 204.
    assert (
        client.post("/v1/device-tokens/unregister", {"token": TOKEN}, format="json").status_code
        == 204
    )
