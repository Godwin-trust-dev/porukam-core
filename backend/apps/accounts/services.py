"""Use cases apps.accounts (tech-spec.md §7.2, §7.3, §8.1)."""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import structlog
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from django.utils.module_loading import import_string
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from common import outbox
from common.crypto import decrypt_for_subject, destroy_subject_key, encrypt_for_subject

from .models import DeviceKey, GoogleDriveGrant, SocialLoginAccount, User, UserDevice
from .providers import (
    GoogleDriveGrantInvalidError,
    GoogleDriveOAuthProvider,
    GoogleOAuthProvider,
    InvalidGoogleAuthorizationCodeError,
    InvalidGoogleDriveAuthorizationCodeError,
    SMSGateway,
)

logger = structlog.get_logger(__name__)

OTP_CODE_TTL_SECONDS = 5 * 60
# Срок кода из ПИСЬМА — отдельный (settings.EMAIL_OTP_CODE_TTL_SECONDS,
# дефолт 15 минут): письмо идёт через внешнего провайдера и может лежать в
# очереди минуту-две. Значение читается функцией, а не константой модуля,
# чтобы override_settings в тестах и прод-env реально влияли.
EMAIL_OTP_CODE_TTL_FALLBACK_SECONDS = 15 * 60
OTP_REQUEST_LIMIT = 3
OTP_REQUEST_WINDOW_SECONDS = 10 * 60
OTP_VERIFY_ATTEMPT_LIMIT = 5


def email_otp_ttl_seconds() -> int:
    """Срок жизни кода входа по e-mail в секундах (настройка
    EMAIL_OTP_CODE_TTL_SECONDS). Тем же сроком живёт окно попыток проверки и
    тем же числом подписан текст письма."""
    return int(getattr(settings, "EMAIL_OTP_CODE_TTL_SECONDS", EMAIL_OTP_CODE_TTL_FALLBACK_SECONDS))


class OTPRateLimitedError(ValueError):
    """Превышен лимит запросов/попыток OTP (tech-spec.md §7.8, Redis)."""


class OTPInvalidCodeError(ValueError):
    """Код не совпадает с отправленным."""


class OTPCodeExpiredError(ValueError):
    """Код истёк (или не запрашивался для этого телефона)."""


class RefreshTokenInvalidError(ValueError):
    """Refresh-токен недействителен: истёк, отозван или уже был использован
    ротацией (повторное использование — признак кражи токена)."""


def _otp_code_cache_key(phone: str) -> str:
    return f"otp:code:{phone}"


def _otp_request_count_cache_key(phone: str) -> str:
    return f"otp:requests:{phone}"


def _otp_verify_attempts_cache_key(phone: str) -> str:
    return f"otp:attempts:{phone}"


# Ключи e-mail-входа (ADR-168) — в отдельном пространстве имён `otp:email:*`.
# Телефон и почта не пересекаются по значению ключа физически (E.164 против
# адреса), но одинаковые лимиты на РАЗНЫХ каналах должны считаться
# независимо: исчерпанные попытки кода в письме не должны гасить вход по
# SMS того же человека и наоборот.
def _email_code_cache_key(email: str) -> str:
    return f"otp:email:code:{email}"


def _email_request_count_cache_key(email: str) -> str:
    return f"otp:email:requests:{email}"


def _email_verify_attempts_cache_key(email: str) -> str:
    return f"otp:email:attempts:{email}"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _generate_code() -> str:
    fixed: str | None = settings.OTP_FIXED_CODE
    if fixed:
        return fixed
    return f"{secrets.randbelow(1_000_000):06d}"


def _increment_with_window(key: str, *, window_seconds: int) -> int:
    """Атомарный инкремент с окном истечения. cache.incr бросает ValueError
    на отсутствующий ключ — это и есть "первый запрос в окне"."""
    try:
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=window_seconds)
        return 1


def _generate_trust_id() -> str:
    """Непубличный сквозной идентификатор субъекта (tech-spec.md §5.1).
    НИКОГДА не должен уходить в API-ответы (проверяется тестами api)."""
    return secrets.token_hex(16)


def request_otp(phone: str, *, gateway: SMSGateway) -> None:
    """Телефон+SMS — вход RU-волны, в GLOBAL не предлагается (ГВ.2/ГВ.5,
    docs/tasks/global-wave.md: «в GLOBAL ни одна ветка кода не пытается
    отправить SMS»). Здесь нет проверки контура — запрос анонимный
    (телефон без пользователя, до входа), контура ещё физически неоткуда
    взять. Это не пробел: этот флоу — вход по RU-каналу по построению
    (ГВ.2), GLOBAL-пользователи сюда не попадают (используют Google-вход,
    apps.accounts.services.complete_google_login). Контур-зависимая
    SMS-развилка — в apps.notifications.services.place_notification (там
    получатель уже известен)."""
    count = _increment_with_window(
        _otp_request_count_cache_key(phone), window_seconds=OTP_REQUEST_WINDOW_SECONDS
    )
    if count > OTP_REQUEST_LIMIT:
        logger.warning("otp.request_rate_limited", phone=phone, count=count)
        raise OTPRateLimitedError(f"превышен лимит запросов кода для {phone}")

    code = _generate_code()
    cache.set(_otp_code_cache_key(phone), _hash_code(code), timeout=OTP_CODE_TTL_SECONDS)
    cache.delete(_otp_verify_attempts_cache_key(phone))
    gateway.send_sms(phone, f"Код подтверждения Porukam: {code}")


@dataclass(frozen=True, slots=True)
class TokenPair:
    access: str
    refresh: str


