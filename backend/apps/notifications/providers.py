"""Интерфейсы push/email/SMS-провайдеров + фейковые реализации (CLAUDE.md:
«внешние провайдеры — только интерфейсы + фейки»; docs/tasks/fundament.md
ЭФ.4 явно исключает реальные интеграции из фундамента).

Юридический канал — placed_in_cabinet_at (см. models.py); эти провайдеры —
ТОЛЬКО дублирующие каналы (push — «звонок в дверь», email — по желанию
пользователя, SMS — fallback на финальной точке серии напоминаний,
domain-model.md §17). services.py не знает деталей конкретного провайдера —
только протоколов ниже."""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from html import escape as html_escape
from typing import Any, Protocol

import httpx
from django.conf import settings

from apps.accounts import selectors as accounts_selectors
from apps.accounts.models import User
from common import circuit

from .email_texts import meta_label, open_cabinet_label, open_deal_label, unsubscribe_hint


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    delivered: bool
    provider_message_id: str
    status: str


class PushProvider(Protocol):
    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult: ...


class EmailProvider(Protocol):
    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult: ...

    def send_to_address(self, email: str, message: dict[str, object]) -> DeliveryResult:
        """Письмо на АДРЕС, а не получателю-User (ADR-168): код входа по
        e-mail уходит до того, как пользователь существует (первый вход =
        регистрация), и User-а для него взять неоткуда. Отдельный метод, а
        не `recipient=None` у send(): у уведомления получатель обязателен —
        от него зависят язык, настройки каналов и запись DeliveryAttempt."""
        ...


class SmsProvider(Protocol):
    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult: ...


class FakePushProvider:
    """Детерминированный фейк: «доставлено», только если у получателя есть
    хотя бы одно устройство с непустым push_token (apps.accounts.UserDevice,
    читается через accounts_selectors.has_active_push_device — не напрямую)."""

    provider_code = "push_fake"

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        circuit.record_success(self.provider_code)
        if accounts_selectors.has_active_push_device(recipient):
            return DeliveryResult(delivered=True, provider_message_id="fake-push", status="sent")
        return DeliveryResult(delivered=False, provider_message_id="", status="no_active_device")


