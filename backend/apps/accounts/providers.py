"""Интерфейсы внешних провайдеров входа + фейки (CLAUDE.md: "внешние
провайдеры — только интерфейсы + фейки"). Исключения — датированные,
продуктовые: `GoogleDriveOAuthProvider` получил `Real`-реализацию
13.08.2026 (реальный Drive-бэкап в октябрьский GLOBAL-запуск,
docs/tasks/Задача_feat_evidence-drive.md); `GoogleOAuthProvider` (вход) —
следом, тем же решением 13.08.2026: на первой GLOBAL-волне вход = только
Google (SMS вне волны — международный SMS дорог/сложен), значит фейк-вход
в проде не работает и реальный провайдер нужен к запуску
(docs/tasks/Задача_feat_accounts-google-login-real.md).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx
from django.conf import settings

from common import circuit

logger = logging.getLogger(__name__)


class SMSGateway(Protocol):
    def send_sms(self, phone: str, message: str) -> None: ...


class FakeSMSGateway:
    """Ничего никуда не отправляет — только запоминает сообщения, чтобы
    тесты могли перехватить фактически отправленный код, не полагаясь на
    settings.OTP_FIXED_CODE."""

    provider_code = "sms_otp_fake"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send_sms(self, phone: str, message: str) -> None:
        self.sent.append((phone, message))
        circuit.record_success(self.provider_code)


class GoogleOAuthProviderError(Exception):
    """Базовая ошибка Google OAuth-провайдера."""


class InvalidGoogleAuthorizationCodeError(GoogleOAuthProviderError):
    """Код авторизации не распознан или просрочен провайдером."""


@dataclass(frozen=True, slots=True)
class GoogleIdentity:
    sub: str
    email: str
    # ADR-103: ссылка на фото из userinfo (`picture`) — только как источник
    # для ОДНОКРАТНОГО импорта при регистрации; наружу и в БД не попадает.
    picture: str | None = None


class GoogleOAuthProvider(Protocol):
    provider_code: str

    def authorize_url(self, *, state: str, code_challenge: str) -> str: ...

    def complete(self, *, code: str, code_verifier: str) -> GoogleIdentity: ...


class FakeGoogleOAuthProvider:
    """Полностью детерминированный фейк — тот же приём, что FakeEsiaProvider
    (ADR-062): код авторизации сам кодирует "sub|email", тесты управляют
    результатом входа напрямую, не полагаясь на внешний сервис. `code_verifier`
    принимается ради единой сигнатуры с `RealGoogleOAuthProvider` (настоящий
    PKCE) — фейку сверять нечего, сам код уже несёт результат."""

    provider_code = "google_fake"

    def authorize_url(self, *, state: str, code_challenge: str) -> str:
        return (
            "https://accounts.google.com/o/oauth2/v2/auth"
            f"?response_type=code&state={state}"
            f"&code_challenge={code_challenge}&code_challenge_method=S256"
        )

    def complete(self, *, code: str, code_verifier: str) -> GoogleIdentity:
        # "sub|email" либо "sub|email|picture_url" (ADR-103: третья часть —
        # необязательная ссылка на фото, как `picture` в userinfo).
        parts = code.split("|", 2)
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise InvalidGoogleAuthorizationCodeError(f"нераспознанный код Google: {code!r}")
        sub, email = parts[0], parts[1]
        picture = parts[2] if len(parts) > 2 and parts[2] else None
        return GoogleIdentity(sub=sub, email=email, picture=picture)


_GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_GOOGLE_LOGIN_REQUEST_TIMEOUT_SECONDS = 15


def _log_google_http_error(step: str, exc: httpx.HTTPError) -> None:
    """Диагностика обмена Google-входа. Логируем ТОЛЬКО шаг, статус и поля
    `error`/`error_description` из тела ответа Google (или первые 200 символов
    не-JSON текста); для сетевых ошибок — тип исключения. Никогда: code,
    code_verifier, client_secret, токены, email, полные тела ответов."""
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            error = str(body.get("error"))[:200]
            description = str(body.get("error_description"))[:200]
        else:
            error = "-"
            description = response.text[:200]
        logger.warning(
            "google oauth %s: HTTP %s error=%s error_description=%s",
            step,
            response.status_code,
            error,
            description,
        )
    else:
        logger.warning("google oauth %s: сетевая ошибка %s", step, type(exc).__name__)


@dataclass
class RealGoogleOAuthProvider:
    """Реальный вход через Google (ГВ.2, продуктовое решение 13.08.2026,
    docs/tasks/Задача_feat_accounts-google-login-real.md) — тот же приём, что
    `RealGoogleDriveOAuthProvider` ниже: httpx, явные таймауты, типизированные
    ошибки. Тот же OAuth-клиент, что Drive (ADR-084: второй не заводится) —
    но с ДРУГИМ redirect URI и БЕЗ drive-scope (только identity).

    Identity — через userinfo-эндпоинт, а не разбор/проверка подписи
    `id_token`: проще и не тянет JWKS-верификацию отдельной зависимостью
    (задача §2.1, вариант «проще и надёжнее»).

    `code_verifier` — настоящий PKCE (задача §2.1, уточнение «вариант 3» от
    13.08): `apps.accounts.services.complete_google_login` уже кеширует его
    по `state` (`build_google_authorize_url`) и передаёт сюда — Protocol
    расширен под него сознательно, ripple ограничен этим файлом + services.py
    (граница §3 «не менять Protocol» для этой ветки снята координатором)."""

    client_id: str
    client_secret: str
    redirect_uri: str
    provider_code: str = "google_real"

    def authorize_url(self, *, state: str, code_challenge: str) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            # НИКАКОГО drive-scope здесь — Drive подключается отдельно,
            # инкрементальной авторизацией (ADR-084, RealGoogleDriveOAuthProvider ниже).
            "scope": "openid email profile",
            "access_type": "online",  # логину refresh-токен не нужен
            "prompt": "select_account",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return f"{_GOOGLE_AUTHORIZE_URL}?{httpx.QueryParams(params)}"

    def complete(self, *, code: str, code_verifier: str) -> GoogleIdentity:
        try:
            token_response = httpx.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": code_verifier,
                },
                timeout=_GOOGLE_LOGIN_REQUEST_TIMEOUT_SECONDS,
            )
            token_response.raise_for_status()
        except httpx.HTTPError as exc:
            _log_google_http_error("token", exc)
            circuit.record_failure(self.provider_code)
            raise InvalidGoogleAuthorizationCodeError(
                f"обмен кода Google-входа не удался: {exc}"
            ) from exc
        access_token = token_response.json().get("access_token")
        if not access_token:
            logger.warning("google oauth token: ответ без access_token")
            circuit.record_failure(self.provider_code)
            raise InvalidGoogleAuthorizationCodeError("Google не вернул access_token")

        try:
            userinfo_response = httpx.get(
                _GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=_GOOGLE_LOGIN_REQUEST_TIMEOUT_SECONDS,
            )
            userinfo_response.raise_for_status()
        except httpx.HTTPError as exc:
            _log_google_http_error("userinfo", exc)
            circuit.record_failure(self.provider_code)
            raise InvalidGoogleAuthorizationCodeError(f"userinfo Google не удался: {exc}") from exc
        circuit.record_success(self.provider_code)
        userinfo = userinfo_response.json()
        sub = userinfo.get("sub")
        email = userinfo.get("email")
        if not sub or not email:
            logger.warning(
                "google oauth userinfo: ответ без sub/email (sub=%s email=%s)",
                bool(sub),
                bool(email),
            )
            raise InvalidGoogleAuthorizationCodeError("Google userinfo не вернул sub/email")
        picture = userinfo.get("picture")
        return GoogleIdentity(
            sub=str(sub), email=str(email), picture=str(picture) if picture else None
        )


def build_google_login_provider() -> GoogleOAuthProvider:
    """Тумблер fake/real входа (`settings.GOOGLE_LOGIN_PROVIDER`) — по
    образцу `build_drive_oauth_provider` ниже, читает флаг на каждый вызов
    (не на импорт модуля), чтобы `override_settings` в тестах работал
    предсказуемо. Дефолт `fake` — тесты/локалка не меняются."""
    if settings.GOOGLE_LOGIN_PROVIDER == "real":
        return RealGoogleOAuthProvider(
            client_id=settings.GOOGLE_OAUTH_CLIENT_ID,
            client_secret=settings.GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri=settings.GOOGLE_OAUTH_LOGIN_REDIRECT_URI,
        )
    return FakeGoogleOAuthProvider()


# --- Google Drive BYO-бэкап: инкрементальная авторизация (ADR-084,
# docs/tasks/Задача_feat_evidence-drive.md §2.2) — ОТДЕЛЬНЫЙ Protocol от
# GoogleOAuthProvider выше ("добавить рядом", не расширять): вход (ADR-071)
# не трогается, здесь только «подключить Drive» для уже вошедшего
# пользователя, access_type=offline + prompt=consent (иначе Google не
# вернёт refresh-токен), scope — ТОЛЬКО drive.file (ADR-084, никогда шире).


class GoogleDriveOAuthError(Exception):
    """Базовая ошибка Drive-OAuth (обмен кода/рефреш токена) — отдельная
    иерархия от GoogleOAuthProviderError (логин), не путать."""


class InvalidGoogleDriveAuthorizationCodeError(GoogleDriveOAuthError):
    """Код авторизации Drive-подключения не распознан или просрочен."""


class GoogleDriveGrantInvalidError(GoogleDriveOAuthError):
    """Google вернул `invalid_grant` при рефреше access-токена — пользователь
    отозвал доступ вне продукта (в настройках своего Google-аккаунта).
    apps.accounts.services.get_drive_access_token ловит это и помечает
    грант revoked."""


@dataclass(frozen=True, slots=True)
class GoogleDriveTokens:
    access_token: str
    refresh_token: str
    expires_in: int


class GoogleDriveOAuthProvider(Protocol):
    provider_code: str

    def connect_authorize_url(self, *, state: str, code_challenge: str) -> str: ...

    def exchange_code(self, *, code: str, code_verifier: str) -> GoogleDriveTokens: ...

    def refresh_access_token(self, *, refresh_token: str) -> str: ...


class FakeGoogleDriveOAuthProvider:
    """Полностью детерминированный фейк — тот же приём, что
    FakeGoogleOAuthProvider: код/refresh-токен сами кодируют результат,
    `fail_refresh` управляется тестом напрямую (проверка отзыва гранта без
    полагания на недетерминированное поведение внешнего сервиса)."""

    provider_code = "google_drive_oauth_fake"

    def __init__(self, *, fail_refresh: bool = False) -> None:
        self.fail_refresh = fail_refresh

    def connect_authorize_url(self, *, state: str, code_challenge: str) -> str:
        return (
            "https://accounts.google.com/o/oauth2/v2/auth"
            "?response_type=code&access_type=offline&prompt=consent"
            "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file"
            f"&state={state}&code_challenge={code_challenge}&code_challenge_method=S256"
        )

    def exchange_code(self, *, code: str, code_verifier: str) -> GoogleDriveTokens:
        if not code or not code_verifier:
            raise InvalidGoogleDriveAuthorizationCodeError(
                f"нераспознанный код Drive-подключения: {code!r}"
            )
        return GoogleDriveTokens(
            access_token=f"fake-drive-access-{code}",
            refresh_token=f"fake-drive-refresh-{code}",
            expires_in=3600,
        )

    def refresh_access_token(self, *, refresh_token: str) -> str:
        if self.fail_refresh:
            raise GoogleDriveGrantInvalidError(
                f"фейковый invalid_grant для refresh-токена {refresh_token!r}"
            )
        return f"fake-drive-access-refreshed-{refresh_token}"


_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_DRIVE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_DRIVE_OAUTH_REQUEST_TIMEOUT_SECONDS = 15


@dataclass
class RealGoogleDriveOAuthProvider:
    """Вторая реальная (сетевая) реализация внешнего провайдера в этом файле
    (первая — `RealGoogleOAuthProvider` выше) — осознанное исключение, см.
    модульный docstring. Client id/secret и redirect URI — конфиг деплоя
    (settings/env), не хардкод; тот же OAuth-клиент, что вход (ADR-071),
    второй не заводится (ADR-084)."""

    client_id: str
    client_secret: str
    redirect_uri: str
    provider_code: str = "google_drive_real"

    def connect_authorize_url(self, *, state: str, code_challenge: str) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "access_type": "offline",
            "prompt": "consent",
            # ADR-084: единственный допустимый scope, никогда не расширять.
            "scope": "https://www.googleapis.com/auth/drive.file",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{_GOOGLE_DRIVE_AUTHORIZE_URL}?{httpx.QueryParams(params)}"

    def exchange_code(self, *, code: str, code_verifier: str) -> GoogleDriveTokens:
        try:
            response = httpx.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": code_verifier,
                },
                timeout=_DRIVE_OAUTH_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            circuit.record_failure(self.provider_code)
            raise InvalidGoogleDriveAuthorizationCodeError(
                f"обмен кода Drive-подключения не удался: {exc}"
            ) from exc
        payload = response.json()
        circuit.record_success(self.provider_code)
        refresh_token = payload.get("refresh_token")
        if not refresh_token:
            # Google не возвращает refresh_token, если пользователь уже давал
            # согласие на этот же scope раньше без prompt=consent — на нашем
            # флоу такого быть не должно (prompt=consent всегда), но явная
            # проверка честнее тихого NULL в БД.
            raise InvalidGoogleDriveAuthorizationCodeError(
                "Google не вернул refresh_token (ожидался offline-доступ)"
            )
        return GoogleDriveTokens(
            access_token=payload["access_token"],
            refresh_token=refresh_token,
            expires_in=int(payload.get("expires_in", 3600)),
        )

    def refresh_access_token(self, *, refresh_token: str) -> str:
        try:
            response = httpx.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "refresh_token": refresh_token,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "grant_type": "refresh_token",
                },
                timeout=_DRIVE_OAUTH_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            circuit.record_failure(self.provider_code)
            body = exc.response.json() if exc.response.content else {}
            if body.get("error") == "invalid_grant":
                raise GoogleDriveGrantInvalidError(
                    "Google вернул invalid_grant — доступ отозван пользователем"
                ) from exc
            raise GoogleDriveGrantInvalidError(f"рефреш Drive-токена не удался: {exc}") from exc
        except httpx.HTTPError as exc:
            circuit.record_failure(self.provider_code)
            raise GoogleDriveGrantInvalidError(f"рефреш Drive-токена не удался: {exc}") from exc
        circuit.record_success(self.provider_code)
        payload = response.json()
        return str(payload["access_token"])


def build_drive_oauth_provider() -> GoogleDriveOAuthProvider:
    """Общий тумблер fake/real (`settings.EVIDENCE_DRIVE_PROVIDER`) —
    используется и `apps.accounts.api.views` (connect-флоу), и
    `apps.evidence.providers.RealGoogleDriveBackupProvider` (рефреш access-
    токена внутри upload()), см. docs/tasks/Задача_feat_evidence-drive.md
    §2.4: один флаг переключает обе половины Drive-интеграции разом —
    раздельные флаги открыли бы недопустимую комбинацию (реальный OAuth +
    фейковая загрузка или наоборот)."""
    if settings.EVIDENCE_DRIVE_PROVIDER == "real":
        return RealGoogleDriveOAuthProvider(
            client_id=settings.GOOGLE_OAUTH_CLIENT_ID,
            client_secret=settings.GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri=settings.GOOGLE_DRIVE_CONNECT_REDIRECT_URI,
        )
    return FakeGoogleDriveOAuthProvider()