@transaction.atomic
def verify_otp(
    phone: str,
    code: str,
    *,
    acting_profile_id: str | None = None,
    locale_hint: str | None = None,
) -> tuple[User, TokenPair]:
    """locale_hint — язык запроса (common.i18n.resolve_signup_locale), см.
    _remember_locale: фиксируется в профиле при регистрации и при входе того,
    у кого языка ещё нет."""
    attempts = _increment_with_window(
        _otp_verify_attempts_cache_key(phone), window_seconds=OTP_CODE_TTL_SECONDS
    )
    if attempts > OTP_VERIFY_ATTEMPT_LIMIT:
        logger.warning("otp.verify_rate_limited", phone=phone, attempts=attempts)
        raise OTPRateLimitedError(f"превышено число попыток проверки кода для {phone}")

    stored_hash = cache.get(_otp_code_cache_key(phone))
    if stored_hash is None:
        raise OTPCodeExpiredError("код истёк или не запрашивался")
    if not secrets.compare_digest(stored_hash, _hash_code(code)):
        raise OTPInvalidCodeError("неверный код")

    cache.delete(_otp_code_cache_key(phone))
    cache.delete(_otp_verify_attempts_cache_key(phone))

    user, created = User.objects.get_or_create(
        phone=phone,
        defaults={
            "trust_id": _generate_trust_id(),
            "verification_level": User.VerificationLevel.BASIC,
            # Телефон+SMS — вход RU-волны, в GLOBAL не предлагается (ГВ.2,
            # docs/tasks/global-wave.md) — контур известен уже на регистрации,
            # не нужно ждать явного выбора страны (ГВ.5, ADR-075: страна —
            # по-прежнему МЕНЯЕМА пользователем самостоятельно потом, это
            # только стартовое значение).
            #
            # Здесь литерал ОСТАЁТСЯ, хотя в Google-входе снят (ADR-148), и
            # это не непоследовательность: country_code решает, ПО КАКОМУ
            # ПРАВУ живёт договор. Обнулить его этой ветке значило бы увести
            # действующих пользователей RU-волны в контур GLOBAL — правовое
            # последствие, а не улучшение статистики. Выводить страну из
            # префикса номера тоже нельзя: +7 — это и Казахстан.
            "country_code": "RU",
        },
    )
    if created:
        user.set_unusable_password()
        user.save(update_fields=["password"])
    _remember_locale(user, locale_hint)

    tokens = _issue_token_pair(user)

    outbox.publish(
        "account.logged_in",
        subject={"type": "user", "id": str(user.id)},
        # `method` — способ входа. Раньше его писал только Google-вход
        # (ADR-071); с ADR-168 способов три, и разрез «чем входят» имеет
        # смысл только если поле есть у ВСЕХ. Подписчику apps.profiles
        # (единственному на этот топик) поле безразлично — он читает
        # `created`.
        payload={"created": created, "method": "phone"},
        actor={"user_id": str(user.id), "profile_id": acting_profile_id},
    )
    return user, tokens


def _remember_locale(user: User, locale_hint: str | None) -> None:
    """Язык интерфейса в профиль — на регистрации и на входе тех, у кого его
    ещё нет (ADR-148).

    Зачем вообще: до этого `User.locale` писал ТОЛЬКО переключатель языка
    (PATCH /users/me), то есть поле заполнялось лишь у того, кто язык менял
    руками. На проде 31.08 оно было пустым у 7 из 9 — а от него зависит язык
    писем и уведомлений (готовятся вне HTTP-запроса, Accept-Language там
    взять неоткуда) и весь языковой разрез аналитики.

    Существующий выбор НИКОГДА не перетирается: условие `user.locale` пустое —
    это не «синхронизация с браузером», а разовое заполнение пустоты. Поэтому
    вызов безопасен и на повторных входах: человек, переключивший язык на
    другом устройстве, не получит его обратно чужим заголовком.

    Значение — уже разрешённый код (совпал со встроенной парой или с
    включённым apps.l10n.Locale), не сырой заголовок."""
    if not locale_hint or user.locale:
        return
    user.locale = locale_hint
    user.save(update_fields=["locale"])


def _issue_token_pair(user: User) -> TokenPair:
    refresh = RefreshToken.for_user(user)
    return TokenPair(access=str(refresh.access_token), refresh=str(refresh))


# --- Вход «e-mail + код» (ADR-168, решение владельца 06.09) — третий способ
# входа рядом с телефоном и Google. Пароля нет (его нет нигде в продукте,
# см. UserManager) и magic-link нет: ссылка из письма открывается во внешнем
# браузере и выбрасывает человека из PWA/TWA-сессии, код — не выбрасывает.


def normalize_email(raw: str) -> str:
    """Единый вид адреса для ключей кеша и поиска: trim + lower.

    Регистр не значим ни для одной части адреса в реальной почте, и
    `User.email` лежит в БД с CI-collation — «Foo@X.com» и «foo@x.com»
    обязаны быть одним и тем же входом, иначе лимит запросов обходится
    сменой регистра. Формат проверяет сериализатор (EmailField), здесь —
    только нормализация; точки/плюсы в локальной части НЕ трогаются: их
    трактовка — дело почтового провайдера, а не наше."""
    return raw.strip().lower()


def _is_reviewer_email(normalized: str) -> bool:
    """Адрес демо-аккаунта для ревью сторов (ADR-168): пара
    EMAIL_LOGIN_REVIEWER_EMAIL/EMAIL_LOGIN_REVIEWER_CODE. Обе настройки
    должны быть непусты — половина конфигурации механизма не включает.

    Ключевое отличие от OTP_FIXED_CODE: фиксированный код действует ровно
    для ЭТОГО адреса и ни для какого другого."""
    reviewer_email = str(getattr(settings, "EMAIL_LOGIN_REVIEWER_EMAIL", "") or "").strip().lower()
    reviewer_code = str(getattr(settings, "EMAIL_LOGIN_REVIEWER_CODE", "") or "")
    return bool(reviewer_email) and bool(reviewer_code) and normalized == reviewer_email