class WebPushProvider:
    """Реальный Web Push (ADR-110, pywebpush): рассылка по всем
    `PushSubscription` получателя. Полезная нагрузка минимальна — заголовок и
    текст шаблона БЕЗ подстановок (render_subject/render_body не
    интерполируют payload) плюс маршрут для клика: ни сумм, ни имён, ни
    номеров договоров через сторонние push-сервисы не проходит.

    404/410 от push-сервиса = браузер отозвал подписку — строка удаляется
    (чистка по месту, отдельного sweep не нужно). `delivered=True`, если
    доставлена хотя бы одна подписка: этого достаточно, чтобы «звонок в
    дверь» состоялся (и чтобы не сработал SMS-фолбэк, ADR-057)."""

    provider_code = "webpush"

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        # Импорт по месту: pywebpush нужен только этому провайдеру — фейковый
        # контур (tests/dev без NOTIFICATIONS_PUSH_PROVIDER=webpush) не должен
        # требовать установленный пакет для импорта модуля.
        from pywebpush import WebPushException, webpush

        from . import selectors as notification_selectors

        subscriptions = list(notification_selectors.list_push_subscriptions(recipient))
        if not subscriptions:
            return DeliveryResult(delivered=False, provider_message_id="", status="no_subscription")

        data = json.dumps(push_payload(message, recipient=recipient), ensure_ascii=False)
        delivered = 0
        last_error = ""
        for subscription in subscriptions:
            try:
                webpush(
                    subscription_info={
                        "endpoint": subscription.endpoint,
                        "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                    },
                    data=data,
                    vapid_private_key=settings.WEBPUSH_VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": f"mailto:{settings.WEBPUSH_VAPID_CONTACT}"},
                    ttl=int(settings.WEBPUSH_TTL_SECONDS),
                    # Urgency (RFC 8030 §5.3). Без заголовка push-сервис считает
                    # срочность "normal", а Android в Doze такие сообщения копит и
                    # отдаёт браузеру, когда тот сам проснётся: владелец 10.09 —
                    # «пуш живой, приходит при запуске приложения», причём Chrome
                    # был «без ограничений» по батарее. "high" просит разбудить
                    # устройство сейчас; это наш потолок — "very-low"/"low" для
                    # фоновой синхронизации, а не для уведомления, которое человек
                    # должен увидеть. Гарантий ОС всё равно не даёт, но без
                    # заголовка их не было вовсе.
                    headers={"Urgency": settings.WEBPUSH_URGENCY},
                )
                delivered += 1
            except WebPushException as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code in (404, 410):
                    # Подписка мертва (браузер отозвал/переустановил SW).
                    subscription.delete()
                    last_error = f"gone_{status_code}"
                else:
                    circuit.record_failure(self.provider_code)
                    last_error = f"error_{status_code or 'network'}"

        if delivered:
            circuit.record_success(self.provider_code)
            return DeliveryResult(
                delivered=True, provider_message_id="webpush", status=f"sent_{delivered}"
            )
        return DeliveryResult(
            delivered=False, provider_message_id="", status=last_error or "failed"
        )


# ── Нативный push-канал мобильной обёртки (ADR-176) ─────────────────────────
# Web Push (выше) доставляет только через браузер: закрытый тест Play показал,
# что Samsung Internet подписку не отрабатывает, а телефоны без сервисов Google
# не получают Web Push ни в одном браузере. Обёртка получает токен нативного
# провайдера (RuStore Push / FCM / HMS Push Kit) и регистрирует его на бэке
# (`DeviceToken`); отсюда пуш уходит по HTTP-API соответствующего провайдера.
#
# Полезная нагрузка — та же, что у Web Push (`push_payload`): {title, body,
# url[, icon]}. Ни сумм, ни имён, ни номеров договоров через серверы
# RuStore/Google/Huawei не проходит (ADR-110 п.4 — правило общее для ВСЕХ
# провайдеров). `icon` (ADR-180) сюда пока НЕ доходит: `RuStorePushSender`/
# `FcmSender`/`HmsSender` шлют только title/body/url — см. ADR-180
# «что осталось» про фото в нативном канале.


@dataclass(frozen=True, slots=True)
class SendOutcome:
    """Итог одной отправки на одно устройство.

    `result`: "ok" — провайдер принял; "gone" — токен мёртв (приложение
    удалено/переустановлено, токен протух), строку надо удалить; "error" —
    всё остальное (сеть, 5xx, неверные ключи) — строку трогать нельзя,
    считаем отказом провайдера для circuit breaker."""

    result: str
    status_code: int | None = None


OK = "ok"
GONE = "gone"
ERROR = "error"


def _native_timeout() -> float:
    return float(getattr(settings, "NATIVE_PUSH_TIMEOUT_SECONDS", 5))


# Кэш access-токенов OAuth-провайдеров (FCM, HMS) в памяти процесса: оба
# выдают токен на час, а пуши уходят пачками из celery-воркера — просить
# новый на каждое устройство значит утроить внешний трафик и упереться в
# лимиты. Тот же приём и то же ограничение, что у common.circuit: состояние
# на процесс, не распределённое.
_access_tokens: dict[str, tuple[str, float]] = {}


def _cached_token(key: str) -> str | None:
    entry = _access_tokens.get(key)
    if entry and entry[1] > time.time():
        return entry[0]
    return None


def _store_token(key: str, token: str, expires_in: int) -> None:
    # Минута запаса: токен, истекающий по дороге, дал бы 401 на живом
    # устройстве и удалил бы его из статистики как ошибку провайдера.
    _access_tokens[key] = (token, time.time() + max(int(expires_in) - 60, 0))


def _reset_access_tokens_for_tests() -> None:
    _access_tokens.clear()


class RuStorePushSender:
    """RuStore Push API (сверено с документацией RuStore 10.09.2026,
    `https://www.rustore.ru/help/sdk/push-notifications/send-push-notifications`):

        POST https://vkpns.rustore.ru/v1/projects/{project_id}/messages:send
        Authorization: Bearer {service_token}
        {"message": {"token": …, "notification": {"title", "body"},
                     "data": {"url": …}}}

    Сервисный токен и project_id берутся в консоли RuStore и живут в prod
    `.env` — сервер их не генерирует. Успех — 200 с пустым `{}`.

    Мёртвый токен: 404 (`NOT_FOUND`, токен протух/отозван) и 400
    (`INVALID_ARGUMENT` про registration token — приложение переустановлено, а
    обёртка прислала старый). Прочие 400 — наша ошибка в теле запроса, токен
    не трогаем."""

    provider = "rustore"

    def send(self, token: str, *, title: str, body: str, url: str) -> SendOutcome:
        project_id = str(getattr(settings, "RUSTORE_PUSH_PROJECT_ID", ""))
        service_token = str(getattr(settings, "RUSTORE_PUSH_SERVICE_TOKEN", ""))
        if not project_id or not service_token:
            return SendOutcome(ERROR)
        try:
            response = httpx.post(
                f"https://vkpns.rustore.ru/v1/projects/{project_id}/messages:send",
                json={
                    "message": {
                        "token": token,
                        "notification": {"title": title, "body": body},
                        "data": {"url": url},
                    }
                },
                headers={"Authorization": f"Bearer {service_token}"},
                timeout=_native_timeout(),
            )
        except httpx.HTTPError:
            return SendOutcome(ERROR)
        if response.status_code == 200:
            return SendOutcome(OK, 200)
        if response.status_code == 404:
            return SendOutcome(GONE, 404)
        if response.status_code == 400 and "registration token" in _response_text(response):
            return SendOutcome(GONE, 400)
        return SendOutcome(ERROR, response.status_code)


class FcmSender:
    """FCM HTTP v1:

        POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
        Authorization: Bearer {OAuth2 access token сервисного аккаунта}
        {"message": {"token", "notification": {"title","body"},
                     "data": {"url"}, "android": {"priority": "high"}}}

    `google-auth` в зависимостях нет и ради одного канала не появится: JWT
    (RS256) подписывается `cryptography`, которая уже стоит из-за envelope-
    шифрования ПД, и меняется на access_token у `oauth2.googleapis.com/token`
    (grant_type=jwt-bearer) — это ровно то, что делает библиотека.

    `UNREGISTERED`/404 — приложение удалено или токен перевыпущен: строка
    удаляется."""

    provider = "fcm"

    def send(self, token: str, *, title: str, body: str, url: str) -> SendOutcome:
        project_id = str(getattr(settings, "FCM_PROJECT_ID", ""))
        access_token = self._access_token()
        if not project_id or not access_token:
            return SendOutcome(ERROR)
        try:
            response = httpx.post(
                f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send",
                json={
                    "message": {
                        "token": token,
                        "notification": {"title": title, "body": body},
                        "data": {"url": url},
                        # «Звонок в дверь» должен звонить сразу, иначе Doze
                        # отложит его до утра и напоминание опоздает к дедлайну.
                        "android": {"priority": "high"},
                    }
                },
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=_native_timeout(),
            )
        except httpx.HTTPError:
            return SendOutcome(ERROR)
        if response.status_code == 200:
            return SendOutcome(OK, 200)
        text = _response_text(response)
        if response.status_code == 404 or "UNREGISTERED" in text:
            return SendOutcome(GONE, response.status_code)
        return SendOutcome(ERROR, response.status_code)

    def _access_token(self) -> str:
        cached = _cached_token("fcm")
        if cached:
            return cached
        account = _fcm_service_account()
        if not account:
            return ""
        try:
            assertion = _google_jwt_assertion(account)
        except (KeyError, ValueError, TypeError):
            return ""
        try:
            response = httpx.post(
                str(account.get("token_uri") or "https://oauth2.googleapis.com/token"),
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
                timeout=_native_timeout(),
            )
        except httpx.HTTPError:
            return ""
        if response.status_code != 200:
            return ""
        payload = _response_json(response)
        access_token = str(payload.get("access_token") or "")
        if access_token:
            _store_token("fcm", access_token, int(payload.get("expires_in") or 3600))
        return access_token


class HmsSender:
    """Huawei Push Kit:

        POST https://push-api.cloud.huawei.com/v1/{app_id}/messages:send
        Authorization: Bearer {access_token по client_credentials}
        {"message": {"token": [..], "notification": {"title","body"},
                     "data": "<json-строка с url>",
                     "android": {"notification": {"click_action": {"type": 3}}}}}

    `data` у HMS — СТРОКА, не объект (единственное отличие формата от FCM и
    RuStore). `click_action.type = 3` — «открыть приложение», маршрут внутри
    берётся из `data`.

    HMS отвечает 200 почти всегда, реальный итог — в поле `code`: 80000000 —
    успех; 80300007 — все токены невалидны; 80100000 — часть токенов
    невалидна, а мы шлём ровно один, значит невалиден он. Оба последних — gone."""

    provider = "hms"

    def send(self, token: str, *, title: str, body: str, url: str) -> SendOutcome:
        app_id = str(getattr(settings, "HMS_APP_ID", ""))
        access_token = self._access_token()
        if not app_id or not access_token:
            return SendOutcome(ERROR)
        try:
            response = httpx.post(
                f"https://push-api.cloud.huawei.com/v1/{app_id}/messages:send",
                json={
                    "message": {
                        "token": [token],
                        "notification": {"title": title, "body": body},
                        "data": json.dumps({"url": url}, ensure_ascii=False),
                        "android": {"notification": {"click_action": {"type": 3}}},
                    }
                },
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=_native_timeout(),
            )
        except httpx.HTTPError:
            return SendOutcome(ERROR)
        if response.status_code != 200:
            return SendOutcome(ERROR, response.status_code)
        code = str(_response_json(response).get("code") or "")
        if code == "80000000":
            return SendOutcome(OK, 200)
        if code in ("80300007", "80100000"):
            return SendOutcome(GONE, 200)
        return SendOutcome(ERROR, 200)

    def _access_token(self) -> str:
        cached = _cached_token("hms")
        if cached:
            return cached
        app_id = str(getattr(settings, "HMS_APP_ID", ""))
        app_secret = str(getattr(settings, "HMS_APP_SECRET", ""))
        if not app_id or not app_secret:
            return ""
        try:
            response = httpx.post(
                "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": app_id,
                    "client_secret": app_secret,
                },
                timeout=_native_timeout(),
            )
        except httpx.HTTPError:
            return ""
        if response.status_code != 200:
            return ""
        payload = _response_json(response)
        access_token = str(payload.get("access_token") or "")
        if access_token:
            _store_token("hms", access_token, int(payload.get("expires_in") or 3600))
        return access_token


