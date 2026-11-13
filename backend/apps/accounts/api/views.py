from __future__ import annotations

import base64
import binascii
from typing import Any, cast

from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.api.exceptions import DomainAPIError
from common.i18n import resolve_signup_locale

from .. import services
from ..models import User
from ..providers import FakeSMSGateway, build_drive_oauth_provider, build_google_login_provider
from .serializers import (
    AccountDeletedSerializer,
    DeviceKeySerializer,
    EmailOTPRequestSerializer,
    EmailOTPVerifySerializer,
    GoogleAuthorizeUrlSerializer,
    GoogleCallbackRequestSerializer,
    GoogleDriveConnectAuthorizeUrlSerializer,
    GoogleDriveConnectCallbackRequestSerializer,
    GoogleDriveGrantStatusSerializer,
    LogoutRequestSerializer,
    OTPRequestSerializer,
    OTPVerifySerializer,
    RefreshRequestSerializer,
    TokenPairSerializer,
    UserDeviceSerializer,
    UserMeSerializer,
    UserMeUpdateSerializer,
)

# SMS — фейк без исключений (CLAUDE.md: "внешние провайдеры — только
# интерфейсы + фейки", вне волны). Google-логин и Drive-connect — датированные
# продуктовые исключения (13.08.2026): fake/real переключается
# settings.GOOGLE_LOGIN_PROVIDER / settings.EVIDENCE_DRIVE_PROVIDER, builder
# читает флаг на каждый вызов (не на импорт модуля), чтобы override_settings
# в тестах работал предсказуемо — поэтому здесь нет модульного singleton'а
# для Google, как раньше был `_google_provider`.
_sms_gateway = FakeSMSGateway()


def _acting_profile_id(request: Request) -> str | None:
    raw = getattr(request, "acting_profile_id", None)
    return str(raw) if raw else None


class _AnonymousAuthView(APIView):
    """Вьюхи контура входа/выхода/refresh (ADR-119). `authentication_classes
    = []` — не пустая формальность: клиент держит в localStorage протухший
    access и шлёт его Bearer-ом НА ВСЕ запросы, включая сам refresh.
    JWTAuthentication по умолчанию отвергал такой ЗАПРОС 401
    `authentication_required` ещё до проверки AllowAny — сессия не могла ни
    обновиться, ни честно умереть (`refresh_token_invalid`), ни войти заново
    (зависание «code: authentication_required», отсмотр 2026-08-24; до
    ADR-108 то же самое выглядело как «выбрасывает на вход» через час).
    Здесь предъявитель — refresh/код в теле, Bearer не нужен и не читается."""

    authentication_classes: list[type] = []
    permission_classes = [AllowAny]


class _PhoneLoginView(_AnonymousAuthView):
    """Вход «телефон + код». Способ входа целиком выключается настройкой
    PHONE_LOGIN_ENABLED (ADR-165): на публикацию оставлен единственный вход —
    аккаунт Google, а спрятанная на фронте форма эндпоинт не закрывает.

    Проверка здесь, а не в permission-классе: BasePermission умеет только
    обобщённый `permission_denied`, а фронту нужен именно код
    `phone_login_disabled` (иначе «нет прав» неотличимо от протухшей сессии).
    Привязку телефона к уже вошедшему аккаунту (PATCH /users/me) флаг НЕ
    трогает — она не даёт войти."""

    def initial(self, request: Request, *args: Any, **kwargs: Any) -> None:
        super().initial(request, *args, **kwargs)
        if not settings.PHONE_LOGIN_ENABLED:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="phone_login_disabled",
                title="Вход по номеру телефона отключён",
                detail="Войдите через аккаунт Google.",
            )


class OTPRequestView(_PhoneLoginView):
    permission_classes = [AllowAny]

    @extend_schema(request=OTPRequestSerializer, responses={200: None})
    def post(self, request: Request) -> Response:
        serializer = OTPRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.request_otp(serializer.validated_data["phone"], gateway=_sms_gateway)
        except services.OTPRateLimitedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="otp_rate_limited",
                title="Слишком много запросов кода",
                detail=str(exc),
                # Точный остаток окна знает только кеш; отдаём длину окна —
                # тот же приём, что archive_link_view (ADR-168).
                retry_after=services.OTP_REQUEST_WINDOW_SECONDS,
            ) from exc
        # dev_hint — ТОЛЬКО при фиксированном dev-коде (OTP_FIXED_CODE; в
        # проде он пуст — тело остаётся пустым, фронт это переживает):
        # LoginPage показывает «Тестовый режим …» на dev-стендах, как в моке.
        if settings.OTP_FIXED_CODE and not settings.PRODUCTION_PROFILE:
            return Response({"dev_hint": settings.OTP_FIXED_CODE})
        return Response(status=status.HTTP_200_OK)