def request_email_otp(email: str, *, locale_hint: str | None = None) -> None:
    """POST /auth/email/request. Существование адреса в системе НЕ
    раскрывается: письмо уходит (или не уходит) молча, ответ всегда один —
    иначе эндпоинт превращается в проверялку «есть ли у вас аккаунт».

    Лимиты — те же, что у телефона (OTP_REQUEST_LIMIT в окне
    OTP_REQUEST_WINDOW_SECONDS), счётчик по нормализованному адресу.

    Недоставленное письмо (провайдер лёг) исключения не бросает — код в кеше
    всё равно живёт, человек нажмёт «отправить ещё раз»; сажать вход на
    доступность внешнего провайдера в момент запроса не нужно."""
    normalized = normalize_email(email)
    count = _increment_with_window(
        _email_request_count_cache_key(normalized), window_seconds=OTP_REQUEST_WINDOW_SECONDS
    )
    if count > OTP_REQUEST_LIMIT:
        logger.warning("otp.email_request_rate_limited", email=normalized, count=count)
        raise OTPRateLimitedError(f"превышен лимит запросов кода для {normalized}")

    if _is_reviewer_email(normalized):
        # Демо-аккаунт ревью (ADR-168): ящика у проверяющего нет, письмо
        # слать некуда и незачем — код у него уже есть из формы App access.
        # Ответ снаружи неотличим от обычного (200), кеш кода не трогаем:
        # его роль играет EMAIL_LOGIN_REVIEWER_CODE в verify.
        logger.info("otp.reviewer_code_requested", email=normalized)
        return

    code = _generate_code()
    ttl_seconds = email_otp_ttl_seconds()
    cache.set(_email_code_cache_key(normalized), _hash_code(code), timeout=ttl_seconds)
    cache.delete(_email_verify_attempts_cache_key(normalized))

    # Фасад чужого приложения ЧЕРЕЗ import_string (settings.
    # LOGIN_CODE_EMAIL_SENDER) — тот же приём, что USER_ME_PROFILES_SELECTOR
    # и USER_ME_HANDLE_SELECTOR: статического импорта apps.accounts ->
    # apps.notifications быть не может, он «протёк» бы транзитивной
    # зависимостью на apps.social и сломал бы контракт import-linter (тот
    # видит и отложенные импорты внутри функций). Про Resend и вёрстку
    # письма apps.accounts не знает ничего — только «отправить код на адрес».
    send_login_code = import_string(settings.LOGIN_CODE_EMAIL_SENDER)
    # Число минут передаётся АРГУМЕНТОМ: настройка живёт в apps.accounts,
    # а apps.notifications про неё знать не должен (границы приложений).
    result = send_login_code(
        email=normalized,
        code=code,
        locale=locale_hint,
        # Округление вниз, но не меньше минуты: «действует 0 минут» не пишем.
        minutes=max(1, ttl_seconds // 60),
    )
    if not result.delivered:
        logger.warning("otp.email_not_delivered", email=normalized, status=result.status)


@transaction.atomic
def verify_email_otp(
    email: str,
    code: str,
    *,
    acting_profile_id: str | None = None,
    locale_hint: str | None = None,
) -> tuple[User, TokenPair]:
    """POST /auth/email/verify. Введённый код доказывает владение ЯЩИКОМ —
    и только это. Правило связывания (ADR-168):

    1. Есть пользователь, у которого адрес ПОДТВЕРЖДЁН (`email_verified_at`
       или совпадение с почтой Google-связки) — входим в него.
    2. Адрес занят чужим НЕподтверждённым `User.email` (человек вписал его
       сам через PATCH /users/me) — связывать НЕЛЬЗЯ: иначе достаточно
       вписать чужой адрес в свой профиль, чтобы владелец ящика вошёл в
       чужие сделки. Адрес у того пользователя обнуляется (он его не
       подтверждал), публикуется `account.email_unlinked`, вход идёт в НОВЫЙ
       аккаунт.
    3. Иначе — регистрация (как в complete_google_login: trust_id,
       verification_level, страна НЕ проставляется, ADR-148).

    Ошибки и лимиты — те же исключения, что у телефонного verify (вьюха
    маппит их в те же коды problem+json).

    Демо-аккаунт ревью сторов (`_is_reviewer_email`) отличается ТОЛЬКО
    источником кода (настройка вместо кеша) — правило связывания, создание
    пользователя и события у него общие с остальными."""
    normalized = normalize_email(email)
    attempts = _increment_with_window(
        _email_verify_attempts_cache_key(normalized), window_seconds=email_otp_ttl_seconds()
    )
    if attempts > OTP_VERIFY_ATTEMPT_LIMIT:
        logger.warning("otp.email_verify_rate_limited", email=normalized, attempts=attempts)
        raise OTPRateLimitedError(f"превышено число попыток проверки кода для {normalized}")

    reviewer = _is_reviewer_email(normalized)
    if reviewer:
        # Демо-аккаунт ревью (ADR-168): код фиксирован настройкой и не живёт
        # в кеше — истечь ему нечему. Лимит попыток выше действует обычный.
        if not secrets.compare_digest(str(settings.EMAIL_LOGIN_REVIEWER_CODE), code):
            raise OTPInvalidCodeError("неверный код")
        logger.info("otp.reviewer_login", email=normalized)
    else:
        stored_hash = cache.get(_email_code_cache_key(normalized))
        if stored_hash is None:
            raise OTPCodeExpiredError("код истёк или не запрашивался")
        if not secrets.compare_digest(stored_hash, _hash_code(code)):
            raise OTPInvalidCodeError("неверный код")

    cache.delete(_email_code_cache_key(normalized))
    cache.delete(_email_verify_attempts_cache_key(normalized))

    user, created, unlinked_from = _resolve_user_for_verified_email(normalized)
    _remember_locale(user, locale_hint)

    tokens = _issue_token_pair(user)

    if unlinked_from is not None:
        # Адрес отобран у того, кто его не подтверждал. Самого адреса в
        # payload нет намеренно: событие уходит в ленту и аудит, а ПД там
        # дублировать незачем — субъект и новый владелец опознаются по id.
        outbox.publish(
            "account.email_unlinked",
            subject={"type": "user", "id": str(unlinked_from)},
            payload={"reason": "email_confirmed_by_other", "claimed_by_user_id": str(user.id)},
            actor={"user_id": str(user.id)},
        )
    outbox.publish(
        "account.logged_in",
        subject={"type": "user", "id": str(user.id)},
        payload={"created": created, "method": "email"},
        actor={"user_id": str(user.id), "profile_id": acting_profile_id},
    )
    return user, tokens


def _resolve_user_for_verified_email(normalized: str) -> tuple[User, bool, UUID | None]:
    """Кому принадлежит доказанный адрес: (пользователь, создан ли,
    у кого адрес отобран). Правило целиком — в докстринге verify_email_otp."""
    verified_owner = User.objects.filter(
        email__iexact=normalized, email_verified_at__isnull=False
    ).first()
    if verified_owner is not None:
        return verified_owner, False, None

    # Почта Google-связки подтверждена самим Google — это тот же уровень
    # доказательства, что и наш код (ADR-071: `sub` — ключ связки, `email` —
    # обновляемый на каждый вход атрибут связки).
    linked = (
        User.objects.filter(social_login_accounts__email__iexact=normalized)
        .order_by("created_at")
        .first()
    )
    # `email` уникален (CI-collation), поэтому претендент на адрес не более
    # одного, и подтверждения у него нет — иначе он вернулся бы выше.
    squatter = User.objects.filter(email__iexact=normalized).first()
    unlinked_from: UUID | None = None
    if squatter is not None and (linked is None or squatter.pk != linked.pk):
        squatter.email = None
        squatter.save(update_fields=["email"])
        unlinked_from = squatter.pk

    if linked is not None:
        _mark_email_verified(linked, normalized)
        return linked, False, unlinked_from

    user = User.objects.create(
        trust_id=_generate_trust_id(),
        verification_level=User.VerificationLevel.BASIC,
        # Страна НЕ проставляется — ровно как в complete_google_login
        # (ADR-148): country_code хранит явный выбор пользователя, а вход по
        # почте не говорит о стране ничего (в отличие от RU-волны SMS).
        country_code=None,
        email=normalized,
        email_verified_at=timezone.now(),
    )
    user.set_unusable_password()
    user.save(update_fields=["password"])
    return user, True, unlinked_from


def _mark_email_verified(user: User, normalized: str) -> None:
    """Отметка подтверждения на существующем аккаунте. Чужой (отличный от
    доказанного) `User.email` НЕ перетирается: это self-service поле, а
    доказано владение только тем ящиком, куда пришёл код."""
    update_fields: list[str] = []
    if not user.email:
        user.email = normalized
        update_fields.append("email")
    if (user.email or "").lower() == normalized and user.email_verified_at is None:
        user.email_verified_at = timezone.now()
        update_fields.append("email_verified_at")
    if update_fields:
        user.save(update_fields=update_fields)


# --- Google OAuth (ГВ.2, docs/tasks/global-wave.md, ADR-071) — второй способ
# входа рядом с OTP: телефон+SMS остаётся для RU-волны, в GLOBAL не
# предлагается (профиль контура читается выше по стеку, apps.jurisdictions
# ГВ.1 — сам вход здесь работает независимо от контура пользователя).

GOOGLE_OAUTH_STATE_TTL_SECONDS = 5 * 60


class GoogleOAuthStateInvalidError(ValueError):
    """state не найден или истёк.

    В отличие от EsiaStateInvalidError (ADR-062) здесь нечего сверять с
    "владельцем" state — вход анонимный, пользователя ещё не существует на
    шаге authorize-url (первый вход = регистрация)."""


class GoogleOAuthCodeInvalidError(ValueError):
    """Провайдер не распознал код авторизации."""


def _google_oauth_state_cache_key(state: str) -> str:
    return f"google_oauth:state:{state}"


def _code_challenge(code_verifier: str) -> str:
    """PKCE S256 (тот же приём, что apps.identity.services._code_challenge,
    ADR-062) — не вынесено в common: единственные два потребителя, оба уже
    существуют, извлекать абстракцию раньше второго реального применения
    внутри одного приложения смысла не имеет; между apps.accounts/apps.identity
    дублирование пяти строк дешевле, чем создавать между ними зависимость
    в любую сторону."""
    digest = hashlib.sha256(code_verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_google_authorize_url(*, provider: GoogleOAuthProvider) -> tuple[str, str]:
    """GET /auth/google/authorize-url. Анонимный вход: state привязан
    только к code_verifier, не к пользователю (сравни с ESIA
    build_authorize_url, где state несёт user_id — там пользователь уже
    аутентифицирован и повышает verification_level)."""
    state = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(32)
    cache.set(
        _google_oauth_state_cache_key(state),
        {"code_verifier": code_verifier},
        timeout=GOOGLE_OAUTH_STATE_TTL_SECONDS,
    )
    url = provider.authorize_url(state=state, code_challenge=_code_challenge(code_verifier))
    return url, state


@transaction.atomic
def complete_google_login(
    *,
    code: str,
    state: str,
    provider: GoogleOAuthProvider,
    locale_hint: str | None = None,
) -> tuple[User, TokenPair, bool]:
    """POST /auth/google/callback. `sub` — стабильный ключ связки
    (SocialLoginAccount.provider+sub): первый вход тем же sub = регистрация,
    повторный — тот же User (тот же SimpleJWT-контур, что и OTP,
    account.logged_in публикуется тем же топиком).

    `email` — обновляемый атрибут связки (перечитывается каждый вход);
    `User.email` подставляется из него только при регистрации и дальше не
    трогается отсюда — PATCH /users/me остаётся единственным self-service
    способом менять её (см. docstring SocialLoginAccount).

    locale_hint — язык запроса (common.i18n.resolve_signup_locale), см.
    _remember_locale."""
    cached = cache.get(_google_oauth_state_cache_key(state))
    if cached is None:
        raise GoogleOAuthStateInvalidError(f"state {state!r} не найден или истёк")
    cache.delete(_google_oauth_state_cache_key(state))

    try:
        # Настоящий PKCE (docs/tasks/Задача_feat_accounts-google-login-real.md
        # §2.1, «вариант 3»): code_verifier не просто кешировался — теперь
        # реально идёт в обмен кода у RealGoogleOAuthProvider.
        identity = provider.complete(code=code, code_verifier=cached["code_verifier"])
    except InvalidGoogleAuthorizationCodeError as exc:
        raise GoogleOAuthCodeInvalidError(str(exc)) from exc

    link = (
        SocialLoginAccount.objects.select_related("user")
        .filter(provider=provider.provider_code, sub=identity.sub)
        .first()
    )
    created = link is None
    if link is None:
        # SocialLoginAccount.user — NOT NULL (связка без пользователя не
        # существует), поэтому User создаётся первым, а не через
        # get_or_create(defaults=...) — тому понадобился бы промежуточный
        # ряд без user.
        #
        # Почта Google подставляется как стартовое значение User.email,
        # только если её ещё никто не занял (уникальное поле) — коллизия не
        # должна ронять регистрацию, профиль просто остаётся без почты до
        # PATCH /users/me.
        initial_email = (
            identity.email
            if identity.email and not User.objects.filter(email=identity.email).exists()
            else None
        )
        user = User.objects.create(
            trust_id=_generate_trust_id(),
            verification_level=User.VerificationLevel.BASIC,
            # Страна НЕ проставляется (ADR-148). Раньше здесь стоял литерал
            # GLOBAL «контур по построению» (ГВ.2/ГВ.5) — и он же противоречил
            # контракту поля: «country_code — ТОЛЬКО явный выбор пользователя,
            # NULL — ещё не выбрал» (User.country_code). Резолвится это
            # одинаково (NULL и GLOBAL оба дают контур GLOBAL,
            # jurisdictions.selectors.resolve_jurisdiction), а на карте
            # продукта литерал выглядел как выбранная страна: на проде 31.08
            # «GLOBAL» стояло у 5 аккаунтов из 9, и ни один его не выбирал.
            # Старые строки не мигрируем — аналитика различает их отдельной
            # причиной `global_default` против `never_set` (ADR-145).
            country_code=None,
            email=initial_email,
        )
        user.set_unusable_password()
        user.save(update_fields=["password"])
        link = SocialLoginAccount.objects.create(
            user=user, provider=provider.provider_code, sub=identity.sub, email=identity.email
        )
    else:
        user = link.user
        if link.email != identity.email:
            link.email = identity.email
            link.save(update_fields=["email"])
    _remember_locale(user, locale_hint)

    tokens = _issue_token_pair(user)

    payload: dict[str, Any] = {"created": created, "method": provider.provider_code}
    if created and identity.picture:
        # ADR-103: стартовое фото — ТОЛЬКО при регистрации; подписчик
        # apps.profiles скачает свою уменьшенную копию в фоне. Повторные
        # входы ссылку не несут — загруженное/удалённое пользователем фото
        # Google не перетирает.
        payload["avatar_source_url"] = identity.picture
    outbox.publish(
        "account.logged_in",
        subject={"type": "user", "id": str(user.id)},
        payload=payload,
        actor={"user_id": str(user.id)},
    )
    return user, tokens, created


def _rotation_grace_key(jti: str) -> str:
    return f"accounts:refresh_grace:{jti}"


def refresh_token_pair(refresh_raw: str) -> TokenPair:
    """Ротация refresh-токена (tech-spec.md §7.2): старый блэклистится,
    выдаётся новая пара. Повторное предъявление уже провёрнутого токена —
    RefreshTokenInvalidError (blacklist-приложение SimpleJWT).

    Grace-окно ротации (ADR-108): в течение REFRESH_ROTATION_GRACE_SECONDS
    после ротации повторное предъявление ТОГО ЖЕ старого токена возвращает
    ТУ ЖЕ новую пару, а не 401. Закрывает гонку двух вкладок/PWA+браузер
    (обе держат один refresh, первая провернула — вторая получала 401 и
    разлогинивала обе) и сетевой ретрай, когда ответ с новой парой до
    клиента не дошёл. Токен, отозванный через logout, в окно не попадает —
    ключ в кэше ставит только ротация."""
    try:
        # rest_framework_simplejwt типизирует token как Token | None, но
        # runtime принимает raw JWT-строку (см. Token.__init__) — неточность
        # апстримных типов, не наша.
        old_token = RefreshToken(refresh_raw)  # type: ignore[arg-type]
    except TokenError as exc:
        graced = _graced_pair_for_rotated_token(refresh_raw)
        if graced is not None:
            return graced
        raise RefreshTokenInvalidError(str(exc)) from exc

    user_id = old_token["user_id"]
    old_jti = old_token["jti"]
    try:
        old_token.blacklist()
    except TokenError as exc:
        raise RefreshTokenInvalidError(str(exc)) from exc

    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist as exc:
        raise RefreshTokenInvalidError("пользователь не найден") from exc
    if not user.is_active:
        # Удалённый (ADR-169) или заблокированный аккаунт: refresh не должен
        # выдавать новую пару. Access-токен деактивированного и так отвергает
        # JWTAuthentication (`user_inactive`), но без этой проверки сессия
        # продлевалась бы бесконечно — 401 приходил бы только на access.
        raise RefreshTokenInvalidError("аккаунт неактивен")

    pair = _issue_token_pair(user)
    grace = int(settings.REFRESH_ROTATION_GRACE_SECONDS)
    if grace > 0:
        cache.set(
            _rotation_grace_key(old_jti),
            {"access": pair.access, "refresh": pair.refresh},
            timeout=grace,
        )
    return pair


def _graced_pair_for_rotated_token(refresh_raw: str) -> TokenPair | None:
    """Пара, выданная при ротации этого токена < grace секунд назад, либо None.
    Подпись и срок проверяются бэкендом токенов (verify=True), блэклист —
    намеренно нет: токен уже в нём, в этом и смысл окна."""
    try:
        from rest_framework_simplejwt.state import token_backend

        payload = token_backend.decode(refresh_raw, verify=True)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — любая невалидность = окна нет
        return None
    jti = payload.get("jti")
    if not jti:
        return None
    cached = cache.get(_rotation_grace_key(str(jti)))
    if not isinstance(cached, dict):
        return None
    logger.info("accounts.refresh_grace_hit", jti=str(jti))
    return TokenPair(access=str(cached["access"]), refresh=str(cached["refresh"]))


def logout(refresh_raw: str) -> None:
    try:
        RefreshToken(refresh_raw).blacklist()  # type: ignore[arg-type]
    except TokenError as exc:
        raise RefreshTokenInvalidError(str(exc)) from exc


class PhoneInvalidError(ValueError):
    """Телефон не в формате E.164 («+» и 8–15 цифр)."""


class PhoneTakenError(ValueError):
    """Телефон уже указан другим пользователем (User.phone уникален)."""


def normalize_phone(raw: str) -> str:
    """Нормализация к E.164 (отсмотр 2026-08-24, «пусть через + вводят»):
    пробелы/скобки/дефисы срезаются, обязателен ведущий «+» и 8–15 цифр,
    первая — не ноль. Единый формат хранения = единый формат поиска."""
    cleaned = re.sub(r"[\s\-()]", "", raw)
    if not re.fullmatch(r"\+[1-9]\d{7,14}", cleaned):
        raise PhoneInvalidError("телефон вводится в международном формате: «+», код страны и номер")
    return cleaned


@transaction.atomic
def update_profile(
    user: User,
    *,
    email: str | None = None,
    full_name: str | None = None,
    country_code: str | None = None,
    locale: str | None = None,
    phone: str | None = None,
) -> User:
    """PATCH /users/me. has_business_status и trust_id здесь принципиально
    не участвуют — has_business_status меняет только set_business_status()
    (вызывается apps.entities в 3.4), trust_id неизменяем после создания.

    country_code — явный выбор пользователя (ГВ.1/ГВ.5, ADR-070/074): здесь
    НЕ валидируется против apps.jurisdictions — принимается любой код,
    fallback-резолвер (apps.accounts.selectors.get_user_locale и т. п.)
    сам решает при чтении, есть ли под него плагин.

    locale — язык интерфейса (ADR-095), по той же логике «пишем выбор,
    решаем при чтении». Пустая строка сбрасывает выбор в NULL (возврат к
    цепочке контур -> Accept-Language), как и у country_code."""
    update_fields = []
    if email is not None:
        new_email = email or None
        if (new_email or "").lower() != (user.email or "").lower():
            # Смена адреса СБРАСЫВАЕТ подтверждение (ADR-168): `email_verified_at`
            # относится к конкретному ящику, в который приходил код, а не к
            # аккаунту вообще. Без сброса вписанный руками чужой адрес
            # унаследовал бы чужое подтверждение — и владелец того ящика вошёл
            # бы в этот аккаунт по коду. Self-service поле подтверждения не
            # выдаёт никогда: его ставит только verify_email_otp.
            user.email = new_email
            user.email_verified_at = None
            update_fields += ["email", "email_verified_at"]
    if phone is not None:
        if phone.strip():
            normalized = normalize_phone(phone)
            if User.objects.exclude(pk=user.pk).filter(phone=normalized).exists():
                raise PhoneTakenError("этот номер уже указан у другого пользователя")
            user.phone = normalized
        else:
            # Пустая строка — удалить номер (находимость по телефону гаснет
            # сама: поиск требует phone IS NOT NULL).
            user.phone = None
        update_fields.append("phone")
    if full_name is not None:
        encrypted = encrypt_for_subject(full_name, subject_type="user", subject_id=user.id)
        user.full_name_encrypted = encrypted.ciphertext
        user.encryption_key_ref = encrypted.key_ref
        update_fields += ["full_name_encrypted", "encryption_key_ref"]
    if country_code is not None:
        user.country_code = country_code or None
        update_fields.append("country_code")
    if locale is not None:
        user.locale = locale or None
        update_fields.append("locale")
    if update_fields:
        user.save(update_fields=update_fields)
    return user


def register_device(user: User, *, platform: str, push_token: str = "") -> UserDevice:
    """POST /users/me/devices. Отдельная явная регистрация, не привязана к
    OTP-входу — на один аккаунт может быть несколько устройств одной
    платформы (разные телефоны), поэтому не update_or_create по (user,
    platform), а всегда новая запись."""
    return UserDevice.objects.create(user=user, platform=platform, push_token=push_token)


class DeviceNotFoundError(ValueError):
    """Устройство не принадлежит пользователю (или не существует) — во
    view переводится в 404, не в 403 (приватность, tech-spec.md §7.5)."""


def register_device_key(
    user: User, device_id: int, *, public_key: bytes, algorithm: str
) -> DeviceKey:
    """POST /users/me/devices/{id}/device-key (ADR-053 внешнего журнала).
    Приватный ключ сервер никогда не видит — только публичный."""
    try:
        device = UserDevice.objects.get(pk=device_id, user=user)
    except UserDevice.DoesNotExist as exc:
        raise DeviceNotFoundError(f"устройство {device_id} не найдено") from exc
    return DeviceKey.objects.create(
        device=device, user=user, public_key=public_key, algorithm=algorithm
    )


def set_business_status(user: User, value: bool) -> None:
    """ЕДИНСТВЕННЫЙ санкционированный способ изменить has_business_status.

    Facade для apps.entities.services (claim по ИНН/ФИО директора, этап
    3.4) — apps.accounts сам его не вызывает нигде. Не экспонирован через
    api/ (нет HTTP-эндпоинта, вызывается только межприложенческим кодом)."""
    user.has_business_status = value
    user.save(update_fields=["has_business_status"])


def set_phone_discoverability(user: User, value: bool) -> None:
    """ЕДИНСТВЕННЫЙ санкционированный способ изменить discoverable_by_phone.

    Facade для apps.social.services.record_consent (согласие
    phone_discoverability, docs/tasks/etap-3-delta-adr059.md §1.3) — apps.
    accounts сам его не вызывает нигде и не экспонирует через api/."""
    user.discoverable_by_phone = value
    user.save(update_fields=["discoverable_by_phone"])


def set_verified_identity(user: User, *, tax_id_hash: str | None) -> None:
    """ЕДИНСТВЕННЫЙ санкционированный способ поднять verification_level до
    verified и записать хеш ИНН, подтверждённый провайдером строгой
    идентификации.

    Facade для apps.identity.services (фейк-ЕСИА, этап 3.2) — apps.accounts
    сам его не вызывает нигде. Не экспонирован через api/ (нет отдельного
    HTTP-эндпоинта — вызывается только межприложенческим кодом)."""
    user.verification_level = User.VerificationLevel.VERIFIED
    update_fields = ["verification_level"]
    if tax_id_hash is not None:
        user.personal_tax_id_hash = tax_id_hash
        update_fields.append("personal_tax_id_hash")
    user.save(update_fields=update_fields)


# --- Google Drive BYO-бэкап: инкрементальная авторизация (ADR-084,
# docs/tasks/Задача_feat_evidence-drive.md §2.1-2.2) — ОТДЕЛЬНО от входа
# (`complete_google_login` выше не трогается): пользователь уже
# аутентифицирован (IsAuthenticated на вьюхах), здесь только связываем его
# Google-аккаунт с Drive-доступом. `apps.evidence` не импортирует
# GoogleDriveGrant напрямую — только через фасад get_drive_access_token()
# ниже (import-linter: apps.evidence → apps.accounts только через services).

GOOGLE_DRIVE_CONNECT_STATE_TTL_SECONDS = 5 * 60
# ADR-084: единственный допустимый Drive-scope продукта.
GOOGLE_DRIVE_GRANT_SCOPE = "https://www.googleapis.com/auth/drive.file"


class DriveNotConnectedError(ValueError):
    """К аккаунту не привязан Drive-грант — нужен connect-флоу
    (`build_drive_connect_authorize_url`/`complete_drive_connect`)."""


class DriveGrantRevokedError(ValueError):
    """Google вернул `invalid_grant` при рефреше (или грант отозван явно
    через `revoke_drive_grant`) — требуется повторный connect."""


class DriveConnectStateInvalidError(ValueError):
    """state не найден, истёк, либо выдан другому пользователю."""


class DriveConnectCodeInvalidError(ValueError):
    """Провайдер не распознал код Drive-подключения, либо не вернул
    refresh_token (offline-доступ не был предоставлен)."""


class DriveNoGoogleLoginError(ValueError):
    """К пользователю не привязан вход через Google (`SocialLoginAccount`)
    — подключать Drive нечем, сначала войти через Google (ADR-071)."""


def _drive_connect_state_cache_key(state: str) -> str:
    return f"google_drive_connect:state:{state}"


def build_drive_connect_authorize_url(
    user: User, *, provider: GoogleDriveOAuthProvider
) -> tuple[str, str]:
    """GET /users/me/drive/connect/authorize-url. В отличие от
    build_google_authorize_url (анонимный вход) здесь пользователь уже
    известен — state несёт user_id, чтобы callback не мог быть предъявлен
    от имени другого пользователя (тот же принцип, что ESIA build_authorize_url,
    ADR-062)."""
    state = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(32)
    cache.set(
        _drive_connect_state_cache_key(state),
        {"code_verifier": code_verifier, "user_id": str(user.id)},
        timeout=GOOGLE_DRIVE_CONNECT_STATE_TTL_SECONDS,
    )
    url = provider.connect_authorize_url(state=state, code_challenge=_code_challenge(code_verifier))
    return url, state


@transaction.atomic
def complete_drive_connect(
    *, user: User, code: str, state: str, provider: GoogleDriveOAuthProvider
) -> GoogleDriveGrant:
    """POST /users/me/drive/connect/callback. Идемпотентно по социальному
    аккаунту (`update_or_create` на `social_account`) — повторное
    подключение того же Google-аккаунта обновляет refresh-токен, не плодит
    дубли гранта (OneToOneField и так не позволил бы вторую строку)."""
    cached = cache.get(_drive_connect_state_cache_key(state))
    if cached is None:
        raise DriveConnectStateInvalidError(f"state {state!r} не найден или истёк")
    cache.delete(_drive_connect_state_cache_key(state))
    if cached.get("user_id") != str(user.id):
        raise DriveConnectStateInvalidError("state выдан другому пользователю")

    social_account = SocialLoginAccount.objects.filter(user=user, provider="google").first()
    if social_account is None:
        raise DriveNoGoogleLoginError(
            f"у пользователя {user.id} нет входа через Google — Drive подключить нечем"
        )

    try:
        tokens = provider.exchange_code(code=code, code_verifier=cached["code_verifier"])
    except InvalidGoogleDriveAuthorizationCodeError as exc:
        raise DriveConnectCodeInvalidError(str(exc)) from exc

    encrypted = encrypt_for_subject(
        tokens.refresh_token, subject_type="google_drive_grant", subject_id=social_account.id
    )
    grant, _created = GoogleDriveGrant.objects.update_or_create(
        social_account=social_account,
        defaults={
            "refresh_token_encrypted": encrypted.ciphertext,
            "encryption_key_ref": encrypted.key_ref,
            "granted_scope": GOOGLE_DRIVE_GRANT_SCOPE,
            "status": GoogleDriveGrant.Status.ACTIVE,
            "revoked_at": None,
        },
    )

    outbox.publish(
        "account.drive_connected",
        subject={"type": "user", "id": str(user.id)},
        payload={"scope": GOOGLE_DRIVE_GRANT_SCOPE},
        actor={"user_id": str(user.id)},
    )
    return grant


def has_drive_grant(user: User) -> bool:
    """GET /users/me/drive/connect — виден ли статус подключения (ГВ.3 п.3:
    «статус бэкапа виден пользователю»)."""
    return GoogleDriveGrant.objects.filter(
        social_account__user=user,
        social_account__provider="google",
        status=GoogleDriveGrant.Status.ACTIVE,
    ).exists()


def get_drive_access_token(account_sub: str, *, provider: GoogleDriveOAuthProvider) -> str:
    """Фасад для `apps.evidence.providers.RealGoogleDriveBackupProvider`
    (import-linter: apps.evidence не импортирует GoogleDriveGrant напрямую).
    `account_sub` — тот же Google `sub`, что уже получает `upload()` по
    контракту Protocol GoogleDriveBackupProvider — контракт не меняется.

    Access-токен не хранится нигде — получается по refresh на каждый вызов;
    `invalid_grant` от Google необратимо помечает грант revoked (требуется
    повторный connect), а не тихо повторяется."""
    try:
        grant = GoogleDriveGrant.objects.select_related("social_account").get(
            social_account__provider="google", social_account__sub=account_sub
        )
    except GoogleDriveGrant.DoesNotExist as exc:
        raise DriveNotConnectedError(f"Drive не подключён для аккаунта {account_sub!r}") from exc
    if grant.status == GoogleDriveGrant.Status.REVOKED:
        raise DriveGrantRevokedError(f"доступ к Drive отозван для аккаунта {account_sub!r}")

    refresh_token = decrypt_for_subject(
        bytes(grant.refresh_token_encrypted), grant.encryption_key_ref
    )
    try:
        return provider.refresh_access_token(refresh_token=refresh_token)
    except GoogleDriveGrantInvalidError as exc:
        grant.status = GoogleDriveGrant.Status.REVOKED
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["status", "revoked_at"])
        raise DriveGrantRevokedError(str(exc)) from exc


def revoke_drive_grant(user: User) -> None:
    """DELETE /users/me/drive/connect — отзыв со стороны продукта (не путать
    с отзывом на стороне Google, тот ловится в get_drive_access_token)."""
    GoogleDriveGrant.objects.filter(
        social_account__user=user, social_account__provider="google"
    ).update(status=GoogleDriveGrant.Status.REVOKED, revoked_at=timezone.now())


# --- Удаление аккаунта пользователем (DELETE /users/me, ADR-169;
# tech-spec.md §8.1 «запрос на удаление ПД (crypto-shredding, §10.2; 202 +
# процесс)», требование Google Play к публикации).


class AccountDeletionBlockedError(ValueError):
    """Есть удерживающие основания (tech-spec.md §10.2: «активные договоры,
    законные сроки хранения») — удалять нельзя, пока они не отпадут.
    `holds` уезжает в `context` ответа 409 без изменений: это счётчики, не
    ПД, и человеку по ним видно, что именно доделать."""

    def __init__(self, holds: dict[str, int]) -> None:
        self.holds = holds
        listed = ", ".join(f"{key}={value}" for key, value in sorted(holds.items()))
        super().__init__(f"удаление удерживается: {listed}")


def account_deletion_holds(user: User) -> dict[str, int]:
    """Счётчики удерживающих оснований со всех приложений, которые их знают
    (`settings.ACCOUNT_DELETION_HOLDS`). apps.accounts НЕ знает ни про
    договоры, ни про споры и знать не должен — он нижний слой; он знает
    только форму вклада `{"ключ": количество}` (см. настройку).

    Вклады складываются по ключу: два приложения с одинаковым ключом
    сложились бы в одно число, поэтому ключи уникальны по приложению."""
    holds: dict[str, int] = {}
    for dotted_path in settings.ACCOUNT_DELETION_HOLDS:
        for key, value in import_string(dotted_path)(user.id).items():
            holds[key] = holds.get(key, 0) + int(value)
    return holds


@transaction.atomic
def delete_account(user: User, *, acting_profile_id: str | None = None) -> datetime:
    """DELETE /users/me → `deleted_at`. Одна транзакция + событие в outbox.

    Строка `User` НЕ удаляется физически, и это не мягкое удаление: каждый
    FK на пользователя в проекте — `PROTECT` (`Contract.created_by`,
    `Signature.signatory`, `Evidence.uploaded_by`, …), потому что на нём
    держится доказательная база ЧУЖИХ сделок. Удалять из-под чужой подписи
    подписанта нельзя ни технически, ни юридически. Вместо этого ПД
    уничтожаются необратимо:

    1. crypto-shredding ключа субъекта ("user", id) — разом делает
       нерасшифровываемыми `User.full_name_encrypted`,
       `IdentityVerification.verified_full_name_encrypted` (apps.identity) и
       подписи контактов в его адресной книге (apps.social); плюс ключи
       Drive-грантов ("google_drive_grant", social_account.id).
    2. Незашифрованное — обнуляется: `email`/`phone` (уникальные поля →
       NULL, поэтому тот же адрес свободен для НОВОЙ регистрации),
       `full_name_encrypted`/`encryption_key_ref`, находимость.
    3. ПД в других приложениях — через `settings.ACCOUNT_DELETION_PURGERS`
       (фото и портфолио профиля, адресная книга и хеши телефонной книги,
       web-push подписки).
    4. Сессии: refresh-токены блэклистятся, `is_active=False` — им
       JWTAuthentication отвергает и access (`user_inactive`).

    Остаётся: `trust_id` (необратим, tech-spec.md §5.2.1/§10.2),
    `personal_tax_id_hash` и хеши контактов (необратимы, ПД не раскрывают —
    §10.2 прямо выводит их из shredding), сами договоры, версии, подписи,
    доказательства, платежи, споры и журнал аудита.

    Отложенного удаления с периодом отмены НЕТ — обоснование в ADR-169.
    """
    holds = account_deletion_holds(user)
    if any(count > 0 for count in holds.values()):
        raise AccountDeletionBlockedError(holds)

    now = timezone.now()

    destroy_subject_key("user", user.id)
    social_account_ids = list(
        SocialLoginAccount.objects.filter(user=user).values_list("id", flat=True)
    )
    for social_account_id in social_account_ids:
        # Refresh-токен Drive зашифрован ключом ЭТОГО субъекта (см.
        # complete_drive_connect) — сама строка гранта уйдёт каскадом ниже,
        # но ключ субъекта надо погасить явно: каскад его не знает.
        destroy_subject_key("google_drive_grant", social_account_id)

    for dotted_path in settings.ACCOUNT_DELETION_PURGERS:
        import_string(dotted_path)(user.id)

    # Ключи устройств ОТЗЫВАЮТСЯ, а не удаляются: `Evidence.device_key` —
    # PROTECT, «этот человек имел право быть на объекте, вот подпись его
    # устройства» — часть доказательной базы (apps/evidence/models.py).
    DeviceKey.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=now)
    # Устройства без зарегистрированных ключей (обычный случай) удаляются
    # целиком; у остальных гасится push-токен — единственное ПД строки, —
    # потому что удаление строки унесло бы каскадом её DeviceKey.
    keyless_device_ids = list(
        UserDevice.objects.filter(user=user, keys__isnull=True).values_list("pk", flat=True)
    )
    UserDevice.objects.filter(pk__in=keyless_device_ids).delete()
    UserDevice.objects.filter(user=user).update(push_token="")

    # Связки внешних входов — каскадом уносят и GoogleDriveGrant (OneToOne).
    SocialLoginAccount.objects.filter(user=user).delete()

    _revoke_all_refresh_tokens(user)

    user.email = None
    user.email_verified_at = None
    user.phone = None
    user.full_name_encrypted = None
    user.encryption_key_ref = None
    user.discoverable_by_phone = False
    user.discoverable_by_handle = False
    user.is_active = False
    user.deleted_at = now
    user.set_unusable_password()
    user.save(
        update_fields=[
            "email",
            "email_verified_at",
            "phone",
            "full_name_encrypted",
            "encryption_key_ref",
            "discoverable_by_phone",
            "discoverable_by_handle",
            "is_active",
            "deleted_at",
            "password",
        ]
    )

    # payload БЕЗ ПД: ни адреса, ни имени — только факт, что удерживающие
    # основания проверялись (аудит 152-ФЗ: удаление было законным).
    outbox.publish(
        "account.deleted",
        subject={"type": "user", "id": str(user.id)},
        payload={"holds_checked": True},
        actor={"user_id": str(user.id), "profile_id": acting_profile_id},
    )
    return now


def _revoke_all_refresh_tokens(user: User) -> None:
    """Все выданные refresh-токены — в блэклист SimpleJWT (не только тот,
    что предъявлен сейчас: у человека могут быть телефон, планшет и PWA).
    Импорт локальный — модели blacklist-приложения нужны ровно здесь."""
    from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)