def _response_text(response: Any) -> str:  # noqa: ANN401
    try:
        return str(response.text)
    except Exception:  # noqa: BLE001 — тело ответа не должно ронять отправку
        return ""


def _response_json(response: Any) -> dict[str, Any]:  # noqa: ANN401
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001 — не-JSON у провайдера = просто «нет данных»
        return {}
    return payload if isinstance(payload, dict) else {}


def _fcm_service_account() -> dict[str, Any]:
    """`FCM_SERVICE_ACCOUNT_JSON` — САМ JSON сервисного аккаунта строкой, а не
    путь к файлу: prod-compose пробрасывает окружение явным списком
    (правило деплоя, см. комментарий у WEBPUSH_* в docker-compose.prod.yml), и
    монтировать секретный файл в core, celery_worker и celery_beat — три лишних
    места, где он молча не окажется. JSON сервисного аккаунта Google — одна
    строка (перевод строки внутри private_key экранирован), в `.env` помещается."""
    raw = str(getattr(settings, "FCM_SERVICE_ACCOUNT_JSON", "")).strip()
    if not raw:
        return {}
    try:
        account = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return account if isinstance(account, dict) else {}


def _google_jwt_assertion(account: dict[str, Any]) -> str:
    """Самоподписанный JWT сервисного аккаунта (RS256) для обмена на
    access_token. Область — `firebase.messaging`, ровно та, что нужна
    FCM HTTP v1, и ничего сверх неё."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    private_key = serialization.load_pem_private_key(
        str(account["private_key"]).encode("utf-8"), password=None
    )
    if not isinstance(private_key, rsa.RSAPrivateKey):
        raise ValueError("ключ сервисного аккаунта должен быть RSA")
    issued_at = int(time.time())
    token_uri = str(account.get("token_uri") or "https://oauth2.googleapis.com/token")
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": str(account["client_email"]),
        "scope": "https://www.googleapis.com/auth/firebase.messaging",
        "aud": token_uri,
        "iat": issued_at,
        "exp": issued_at + 3600,
    }
    signing_input = b".".join(
        _b64url(json.dumps(part).encode("utf-8")) for part in (header, claims)
    )
    signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return (signing_input + b"." + _b64url(signature)).decode("ascii")


def _b64url(raw: bytes) -> bytes:
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


_NATIVE_SENDERS: dict[str, type[RuStorePushSender | FcmSender | HmsSender]] = {
    "rustore": RuStorePushSender,
    "fcm": FcmSender,
    "hms": HmsSender,
}


def enabled_native_providers() -> tuple[str, ...]:
    """`NOTIFICATIONS_NATIVE_PUSH_PROVIDERS` — список через запятую; пусто =
    канал выключен (дев и тесты живут без ключей трёх провайдеров). Значения
    вне реестра молча отбрасываются: опечатка в prod `.env` не должна ронять
    рассылку целиком."""
    configured = getattr(settings, "NOTIFICATIONS_NATIVE_PUSH_PROVIDERS", "")
    if isinstance(configured, str):
        names = [part.strip() for part in configured.split(",")]
    else:
        names = [str(part).strip() for part in configured]
    return tuple(name for name in names if name in _NATIVE_SENDERS)


class NativePushProvider:
    """Нативный пуш в мобильную обёртку (ADR-176) — тот же `PushProvider`-
    протокол, что и у `WebPushProvider`: рассылка по всем `DeviceToken`
    получателя, каждый — своим провайдером (RuStore/FCM/HMS).

    У каждого провайдера СВОЙ `provider_code` для circuit breaker
    (`push_rustore`, `push_fcm`, `push_hms`): падение RuStore не должно гасить
    доставку на телефоны с сервисами Google.

    Чистка мёртвых токенов — по месту, как у Web Push подписок: ответ
    «unregistered/invalid token» удаляет строку, отдельного sweep нет.

    `status`: `sent_<n>` (доставлено на n устройств), `gone_<provider>`,
    `error_<provider>`, `no_device_token` — читается `прод-конфиг`
    как есть."""

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        from . import selectors as notification_selectors

        tokens = list(notification_selectors.list_device_tokens(recipient))
        if not tokens:
            return DeliveryResult(delivered=False, provider_message_id="", status="no_device_token")

        enabled = enabled_native_providers()
        payload = push_payload(message, recipient=recipient)
        delivered = 0
        last_status = ""
        for device_token in tokens:
            if device_token.provider not in enabled:
                # Провайдер выключен настройками этой инсталляции — токен
                # оставляем: включат обратно, и устройство снова живо.
                continue
            sender = _NATIVE_SENDERS[device_token.provider]()
            outcome = sender.send(
                device_token.token,
                title=payload["title"],
                body=payload["body"],
                url=payload["url"],
            )
            provider_code = f"push_{device_token.provider}"
            if outcome.result == OK:
                circuit.record_success(provider_code)
                delivered += 1
            elif outcome.result == GONE:
                device_token.delete()
                last_status = f"gone_{device_token.provider}"
            else:
                circuit.record_failure(provider_code)
                last_status = f"error_{device_token.provider}"

        if delivered:
            return DeliveryResult(
                delivered=True, provider_message_id="native", status=f"sent_{delivered}"
            )
        # Токены есть, но все от выключенных провайдеров — отправлять некуда,
        # то же самое, что их нет.
        return DeliveryResult(
            delivered=False, provider_message_id="", status=last_status or "no_device_token"
        )


class CompositePushProvider:
    """Нативный канал + Web Push одним `PushProvider` (ADR-176): сначала
    нативные токены получателя, затем Web Push-подписки. `delivered=True`,
    если доставил ХОТЬ ОДИН канал — этого достаточно, чтобы «звонок в дверь»
    состоялся и не сработал SMS-фолбэк (ADR-057).

    Дедупликацию «одно устройство — не два уведомления» делает КЛИЕНТ: в
    режиме обёртки веб не создаёт Web Push-подписку и снимает существующую
    (ADR-176, клиентская часть). Бэк не угадывает, какой токен и какая
    подписка — один и тот же телефон: у него нет общего идентификатора.

    `status` — обе половины в одной строке, `native_<x>+web_<x>`, где `<x>`:
    `sent<n>` | `gone` | `err` | `none`. Сокращение вынужденное —
    `DeliveryAttempt.status` 32 символа, а полные статусы обеих половин в них
    не помещаются; подробность каждого канала остаётся в его собственном
    статусе, когда канал работает в одиночку."""

    def __init__(self, native: NativePushProvider, web: PushProvider) -> None:
        self._native = native
        self._web = web

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        native = self._native.send(recipient, message)
        web = self._web.send(recipient, message)
        delivered = native.delivered or web.delivered
        status = f"native_{_short_status(native.status)}+web_{_short_status(web.status)}"
        return DeliveryResult(
            delivered=delivered,
            provider_message_id="native" if native.delivered else web.provider_message_id,
            status=status,
        )


def _short_status(status: str) -> str:
    if status.startswith("sent_"):
        return f"sent{status[5:]}"
    if status.startswith("gone"):
        return "gone"
    if status.startswith("error") or status == "failed":
        return "err"
    return "none"


def get_push_provider() -> PushProvider:
    """Выбор провайдера по env: `NOTIFICATIONS_PUSH_PROVIDER=webpush|fake`
    (ADR-110) плюс `NOTIFICATIONS_NATIVE_PUSH_PROVIDERS` (ADR-176). Реальная
    интеграция не включается молча — только явной конфигурацией прода.

    Комбинации:

    * нативный список пуст — как было: `webpush` → `WebPushProvider`,
      иначе фейк ЭФ.4;
    * нативный список задан и `NOTIFICATIONS_PUSH_PROVIDER=webpush` —
      `CompositePushProvider`: сначала нативные токены, затем Web Push;
    * нативный список задан, а Web Push не настроен — только
      `NativePushProvider`. Склеивать нативный канал с ФЕЙКОМ нельзя: фейк
      всегда «доставил», и композит скрыл бы реальную недоставку."""
    configured: Any = getattr(settings, "NOTIFICATIONS_PUSH_PROVIDER", "fake")
    if enabled_native_providers():
        if configured == "webpush":
            return CompositePushProvider(NativePushProvider(), WebPushProvider())
        return NativePushProvider()
    if configured == "webpush":
        return WebPushProvider()
    return FakePushProvider()


class FakeEmailProvider:
    """«Доставлено», только если у получателя заполнен email (дублирование —
    опционально по желанию пользователя, domain-model.md §17).

    `sent` — тот же приём, что у apps.accounts.providers.FakeSMSGateway:
    фейк запоминает отправленное, чтобы тест мог посмотреть НА ТЕКСТ письма
    (например, что код входа в нём есть и на нужном языке), не мокая httpx."""

    provider_code = "email_fake"

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, object]]] = []

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        circuit.record_success(self.provider_code)
        if recipient.email:
            self.sent.append((recipient.email, message))
            return DeliveryResult(delivered=True, provider_message_id="fake-email", status="sent")
        return DeliveryResult(delivered=False, provider_message_id="", status="no_email")

    def send_to_address(self, email: str, message: dict[str, object]) -> DeliveryResult:
        circuit.record_success(self.provider_code)
        if not email:
            return DeliveryResult(delivered=False, provider_message_id="", status="no_email")
        self.sent.append((email, message))
        return DeliveryResult(delivered=True, provider_message_id="fake-email", status="sent")


def _cabinet_urls() -> tuple[str, str]:
    base = str(settings.PUBLIC_WEB_BASE_URL).rstrip("/")
    return f"{base}/notifications", f"{base}/me/settings/notifications"


# ADR-141: ключи payload, которые НЕ подставляются в push (текст на экране
# блокировки телефона виден посторонним) — в письме они есть.
PUSH_PRIVATE_KEYS = frozenset({"amount", "currency", "counterparty_name"})


def push_payload(message: dict[str, object], *, recipient: User | None = None) -> dict[str, str]:
    """Единственное, что уходит наружу через ЛЮБОЙ push-сервис (ADR-110 п.4,
    ADR-176, ADR-180): {title, body, url[, icon]}. Ни сумм, ни имён
    контрагентов, ни номеров договоров — их видно уже в ЛК после тапа.

    ADR-180 (жалоба владельца 11.09: «текста много и 2 логотипа, надо
    название договора + фото контрагента»): если у уведомления есть
    договор — `title` берётся из `contract_title` payload'а (короткое имя
    сделки), а `body` — из subject шаблона (он и есть короткая фраза
    действия: «Предложена правка», «Этап принят»); длинный текст письма в
    push НЕ идёт вовсе — он и был источником «текста много». Договора нет
    (уведомления объединений, claim юрлица) — поведение как раньше:
    `title` = subject, `body` = тело.

    ADR-141: подстановки в пуш идут БЕЗ приватных ключей (текст виден на
    экране блокировки посторонним) — вырезанные плейсхолдеры превращаются в
    «…», а не в буквальный `{contract_title}`.

    ADR-170: тап по пушу открывает тот же раздел, что и пункт ленты о том же
    поводе — карта якорей одна на все каналы. Идентификаторы разделов не
    приватны, поэтому маршрут считается по ПОЛНОМУ payload.

    `icon` — фото контрагента (ADR-180): владелец 11.09 — «фото да, имя не
    надо», поэтому `counterparty_name` остаётся в PUSH_PRIVATE_KEYS, а
    `icon` считается ОТДЕЛЬНО от текстовых подстановок и требует `recipient`
    (видимость фото — правило профиля deals_only/public, ADR-103/173,
    считается относительно получателя). Без `recipient` или без договора,
    или когда фото нет/нельзя — ключа `icon` в ответе просто нет."""
    from . import selectors as notification_selectors

    raw_payload = message.get("payload")
    safe_payload = {
        k: v
        for k, v in (raw_payload.items() if isinstance(raw_payload, dict) else ())
        if k not in PUSH_PRIVATE_KEYS
    }
    subject, body = render_message_texts({**message, "payload": safe_payload})
    contract_title = str(safe_payload.get("contract_title") or "")
    title, short_body = (contract_title, subject) if contract_title else (subject, body)
    contract_id = str(message.get("contract_id") or "")
    url = (
        notification_selectors.feed_href_for(
            str(message.get("template") or ""),
            contract_id,
            raw_payload if isinstance(raw_payload, dict) else {},
        )
        if contract_id
        else "/notifications"
    )
    result = {"title": title, "body": short_body, "url": url}
    if recipient is not None and contract_id:
        icon = _push_counterparty_icon_url(contract_id, recipient)
        if icon:
            result["icon"] = icon
    return result


def _push_counterparty_icon_url(contract_id: str, recipient: User) -> str | None:
    """Абсолютный URL фото контрагента для карточки push (ADR-180). Видимость
    — то же правило, что у остальных разделов (ADR-173: `avatar_url_for_
    request`), посчитанное относительно получателя пуша как зрителя; имя
    контрагента текстом сюда НЕ идёт (владелец 11.09) — только это фото.

    Абсолютный URL обязателен: service worker тянет картинку отдельным
    запросом, без Referer текущего таба и без куки текущей сессии — вернуть
    относительный путь означало бы «относительно push-сервиса», не сайта."""
    from uuid import UUID

    from apps.contracts import selectors as contract_selectors
    from apps.profiles import selectors as profile_selectors

    try:
        contract_uuid = UUID(contract_id)
    except ValueError:
        return None
    contract = contract_selectors.get_contract(contract_uuid)
    if contract is None:
        return None
    try:
        other = contract_selectors.resolve_counterparty(contract, recipient)
    except contract_selectors.PartyNotFoundError:
        return None
    mine = contract_selectors.own_party(contract, recipient)
    allowed = profile_selectors.viewer_may_see_avatar(
        other.profile,
        viewer=recipient,
        viewer_profile_id=mine.profile_id if mine is not None else None,
    )
    relative = profile_selectors.avatar_url(other.profile, allowed=allowed)
    if not relative:
        return None
    base = str(settings.PUBLIC_WEB_BASE_URL).rstrip("/")
    return f"{base}{relative}"


def render_message_texts(message: dict[str, object]) -> tuple[str, str]:
    """subject/body письма с подстановками payload (ADR-141): «В договор
    «Ремонт кухни» внесены изменения», а не буквальный `{contract_title}`."""
    from . import selectors as notification_selectors

    payload = message.get("payload")
    substitutions = payload if isinstance(payload, dict) else {}
    subject = notification_selectors.substitute_placeholders(
        str(message.get("subject") or ""), substitutions
    )
    body = notification_selectors.substitute_placeholders(
        str(message.get("body") or ""), substitutions
    )
    return subject, body


def email_meta_rows(message: dict[str, object], *, locale: str) -> list[tuple[str, str]]:
    """Мета письма — те же поля, что у карточки уведомления в ЛК (ADR-098/102):
    сделка (название · №), контрагент, сумма (всегда парой с валютой), этап.
    Чего нет в payload — того нет и в письме (валюты по умолчанию нет)."""
    payload = message.get("payload")
    if not isinstance(payload, dict):
        return []
    rows: list[tuple[str, str]] = []
    title = str(payload.get("contract_title") or "")
    number = str(payload.get("contract_number") or "")
    if title or number:
        deal = title if title else f"№ {number}"
        if title and number and number not in title:
            deal = f"{title} · № {number}"
        rows.append((meta_label("deal", locale), deal))
    counterparty = str(payload.get("counterparty_name") or "")
    if counterparty:
        rows.append((meta_label("counterparty", locale), counterparty))
    amount, currency = payload.get("amount"), payload.get("currency")
    if amount and currency:
        rows.append((meta_label("amount", locale), f"{amount} {currency}"))
    milestone = str(payload.get("milestone_title") or "")
    if milestone:
        rows.append((meta_label("milestone", locale), milestone))
    return rows


def _deal_url(message: dict[str, object]) -> str | None:
    """Кнопка письма «Открыть сделку» — ADR-170: тот же раздел, что у пункта
    ленты и пуша о том же поводе (карта якорей — в selectors)."""
    from . import selectors as notification_selectors

    contract_id = str(message.get("contract_id") or "")
    if not contract_id:
        return None
    payload = message.get("payload")
    href = notification_selectors.feed_href_for(
        str(message.get("template") or ""),
        contract_id,
        payload if isinstance(payload, dict) else {},
    )
    base = str(settings.PUBLIC_WEB_BASE_URL).rstrip("/")
    return f"{base}{href}"


def _email_text(
    body: str,
    *,
    locale: str,
    meta: list[tuple[str, str]] | None = None,
    deal_url: str | None = None,
) -> str:
    """Plain-text часть письма: текст шаблона + мета сделки (ADR-141) +
    ссылка в сделку/кабинет + приписка про отключение уведомлений
    (просьба пользователя, 2026-08-23) со ссылкой."""
    cabinet_url, settings_url = _cabinet_urls()
    lines = [body]
    if meta:
        lines.append("")
        lines.extend(f"{label}: {value}" for label, value in meta)
    lines.extend(["", deal_url or cabinet_url, "", unsubscribe_hint(locale), settings_url])
    return "\n".join(lines)


# ── Вёрстка письма ──────────────────────────────────────────────────────────
# Правила почтовых клиентов (общие для обеих вёрсток ниже): таблицы вместо
# флексов (Outlook), инлайн-стили (внешние CSS не грузятся), словознак ТЕКСТОМ
# (inline-SVG режет Gmail), без картинок вообще (почта ходит без внешних
# ресурсов). Палитра — hex из packages/ui tokens.css. Вторичный текст — своим
# hex, а не opacity: opacity Outlook игнорирует.
_INK = "#16283C"
_CREAM = "#FBF6EE"
_SAND = "#F0E7D6"
_AMBER = "#FF9E2C"
_MUTED = "#5A6B7D"
_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif"
# ADR-172 (решение владельца 31.08, письма его пропустили): бренд ВЕЗДЕ
# латиницей — «Porukam». Кириллица «По рукам» осталась только идиомой
# интерфейса («По рукам! Договор подписан») и в юртекстах оферты.
BRAND = "Porukam"


def _site_url() -> str:
    return str(settings.PUBLIC_WEB_BASE_URL).rstrip("/")


def _preheader(text: str) -> str:
    """Скрытая строка превью в списке писем: почтовый клиент показывает её
    рядом с темой вместо первого попавшегося куска вёрстки. Хвост из
    неразрывных пробелов-невидимок отодвигает от превью остальной HTML."""
    return (
        '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
        f'font-size:1px;line-height:1px;color:{_CREAM}">'
        f"{html_escape(text[:150])}"
        f"{'&#8199;&#65279;' * 40}"
        "</div>"
    )


def _brand_header() -> str:
    """Шапка: чернильная плашка со словознаком кремом и янтарной точкой —
    отсылка к знаку-искре (настоящий знак — SVG, почта его не покажет)."""
    return (
        f'<tr><td style="background:{_INK};border-radius:16px 16px 0 0;padding:22px 32px">'
        f'<span style="font-size:21px;font-weight:bold;color:{_CREAM};letter-spacing:0.4px">'
        f"{BRAND}</span>"
        f'<span style="font-size:21px;font-weight:bold;color:{_AMBER}">.</span>'
        "</td></tr>"
    )


def _letter_shell(*, preheader: str, content: str, footer: str) -> str:
    """Общий каркас обоих писем: кремовое поле, колонка 520px, шапка-бренд."""
    return (
        f'<div style="margin:0;padding:32px 12px;background:{_CREAM};font-family:{_FONT}">'
        f"{_preheader(preheader)}"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        '<tr><td align="center">'
        '<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" '
        'style="max-width:520px;width:100%">'
        f"{_brand_header()}{content}{footer}"
        "</table>"
        "</td></tr></table></div>"
    )


def _email_html(
    subject: str,
    body: str,
    *,
    locale: str,
    meta: list[tuple[str, str]] | None = None,
    deal_url: str | None = None,
) -> str:
    """Фирменная HTML-вёрстка письма-уведомления (просьба 2026-08-23
    «брендинг сверх минимального»). Динамики из payload нет — только
    локализованные строки шаблона и email_texts."""
    cabinet_url, settings_url = _cabinet_urls()
    button = html_escape(open_deal_label(locale) if deal_url else open_cabinet_label(locale))
    button_url = deal_url or cabinet_url
    hint = html_escape(unsubscribe_hint(locale))
    # Мета сделки (ADR-141) — таблица «подпись · значение», как карточка в ЛК.
    meta_html = ""
    if meta:
        meta_rows = "".join(
            f'<tr><td style="padding:5px 14px 5px 0;font-size:13px;color:{_MUTED};'
            f'white-space:nowrap;vertical-align:top">{html_escape(label)}</td>'
            f'<td style="padding:5px 0;font-size:14px;line-height:1.5;color:{_INK}">'
            f"{html_escape(value)}</td></tr>"
            for label, value in meta
        )
        meta_html = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="margin:0 0 26px;border-top:1px solid {_SAND};padding-top:14px">'
            f"{meta_rows}</table>"
        )
    content = (
        '<tr><td style="background:#FFFFFF;padding:32px 32px 30px">'
        f'<h1 style="margin:0 0 14px;font-size:22px;line-height:1.35;font-weight:bold;'
        f'color:{_INK}">{html_escape(subject)}</h1>'
        f'<p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:{_INK}">'
        f"{html_escape(body)}</p>"
        f"{meta_html}"
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td style="background:{_AMBER};border-radius:10px">'
        f'<a href="{button_url}" style="display:inline-block;padding:14px 26px;'
        f'font-size:15px;font-weight:bold;color:{_INK};text-decoration:none">{button}</a>'
        "</td></tr></table>"
        "</td></tr>"
    )
    # Футер: приписка про отключение уведомлений (просьба 2026-08-23) + адрес.
    footer = (
        f'<tr><td style="background:{_SAND};border-radius:0 0 16px 16px;padding:18px 32px">'
        f'<p style="margin:0;font-size:12px;line-height:1.6;color:{_MUTED}">'
        f'{hint} <a href="{settings_url}" style="color:{_INK}">porukam.app</a></p>'
        "</td></tr>"
    )
    return _letter_shell(preheader=body, content=content, footer=footer)


def _service_email_html(subject: str, body: str, *, code: str = "") -> str:
    """Вёрстка СЛУЖЕБНОГО письма (ADR-168): та же шапка и те же правила
    почтовых клиентов, что у _email_html, но без меты сделки, кнопки и
    приписки про отключение — у письма с кодом входа нет ни сделки, ни
    настройки, которой его можно выключить.

    `code` рисуется отдельной плашкой крупным моноширинным кеглем (замечание
    владельца 08.09): код читают с экрана и переносят руками, поэтому он —
    главный элемент письма, а не часть предложения. В превью письма
    (preheader) кода НЕТ намеренно: превью видно на заблокированном экране."""
    code_block = ""
    if code:
        code_block = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'border="0" style="margin:0 0 22px"><tr>'
            f'<td align="center" style="background:{_SAND};border-radius:14px;padding:22px 12px">'
            "<div style=\"font-family:'Courier New',Courier,monospace;font-size:32px;"
            "line-height:1.2;font-weight:bold;letter-spacing:8px;text-indent:8px;"
            f'color:{_INK}">{html_escape(code)}</div>'
            "</td></tr></table>"
        )
    body_style = (
        f"margin:0;font-size:13px;line-height:1.65;color:{_MUTED}"
        if code
        else f"margin:0;font-size:15px;line-height:1.65;color:{_INK}"
    )
    content = (
        '<tr><td style="background:#FFFFFF;padding:32px">'
        f'<h1 style="margin:0 0 20px;font-size:22px;line-height:1.35;font-weight:bold;'
        f'color:{_INK}">{html_escape(subject)}</h1>'
        f"{code_block}"
        f'<p style="{body_style}">{html_escape(body)}</p>'
        "</td></tr>"
    )
    footer = (
        f'<tr><td align="center" style="background:{_SAND};border-radius:0 0 16px 16px;'
        'padding:16px 32px">'
        f'<a href="{_site_url()}" style="font-size:12px;color:{_MUTED};'
        'text-decoration:none">porukam.app</a></td></tr>'
    )
    return _letter_shell(preheader=body, content=content, footer=footer)


def _service_email_text(subject: str, body: str, *, code: str = "") -> str:
    """Plain-текст служебного письма: код — ОТДЕЛЬНОЙ строкой (его выделяют
    и копируют), под ним приписка, в конце адрес сайта."""
    lines = [subject, ""]
    if code:
        lines.extend([code, ""])
    lines.extend([body, "", _site_url()])
    return "\n".join(lines)


def _resend_attachments(raw: object) -> list[dict[str, str]]:
    """ADR-139: вложения письма (доказательный пакет) в формате Resend API
    (`{"filename", "content": base64}`). Ожидаемый вход —
    `message["attachments"]` = `[{filename, content_type, content_b64}]` из
    apps.notifications.services.place_notification(email_attachments=...)."""
    if not isinstance(raw, list):
        return []
    result: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("content_b64"):
            continue
        result.append(
            {
                "filename": str(item.get("filename") or "attachment"),
                "content": str(item["content_b64"]),
            }
        )
    return result


class ResendEmailProvider:
    """Реальный email через HTTP API Resend (ADR-111). Дублирующий канал
    (юрканал — ЛК, ADR-057). ADR-141 (решение владельца 27.08): письмо
    информативно, как карточка в ЛК — subject/body с подстановками payload,
    мета (сделка · контрагент · сумма · этап), кнопка ведёт в сделку.

    Ошибки не роняют place_notification: сеть/4xx/5xx — `delivered=False` +
    circuit.record_failure, размещение в ЛК уже состоялось."""

    provider_code = "email_resend"
    _API_URL = "https://api.resend.com/emails"

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        if not recipient.email:
            return DeliveryResult(delivered=False, provider_message_id="", status="no_email")
        subject, body = render_message_texts(message)
        subject = subject or BRAND
        locale = str(message.get("locale") or "en")
        meta = email_meta_rows(message, locale=locale)
        deal_url = _deal_url(message)
        payload: dict[str, Any] = {
            "from": settings.NOTIFICATIONS_EMAIL_FROM,
            "to": [recipient.email],
            "subject": subject,
            "text": _email_text(body, locale=locale, meta=meta, deal_url=deal_url),
            "html": _email_html(subject, body, locale=locale, meta=meta, deal_url=deal_url),
        }
        attachments = _resend_attachments(message.get("attachments"))
        if attachments:
            payload["attachments"] = attachments
        return self._post(payload)

    def send_to_address(self, email: str, message: dict[str, object]) -> DeliveryResult:
        """Служебное письмо на адрес (ADR-168, код входа). Без меты сделки,
        кнопки «Открыть сделку» и приписки «уведомления можно отключить»:
        сделки нет, а код входа — не уведомление и отключить его нельзя.
        Деградация — та же, что у send(): сеть/4xx/5xx не бросают исключение,
        вызывающая сторона видит delivered=False."""
        if not email:
            return DeliveryResult(delivered=False, provider_message_id="", status="no_email")
        subject, body = render_message_texts(message)
        subject = subject or BRAND
        # Код входа — отдельное поле сообщения, а не часть текста (замечание
        # владельца 08.09): в вёрстке это крупная плашка, в plain — отдельная
        # строка. Служебное письмо без кода (если такое появится) обходится
        # без плашки — вёрстка та же.
        code = str(message.get("code") or "")
        payload: dict[str, Any] = {
            "from": settings.NOTIFICATIONS_EMAIL_FROM,
            "to": [email],
            "subject": subject,
            "text": _service_email_text(subject, body, code=code),
            "html": _service_email_html(subject, body, code=code),
        }
        return self._post(payload)

    def _post(self, payload: dict[str, Any]) -> DeliveryResult:
        import httpx

        try:
            response = httpx.post(
                self._API_URL,
                json=payload,
                headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
                timeout=10,
            )
        except httpx.HTTPError:
            circuit.record_failure(self.provider_code)
            return DeliveryResult(delivered=False, provider_message_id="", status="network_error")
        if response.status_code in (200, 201):
            circuit.record_success(self.provider_code)
            message_id = str(response.json().get("id", ""))
            return DeliveryResult(delivered=True, provider_message_id=message_id, status="sent")
        circuit.record_failure(self.provider_code)
        return DeliveryResult(
            delivered=False, provider_message_id="", status=f"http_{response.status_code}"
        )


def get_email_provider() -> EmailProvider:
    """Выбор провайдера по env (`NOTIFICATIONS_EMAIL_PROVIDER=resend|fake`) —
    тот же приём, что get_push_provider: реальная интеграция включается
    только явной конфигурацией прода."""
    configured: Any = getattr(settings, "NOTIFICATIONS_EMAIL_PROVIDER", "fake")
    if configured == "resend":
        return ResendEmailProvider()
    return FakeEmailProvider()


class FakeSmsProvider:
    """Fallback-канал финальной точки серии напоминаний (ADR-057). Телефон —
    обязательное поле входа (apps.accounts), поэтому «доставлено» всегда,
    пока не отозвано пользователем на уровне NotificationSettings.sms_enabled
    (проверяется в services.py, не здесь)."""

    provider_code = "sms_fake"

    def send(self, recipient: User, message: dict[str, object]) -> DeliveryResult:
        circuit.record_success(self.provider_code)
        if recipient.phone:
            return DeliveryResult(delivered=True, provider_message_id="fake-sms", status="sent")
        return DeliveryResult(delivered=False, provider_message_id="", status="no_phone")
