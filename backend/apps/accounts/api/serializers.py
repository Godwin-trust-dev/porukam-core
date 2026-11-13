from __future__ import annotations

from typing import Any

from django.conf import settings
from django.utils.module_loading import import_string
from rest_framework import serializers

from ..models import DeviceKey, User, UserDevice
from ..selectors import get_full_name


class OTPRequestSerializer(serializers.Serializer[Any]):
    phone = serializers.CharField(max_length=32)


class OTPVerifySerializer(serializers.Serializer[Any]):
    phone = serializers.CharField(max_length=32)
    code = serializers.CharField(max_length=6)


class EmailOTPRequestSerializer(serializers.Serializer[Any]):
    """ADR-168. EmailField — единственная проверка формата адреса (её отказ
    и есть 400 у /auth/email/request); нормализация (trim + lower) живёт в
    services.normalize_email, чтобы ключи кеша и поиск пользователя
    считались от одного и того же вида адреса."""

    email = serializers.EmailField(max_length=254)


class EmailOTPVerifySerializer(serializers.Serializer[Any]):
    email = serializers.EmailField(max_length=254)
    code = serializers.CharField(max_length=6)


class TokenPairSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI — не используется для валидации."""

    access = serializers.CharField()
    refresh = serializers.CharField()


class GoogleAuthorizeUrlSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI."""

    authorize_url = serializers.CharField()
    state = serializers.CharField()


class GoogleCallbackRequestSerializer(serializers.Serializer[Any]):
    code = serializers.CharField()
    state = serializers.CharField()


class RefreshRequestSerializer(serializers.Serializer[Any]):
    refresh = serializers.CharField()


class LogoutRequestSerializer(serializers.Serializer[Any]):
    refresh = serializers.CharField()


class UserMeSerializer(serializers.ModelSerializer[User]):
    """trust_id ЗДЕСЬ НЕ ДОЛЖЕН ПОЯВЛЯТЬСЯ НИКОГДА (tech-spec.md §5.1) —
    непубличный идентификатор, ни один сериализатор apps.accounts.api его не
    отдаёт. Проверено test_api.py::test_trust_id_never_in_response."""

    # JSON-ключ "display_name", не "full_name" — сознательно НЕ переименование
    # доменного поля (`User.full_name_encrypted`/`get_full_name` остаются как
    # есть, это верный доменный термин для ФИО), а согласование с фронтовым
    # контрактом `CurrentUser.display_name`, уже используемым ~20 экранами
    # (docs/tasks/Задача_fix_web-profile-handle-real-api.md) — переименовывать
    # ИХ было бы куда шире по площади и риску, чем один ключ на границе API.
    display_name = serializers.SerializerMethodField()
    # Хендл живёт в apps.social (Handle) — apps.accounts не имеет права
    # импортировать apps.social напрямую (CLAUDE.md, import-linter: «social
    # зависит только от accounts», не наоборот). import_string —
    # тот же приём, что get_profiles ниже (settings.USER_ME_PROFILES_SELECTOR).
    # "@"-префикс — фронт использует хендл как URL-сегмент (`/${me.handle}`,
    # OwnerProfilePage.tsx) и ReputationCardPage сверяет префикс "@" сам —
    # без него уже рабочая навигация по ссылке-хендлу сломалась бы.
    handle = serializers.SerializerMethodField()
    profiles = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "phone",
            "email",
            "display_name",
            "handle",
            "verification_level",
            "has_business_status",
            "is_active",
            "country_code",
            "locale",
            "profiles",
        ]
        read_only_fields = ["id", "phone", "verification_level", "has_business_status", "is_active"]

    def get_display_name(self, user: User) -> str | None:
        return get_full_name(user)

    def get_handle(self, user: User) -> str | None:
        handle = import_string(settings.USER_ME_HANDLE_SELECTOR)(user)
        return f"@{handle.value}" if handle else None

    def get_profiles(self, user: User) -> Any:
        """etap-3.md 3.5 приёмка: «создать бизнес-профиль ИП -> в GET
        /users/me два профиля». import_string, не прямой импорт apps.profiles
        (см. settings.USER_ME_PROFILES_SELECTOR — import-linter)."""
        list_for_user = import_string(settings.USER_ME_PROFILES_SELECTOR)
        serializer_cls = import_string(settings.USER_ME_PROFILES_SERIALIZER)
        return serializer_cls(list_for_user(user), many=True).data


class AccountDeletedSerializer(serializers.Serializer[Any]):
    """Тело 202 на DELETE /users/me (ADR-169) — момент, когда ПД уничтожены.
    Больше в ответе ничего нет и быть не может: клиенту после него остаётся
    только выбросить токены, а любое поле профиля здесь было бы отдачей ПД
    уже удалённого человека."""

    deleted_at = serializers.DateTimeField()


class UserMeUpdateSerializer(serializers.Serializer[Any]):
    email = serializers.EmailField(required=False, allow_null=True)
    # Телефон (отсмотр 2026-08-24, находимость по телефону — вариант А без
    # SMS-верификации): форма — E.164 с «+», нормализация и уникальность —
    # services.update_profile (PhoneInvalidError/PhoneTakenError). Пустая
    # строка/None — удалить номер.
    phone = serializers.CharField(required=False, allow_null=True, allow_blank=True, max_length=32)
    # JSON-ключ "display_name" — см. комментарий в UserMeSerializer выше;
    # симметрично чтению (читаем display_name → пишем display_name).
    display_name = serializers.CharField(required=False, allow_blank=True, max_length=300)
    # ГВ.1/ГВ.5 (docs/tasks/global-wave.md, ADR-070/074): явный выбор страны
    # пользователем — не валидируется здесь против apps.jurisdictions,
    # см. services.update_profile. allow_null сбрасывает выбор (снова NULL
    # → контур GLOBAL).
    country_code = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, max_length=8
    )
    # Язык интерфейса (ADR-095). Валидируется ТОЛЬКО по форме BCP-47, не по
    # списку включённых Locale — см. докстринг User.locale: запись фиксирует
    # выбор, пригодность решается при чтении. Регион-тэг обязан доезжать как
    # есть (`pt-BR`, `zh-Hans`) — огрубление до примарной подгруппы и было
    # тем багом, из-за которого бразилец получал русский текст.
    locale = serializers.RegexField(
        r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$",
        required=False,
        allow_null=True,
        allow_blank=True,
        max_length=16,
    )


class UserDeviceSerializer(serializers.ModelSerializer[UserDevice]):
    class Meta:
        model = UserDevice
        fields = ["id", "platform", "push_token", "last_seen_at", "created_at"]
        read_only_fields = ["id", "last_seen_at", "created_at"]


class GoogleDriveConnectAuthorizeUrlSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI."""

    authorize_url = serializers.CharField()
    state = serializers.CharField()


class GoogleDriveConnectCallbackRequestSerializer(serializers.Serializer[Any]):
    code = serializers.CharField()
    state = serializers.CharField()


class GoogleDriveGrantStatusSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI (ГВ.3 п.3: «статус бэкапа виден
    пользователю»)."""

    connected = serializers.BooleanField()


class DeviceKeySerializer(serializers.ModelSerializer[DeviceKey]):
    public_key = serializers.CharField(
        help_text="Публичный ключ, base64 (tech-spec.md §8.9)", write_only=True
    )

    class Meta:
        model = DeviceKey
        fields = ["id", "algorithm", "public_key", "issued_at", "revoked_at"]
        read_only_fields = ["id", "issued_at", "revoked_at"]