class OTPVerifyView(_PhoneLoginView):
    permission_classes = [AllowAny]

    @extend_schema(request=OTPVerifySerializer, responses={200: TokenPairSerializer})
    def post(self, request: Request) -> Response:
        serializer = OTPVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            _user, tokens = services.verify_otp(
                serializer.validated_data["phone"],
                serializer.validated_data["code"],
                acting_profile_id=_acting_profile_id(request),
                # Язык запроса — единственное, что вьюха достаёт из HTTP
                # сверх тела (ADR-148); что с ним делать, решает сервис.
                locale_hint=resolve_signup_locale(request),
            )
        except services.OTPRateLimitedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="otp_rate_limited",
                title="Слишком много попыток проверки кода",
                detail=str(exc),
                # Счётчик попыток живёт столько же, сколько сам код.
                retry_after=services.OTP_CODE_TTL_SECONDS,
            ) from exc
        except services.OTPCodeExpiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="otp_code_expired",
                title="Код истёк",
                detail=str(exc),
            ) from exc
        except services.OTPInvalidCodeError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="otp_invalid_code",
                title="Неверный код",
                detail=str(exc),
            ) from exc
        return Response(TokenPairSerializer(tokens).data, status=status.HTTP_200_OK)


class _EmailLoginView(_AnonymousAuthView):
    """Вход «e-mail + код» (ADR-168). Отдельный тумблер EMAIL_LOGIN_ENABLED,
    не общий с телефоном: каналы разные (почту доставляет реальный
    провайдер, ADR-111, а SMS-гейтвея в проекте нет вовсе) и выключать их
    приходится по разным причинам. Приём тот же, что у _PhoneLoginView:
    проверка во вьюхе, до сервиса, чтобы при выключенном входе письмо не
    уходило и rate-limit не грелся; код различим фронтом
    (`email_login_disabled`), а не обобщённый «нет прав»."""

    def initial(self, request: Request, *args: Any, **kwargs: Any) -> None:
        super().initial(request, *args, **kwargs)
        if not settings.EMAIL_LOGIN_ENABLED:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="email_login_disabled",
                title="Вход по e-mail отключён",
                detail="Войдите через аккаунт Google.",
            )


class EmailOTPRequestView(_EmailLoginView):
    permission_classes = [AllowAny]

    @extend_schema(request=EmailOTPRequestSerializer, responses={200: None})
    def post(self, request: Request) -> Response:
        serializer = EmailOTPRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.request_email_otp(
                serializer.validated_data["email"],
                # Язык письма — язык запроса (SPA шлёт Accept-Language из
                # активного языка интерфейса); пользователя ещё может не
                # быть, спросить его настройку не у кого.
                locale_hint=resolve_signup_locale(request),
            )
        except services.OTPRateLimitedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="otp_rate_limited",
                title="Слишком много запросов кода",
                detail=str(exc),
                # Точный остаток окна знает только кеш; отдаём длину окна —
                # тот же приём, что archive_link_view (ADR-168).
                retry_after=services.OTP_REQUEST_WINDOW_SECONDS,
            ) from exc
        # «Есть ли такой аккаунт» здесь не раскрывается никогда: ответ один и
        # тот же для известного и неизвестного адреса. dev_hint — как у
        # телефона, только при фиксированном dev-коде (в проде пусто).
        if settings.OTP_FIXED_CODE and not settings.PRODUCTION_PROFILE:
            return Response({"dev_hint": settings.OTP_FIXED_CODE})
        return Response(status=status.HTTP_200_OK)


class EmailOTPVerifyView(_EmailLoginView):
    permission_classes = [AllowAny]

    @extend_schema(request=EmailOTPVerifySerializer, responses={200: TokenPairSerializer})
    def post(self, request: Request) -> Response:
        serializer = EmailOTPVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            _user, tokens = services.verify_email_otp(
                serializer.validated_data["email"],
                serializer.validated_data["code"],
                acting_profile_id=_acting_profile_id(request),
                locale_hint=resolve_signup_locale(request),
            )
        except services.OTPRateLimitedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="otp_rate_limited",
                title="Слишком много попыток проверки кода",
                detail=str(exc),
                # Счётчик попыток живёт столько же, сколько сам код.
                retry_after=services.email_otp_ttl_seconds(),
            ) from exc
        except services.OTPCodeExpiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="otp_code_expired",
                title="Код истёк",
                detail=str(exc),
            ) from exc
        except services.OTPInvalidCodeError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="otp_invalid_code",
                title="Неверный код",
                detail=str(exc),
            ) from exc
        return Response(TokenPairSerializer(tokens).data, status=status.HTTP_200_OK)


class GoogleAuthorizeUrlView(_AnonymousAuthView):
    """Второй способ входа рядом с OTP (ГВ.2) — анонимно, тот же приём
    PKCE+state, что ESIA (ADR-062), но без IsAuthenticated: на этом шаге
    пользователь ещё не существует (первый вход = регистрация)."""

    @extend_schema(responses={200: GoogleAuthorizeUrlSerializer})
    def get(self, request: Request) -> Response:
        url, state = services.build_google_authorize_url(provider=build_google_login_provider())
        return Response(GoogleAuthorizeUrlSerializer({"authorize_url": url, "state": state}).data)


class GoogleCallbackView(_AnonymousAuthView):
    permission_classes = [AllowAny]

    @extend_schema(request=GoogleCallbackRequestSerializer, responses={200: TokenPairSerializer})
    def post(self, request: Request) -> Response:
        serializer = GoogleCallbackRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            _user, tokens, _created = services.complete_google_login(
                code=serializer.validated_data["code"],
                state=serializer.validated_data["state"],
                provider=build_google_login_provider(),
                locale_hint=resolve_signup_locale(request),
            )
        except services.GoogleOAuthStateInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="google_oauth_state_invalid",
                title="Сессия входа через Google истекла или недействительна",
                detail=str(exc),
            ) from exc
        except services.GoogleOAuthCodeInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="google_oauth_code_invalid",
                title="Код Google не распознан",
                detail=str(exc),
            ) from exc
        return Response(TokenPairSerializer(tokens).data, status=status.HTTP_200_OK)


class TokenRefreshView(_AnonymousAuthView):
    permission_classes = [AllowAny]

    @extend_schema(request=RefreshRequestSerializer, responses={200: TokenPairSerializer})
    def post(self, request: Request) -> Response:
        serializer = RefreshRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            tokens = services.refresh_token_pair(serializer.validated_data["refresh"])
        except services.RefreshTokenInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="refresh_token_invalid",
                title="Refresh-токен недействителен",
                detail=str(exc),
            ) from exc
        return Response(TokenPairSerializer(tokens).data, status=status.HTTP_200_OK)


class LogoutView(_AnonymousAuthView):
    permission_classes = [AllowAny]

    @extend_schema(request=LogoutRequestSerializer, responses={204: None})
    def post(self, request: Request) -> Response:
        serializer = LogoutRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.logout(serializer.validated_data["refresh"])
        except services.RefreshTokenInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="refresh_token_invalid",
                title="Refresh-токен недействителен",
                detail=str(exc),
            ) from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        return Response(UserMeSerializer(cast(User, request.user)).data)

    @extend_schema(request=UserMeUpdateSerializer, responses={200: UserMeSerializer})
    def patch(self, request: Request) -> Response:
        serializer = UserMeUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            user: User = services.update_profile(
                cast(User, request.user),
                email=serializer.validated_data.get("email"),
                # services.update_profile's kwarg остаётся "full_name" (верный
                # доменный термин, тот же User.full_name_encrypted) — на границе
                # API это "display_name" (UserMeUpdateSerializer, см. комментарий там).
                full_name=serializer.validated_data.get("display_name"),
                country_code=serializer.validated_data.get("country_code"),
                locale=serializer.validated_data.get("locale"),
                phone=serializer.validated_data.get("phone"),
            )
        except services.PhoneInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="phone_invalid",
                title="Телефон в неверном формате",
                detail=str(exc),
            ) from exc
        except services.PhoneTakenError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="phone_taken",
                title="Номер уже занят",
                detail=str(exc),
            ) from exc
        return Response(UserMeSerializer(user).data)

    @extend_schema(responses={202: AccountDeletedSerializer})
    def delete(self, request: Request) -> Response:
        """DELETE /users/me — удаление аккаунта самим пользователем (ADR-169,
        требование Google Play). `Idempotency-Key` НЕ требуется: операция не
        денежная и не подписная, а повторить её второй раз физически нельзя —
        после ответа токены предъявителя недействительны (`is_active=False`),
        и следующий такой же запрос упрётся в 401.

        202, а не 204: tech-spec.md §8.1 («202 + процесс») — ПД уничтожаются
        здесь же, синхронно, но байты в объектном хранилище и подписчики
        события `account.deleted` доедают хвост асинхронно."""
        try:
            deleted_at = services.delete_account(
                cast(User, request.user), acting_profile_id=_acting_profile_id(request)
            )
        except services.AccountDeletionBlockedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="account_deletion_blocked",
                title="Сначала завершите активные сделки",
                detail=str(exc),
                # Счётчики, а не ПД: фронт показывает, сколько именно сделок
                # и споров держат удаление.
                context=exc.holds,
            ) from exc
        return Response(
            AccountDeletedSerializer({"deleted_at": deleted_at}).data,
            status=status.HTTP_202_ACCEPTED,
        )


class DeviceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=UserDeviceSerializer, responses={201: UserDeviceSerializer})
    def post(self, request: Request) -> Response:
        serializer = UserDeviceSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        device = services.register_device(
            cast(User, request.user),
            platform=serializer.validated_data["platform"],
            push_token=serializer.validated_data.get("push_token", ""),
        )
        return Response(UserDeviceSerializer(device).data, status=status.HTTP_201_CREATED)


class DeviceKeyCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=DeviceKeySerializer, responses={201: DeviceKeySerializer})
    def post(self, request: Request, device_id: int) -> Response:
        serializer = DeviceKeySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            public_key = base64.b64decode(serializer.validated_data["public_key"], validate=True)
        except binascii.Error as exc:
            raise DomainAPIError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="invalid_public_key",
                title="public_key должен быть валидным base64",
            ) from exc
        try:
            device_key = services.register_device_key(
                cast(User, request.user),
                device_id,
                public_key=public_key,
                algorithm=serializer.validated_data["algorithm"],
            )
        except services.DeviceNotFoundError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="device_not_found",
                title="Устройство не найдено",
                detail=str(exc),
            ) from exc
        return Response(DeviceKeySerializer(device_key).data, status=status.HTTP_201_CREATED)


class GoogleDriveConnectAuthorizeUrlView(APIView):
    """GET /users/me/drive/connect/authorize-url (ADR-084, docs/tasks/
    Задача_feat_evidence-drive.md §2.2) — инкрементальная авторизация,
    ОТДЕЛЬНО от логина (GoogleAuthorizeUrlView выше не трогается):
    IsAuthenticated, потому что здесь связываем Drive-доступ с уже
    существующим пользователем, а не входим впервые."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: GoogleDriveConnectAuthorizeUrlSerializer})
    def get(self, request: Request) -> Response:
        url, state = services.build_drive_connect_authorize_url(
            cast(User, request.user), provider=build_drive_oauth_provider()
        )
        return Response(
            GoogleDriveConnectAuthorizeUrlSerializer({"authorize_url": url, "state": state}).data
        )


class GoogleDriveConnectCallbackView(APIView):
    """POST /users/me/drive/connect/callback."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=GoogleDriveConnectCallbackRequestSerializer, responses={200: None})
    def post(self, request: Request) -> Response:
        serializer = GoogleDriveConnectCallbackRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            services.complete_drive_connect(
                user=cast(User, request.user),
                code=serializer.validated_data["code"],
                state=serializer.validated_data["state"],
                provider=build_drive_oauth_provider(),
            )
        except services.DriveConnectStateInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="drive_connect_state_invalid",
                title="Сессия подключения Drive истекла или недействительна",
                detail=str(exc),
            ) from exc
        except services.DriveConnectCodeInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="drive_connect_code_invalid",
                title="Код Google не распознан или не дал доступ офлайн",
                detail=str(exc),
            ) from exc
        except services.DriveNoGoogleLoginError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="drive_no_google_login",
                title="Сначала нужно войти через Google, потом подключить Drive",
                detail=str(exc),
            ) from exc
        return Response(status=status.HTTP_200_OK)


class GoogleDriveGrantStatusView(APIView):
    """GET /users/me/drive/connect — статус подключения (ГВ.3 п.3: «статус
    бэкапа виден пользователю»). DELETE — отзыв со стороны продукта."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: GoogleDriveGrantStatusSerializer})
    def get(self, request: Request) -> Response:
        connected = services.has_drive_grant(cast(User, request.user))
        return Response(GoogleDriveGrantStatusSerializer({"connected": connected}).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request) -> Response:
        services.revoke_drive_grant(cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)
