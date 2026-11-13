from __future__ import annotations

from typing import Any

from django.conf import settings
from django.utils.module_loading import import_string
from rest_framework import serializers

from apps.accounts.selectors import get_full_name
from common.crypto import decrypt_for_subject

from .. import selectors
from ..models import (
    AddressableGroup,
    Consent,
    Contact,
    GroupMembership,
    GroupPortfolioPhoto,
    GroupPortfolioProject,
    Handle,
)


class HandleClaimSerializer(serializers.Serializer[Any]):
    value = serializers.CharField(max_length=32)


class HandlePublicSerializer(serializers.Serializer[Any]):
    """GET /handles/{handle} — карточка со статусом верификации, БЕЗ
    trust_id (etap-3.md 3.3 приёмка).

    `profile_id` (ADR-093) — person-профиль владельца хендла: репутационная
    карточка ключуется `profile_id` (`GET /reputation/profiles/{id}/card`,
    ADR-076), а публичный маршрут фронта — `/@handle`; без этого поля
    хендл в profile_id не разрешается ничем. `null` — хендл объединения
    (`kind="group"`) либо пользователь без person-профиля. import_string,
    не прямой импорт apps.profiles (import-linter: «social зависит только
    от accounts» — см. settings.HANDLE_PUBLIC_PROFILE_SELECTOR)."""

    handle = serializers.CharField(source="value")
    kind = serializers.SerializerMethodField()
    verified = serializers.SerializerMethodField()
    profile_id = serializers.SerializerMethodField()
    # ADR-117 §6: групповой хендл разрешается в карточку объединения —
    # без group_id маршрут /@хендл объединения вёл в никуда.
    group_id = serializers.SerializerMethodField()
    group_name = serializers.SerializerMethodField()

    def get_kind(self, obj: Handle) -> str:
        return "group" if obj.group_id else "user"

    def get_group_id(self, obj: Handle) -> str | None:
        return str(obj.group_id) if obj.group_id else None

    def get_group_name(self, obj: Handle) -> str | None:
        return obj.group.name if obj.group is not None else None

    def get_profile_id(self, obj: Handle) -> str | None:
        user = obj.user
        if user is None:
            return None
        profile = import_string(settings.HANDLE_PUBLIC_PROFILE_SELECTOR)(user)
        return str(profile.id) if profile is not None else None

    def get_verified(self, obj: Handle) -> bool:
        user = obj.user
        if user is None:
            return False
        return bool(user.verification_level == user.VerificationLevel.VERIFIED)


class HandleSearchResultSerializer(serializers.Serializer[Any]):
    """Строка выдачи GET /handles?q= — ровно то, что нужно мастеру создания
    договора для выбора контрагента (`HandleEntry`, packages/core/src/api/
    contract-types.ts), и ничего сверх того: ни телефона, ни e-mail, ни
    trust_id (tech-spec.md §5.1 — не отдаётся никогда, нигде).

    `user_id` — стабильный идентификатор строки: хендл сменить можно (Handle
    хранит историю), пользователя — нет. Ключ `user_id`, а не `id`, — как в
    PhonebookMatchSerializer, чтобы в одном приложении id пользователя
    назывался одинаково.

    `handle` — С «@» (как `GET /v1/users/me.handle` и мок-справочник фронта
    web/src/mocks/catalog.ts); резолвер контрагента «@» всё равно срезает
    (apps.social.selectors.get_active_handle_or_404).

    `kind` — person/business по `has_business_status` (СОБСТВЕННЫЙ СМЗ/ИП,
    CLAUDE.md), совпадает с `ProfileKind` фронта. Это НЕ тот `kind`, что у
    HandlePublicSerializer (там user/group) — здесь групп в выдаче нет по
    построению (selectors.search_handles), различать нечего.
    """

    user_id = serializers.UUIDField()
    handle = serializers.SerializerMethodField()
    display_name = serializers.SerializerMethodField()
    kind = serializers.SerializerMethodField()
    verification_level = serializers.SerializerMethodField()

    def get_handle(self, obj: Handle) -> str:
        return f"@{obj.value}"

    def get_display_name(self, obj: Handle) -> str:
        """Пустая строка, а не null: «имени нет» (ФИО не заполнено ЛИБО ключ
        субъекта уничтожен, crypto-shredding) — фронт показывает хендл, тип
        `HandleEntry.display_name: string` остаётся честным."""
        assert obj.user is not None  # search_handles отдаёт только user-хендлы
        return get_full_name(obj.user) or ""

    def get_kind(self, obj: Handle) -> str:
        assert obj.user is not None
        return "business" if obj.user.has_business_status else "person"

    def get_verification_level(self, obj: Handle) -> str:
        assert obj.user is not None
        return str(obj.user.verification_level)


class HandleSearchListSerializer(serializers.Serializer[Any]):
    results = HandleSearchResultSerializer(many=True)


class PhonebookUploadSerializer(serializers.Serializer[Any]):
    hashes = serializers.ListField(child=serializers.CharField(), allow_empty=True)
    algorithm = serializers.CharField()
    salt_ref = serializers.CharField()


class PhonebookMatchSerializer(serializers.Serializer[Any]):
    user_id = serializers.UUIDField(source="id")
    handle = serializers.SerializerMethodField()
    verified = serializers.SerializerMethodField()

    def get_handle(self, obj: Any) -> str | None:
        active = next((h for h in obj.handles.all() if h.is_active), None)
        return active.value if active else None

    def get_verified(self, obj: Any) -> bool:
        return bool(obj.verification_level == obj.VerificationLevel.VERIFIED)


class ContactCreateSerializer(serializers.Serializer[Any]):
    target_user_id = serializers.UUIDField(required=False)
    target_handle = serializers.CharField(required=False)
    display_name = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not attrs.get("target_user_id") and not attrs.get("target_handle"):
            raise serializers.ValidationError("нужен target_user_id или target_handle")
        return attrs


class _CounterpartyProfileMixin:
    """ADR-173: person-профиль контрагента строки и его фото — через
    `import_string` (apps.social не имеет права импортировать apps.profiles,
    см. settings.HANDLE_PUBLIC_PROFILE_SELECTOR / PROFILE_AVATAR_URL_SELECTOR).

    Профиль кэшируется НА СЕРИАЛИЗАТОРЕ: у `many=True` child один на весь
    список, и `*_profile_id` + `*_avatar_url` одной строки стоят одного
    запроса, а не двух. Видимость фото решает apps.profiles по зрителю из
    `context["request"]` (ADR-103) — здесь ничего не гейтится."""

    context: dict[str, Any]
    _profile_cache: dict[Any, Any] | None = None

    def _person_profile(self, user: Any) -> Any:  # noqa: ANN401
        if user is None:
            return None
        if self._profile_cache is None:
            self._profile_cache = {}
        if user.id not in self._profile_cache:
            self._profile_cache[user.id] = import_string(settings.HANDLE_PUBLIC_PROFILE_SELECTOR)(
                user
            )
        return self._profile_cache[user.id]

    def _person_avatar_url(self, user: Any) -> str | None:  # noqa: ANN401
        profile = self._person_profile(user)
        if profile is None:
            return None
        url = import_string(settings.PROFILE_AVATAR_URL_SELECTOR)(
            profile, self.context.get("request")
        )
        return str(url) if url else None


class ContactSerializer(_CounterpartyProfileMixin, serializers.ModelSerializer[Contact]):
    """Строка справочника контактов. Помимо ребра графа — то, что нужно
    фронту, чтобы строка была кликабельной и читаемой (отсмотр 2026-08-22:
    «пустой справочник»): `target_handle` (с «@», как в поиске хендлов),
    `target_display_name` (ФИО контрагента по accounts, пустая строка если
    имени нет) и `target_profile_id` (ADR-093 — ключ карточки репутации,
    через settings.HANDLE_PUBLIC_PROFILE_SELECTOR, без импорта profiles).
    `display_name` — ПОЛЬЗОВАТЕЛЬСКАЯ подпись контакта (manual), не имя."""

    display_name = serializers.SerializerMethodField()
    target_handle = serializers.SerializerMethodField()
    target_display_name = serializers.SerializerMethodField()
    target_profile_id = serializers.SerializerMethodField()
    # ADR-173: фото контрагента — лид строки справочника; null = фото нет
    # либо зрителю нельзя (deals_only), строка рисует инициалы, как раньше.
    target_avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = Contact
        fields = [
            "id",
            "target_user",
            "target_phone_hash",
            "display_name",
            "target_handle",
            "target_display_name",
            "target_profile_id",
            "target_avatar_url",
            "source",
            "is_mutual",
            "created_at",
        ]
        read_only_fields = fields

    def get_display_name(self, obj: Contact) -> str | None:
        if not obj.display_name_encrypted or not obj.encryption_key_ref:
            return None
        return decrypt_for_subject(bytes(obj.display_name_encrypted), obj.encryption_key_ref)

    def get_target_handle(self, obj: Contact) -> str | None:
        if obj.target_user is None:
            return None
        handle = selectors.get_active_handle_for_user(obj.target_user)
        return f"@{handle.value}" if handle else None

    def get_target_display_name(self, obj: Contact) -> str:
        if obj.target_user is None:
            return ""
        return get_full_name(obj.target_user) or ""

    def get_target_avatar_url(self, obj: Contact) -> str | None:
        return self._person_avatar_url(obj.target_user)

    def get_target_profile_id(self, obj: Contact) -> str | None:
        profile = self._person_profile(obj.target_user)
        return str(profile.id) if profile is not None else None


class ConsentRecordSerializer(serializers.Serializer[Any]):
    consent_type = serializers.ChoiceField(choices=Consent.ConsentType.choices)
    value = serializers.BooleanField()


class PrivacyConsentsSerializer(serializers.Serializer[Any]):
    """POST /users/me/privacy-consents — шаг регистрации «Данные и
    приватность» (docs/tasks/etap-3-delta-adr059.md §1.1): все три поля
    ОБЯЗАТЕЛЬНЫ и НЕ допускают null — «ничего не предзаполнено»."""

    pd_processing = serializers.BooleanField()
    profile_public = serializers.BooleanField()
    phone_discoverability = serializers.BooleanField()


class ConsentStateSerializer(serializers.Serializer[Any]):
    pd_processing = serializers.BooleanField(allow_null=True)
    profile_public = serializers.BooleanField(allow_null=True)
    phone_discoverability = serializers.BooleanField(allow_null=True)
    completed = serializers.BooleanField()


class GlobalPrivacyConsentsSerializer(serializers.Serializer[Any]):
    """POST /users/me/privacy-consents-global — стартовый пакет согласий
    GLOBAL (ГВ.2, docs/tasks/global-wave.md, ADR-071): те же три поля, что
    PrivacyConsentsSerializer, + четвёртое, все ОБЯЗАТЕЛЬНЫ без null."""

    pd_processing = serializers.BooleanField()
    profile_public = serializers.BooleanField()
    phone_discoverability = serializers.BooleanField()
    reputation_history_basis = serializers.BooleanField()


class GlobalConsentStateSerializer(serializers.Serializer[Any]):
    pd_processing = serializers.BooleanField(allow_null=True)
    profile_public = serializers.BooleanField(allow_null=True)
    phone_discoverability = serializers.BooleanField(allow_null=True)
    reputation_history_basis = serializers.BooleanField(allow_null=True)
    completed = serializers.BooleanField()


class ReputationLinkSerializer(serializers.Serializer[Any]):
    url = serializers.CharField()


class GroupSerializer(serializers.ModelSerializer[AddressableGroup]):
    """+ handle/join_policy/members_count/my_membership (отсмотр 2026-08-23);
    v2 (ADR-117 §6): сфера/география/ссылки/leader_name — публичная карточка
    объединения ≈ личная. `my_membership` — из context (views), null для
    не-участника и анонима."""

    handle = serializers.SerializerMethodField()
    members_count = serializers.SerializerMethodField()
    my_membership = serializers.SerializerMethodField()
    leader_name = serializers.SerializerMethodField()
    logo_url = serializers.SerializerMethodField()

    class Meta:
        model = AddressableGroup
        fields = [
            "id",
            "kind",
            "leader",
            "leader_name",
            "name",
            "description",
            "sphere_code",
            "geo_scope",
            "country_code",
            "city_name",
            "links",
            "logo_url",
            "is_public",
            "join_policy",
            "reputation_mode",
            "handle",
            "members_count",
            "my_membership",
            "created_at",
        ]
        read_only_fields = ["id", "leader", "created_at"]

    def get_handle(self, obj: AddressableGroup) -> str | None:
        handle = selectors.active_group_handle(obj)
        return f"@{handle.value}" if handle else None

    def get_leader_name(self, obj: AddressableGroup) -> str:
        return get_full_name(obj.leader) or ""

    def get_logo_url(self, obj: AddressableGroup) -> str | None:
        return selectors.group_logo_url(obj)

    def get_members_count(self, obj: AddressableGroup) -> int:
        return obj.memberships.filter(status=GroupMembership.Status.ACTIVE).count()

    def get_my_membership(self, obj: AddressableGroup) -> dict[str, str] | None:
        viewer = self.context.get("viewer")
        if viewer is None:
            return None
        membership = selectors.my_membership(obj, viewer)
        if membership is None or membership.status == GroupMembership.Status.LEFT:
            return None
        return {"role": membership.role, "status": membership.status}


# ADR-117 §1: create принимает коды kind v1 как алиасы — деплой бэка не
# ломает фронт v1 до его обновления (миграция 0005 переписала данные, фронт
# догоняет парным web-PR).
_LEGACY_KIND_ALIASES = {
    "company_storefront": AddressableGroup.Kind.COMPANY_SHOWCASE,
    "informal": AddressableGroup.Kind.CLAN,
}

_MAX_GROUP_LINKS = 10


class GroupLinkSerializer(serializers.Serializer[Any]):
    """ADR-117 §4: одна ссылка витрины — соцсеть/сайт/портфолио."""

    url = serializers.URLField(max_length=500)
    # Имя поля совпадает с атрибутом Field.label — для mypy это конфликт
    # типов, для DRF-метакласса — обычное объявленное поле.
    label = serializers.CharField(  # type: ignore[assignment]
        max_length=50, required=False, allow_blank=True, default=""
    )


def _validate_links_count(links: list[dict[str, str]]) -> list[dict[str, str]]:
    if len(links) > _MAX_GROUP_LINKS:
        raise serializers.ValidationError(f"не больше {_MAX_GROUP_LINKS} ссылок")
    return links


def _kind_field(**kwargs: Any) -> serializers.ChoiceField:
    return serializers.ChoiceField(
        choices=[*AddressableGroup.Kind.choices, *[(k, k) for k in _LEGACY_KIND_ALIASES]],
        **kwargs,
    )


class GroupCreateSerializer(serializers.Serializer[Any]):
    """v2 (ADR-117): хендл и сфера ОБЯЗАТЕЛЬНЫ («хендл создаётся при
    регистрации»); kind по умолчанию clan."""

    kind = _kind_field(required=False, default=AddressableGroup.Kind.CLAN)
    name = serializers.CharField(max_length=200)
    handle = serializers.CharField(max_length=64)
    sphere_code = serializers.CharField(max_length=64)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    is_public = serializers.BooleanField(required=False, default=True)
    join_policy = serializers.ChoiceField(
        choices=AddressableGroup.JoinPolicy.choices,
        required=False,
        default=AddressableGroup.JoinPolicy.OPEN,
    )
    reputation_mode = serializers.ChoiceField(
        choices=AddressableGroup.ReputationMode.choices,
        required=False,
        default=AddressableGroup.ReputationMode.AGGREGATE_ONLY,
    )
    geo_scope = serializers.ChoiceField(
        choices=AddressableGroup.GeoScope.choices,
        required=False,
        default=AddressableGroup.GeoScope.WORLD,
    )
    country_code = serializers.CharField(max_length=8, required=False, allow_blank=True, default="")
    city_name = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    links = GroupLinkSerializer(many=True, required=False, default=list)

    def validate_kind(self, value: str) -> str:
        return _LEGACY_KIND_ALIASES.get(value, value)

    def validate_links(self, value: list[dict[str, str]]) -> list[dict[str, str]]:
        return _validate_links_count(value)


class GroupUpdateSerializer(serializers.Serializer[Any]):
    kind = _kind_field(required=False)
    name = serializers.CharField(max_length=200, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    sphere_code = serializers.CharField(max_length=64, required=False)
    is_public = serializers.BooleanField(required=False)
    join_policy = serializers.ChoiceField(
        choices=AddressableGroup.JoinPolicy.choices, required=False
    )
    reputation_mode = serializers.ChoiceField(
        choices=AddressableGroup.ReputationMode.choices, required=False
    )
    geo_scope = serializers.ChoiceField(choices=AddressableGroup.GeoScope.choices, required=False)
    country_code = serializers.CharField(max_length=8, required=False, allow_blank=True)
    city_name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    links = GroupLinkSerializer(many=True, required=False)

    def validate_kind(self, value: str) -> str:
        return _LEGACY_KIND_ALIASES.get(value, value)

    def validate_links(self, value: list[dict[str, str]]) -> list[dict[str, str]]:
        return _validate_links_count(value)


class MembershipSerializer(serializers.ModelSerializer[GroupMembership]):
    class Meta:
        model = GroupMembership
        fields = ["id", "group", "member", "role", "status", "joined_at"]
        read_only_fields = ["id", "group", "member", "joined_at"]


class MembershipCreateSerializer(serializers.Serializer[Any]):
    """Приглашение: по member_id (User) ЛИБО по @хендлу (отсмотр 2026-08-23 —
    фронт знает людей по хендлам, не по user id)."""

    member_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    handle = serializers.CharField(required=False, allow_blank=True, default="")
    role = serializers.ChoiceField(
        choices=GroupMembership.Role.choices, required=False, default=GroupMembership.Role.MEMBER
    )

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if not attrs.get("member_id") and not (attrs.get("handle") or "").strip():
            raise serializers.ValidationError("нужен member_id или handle")
        return attrs


class MembershipUpdateSerializer(serializers.Serializer[Any]):
    role = serializers.ChoiceField(choices=GroupMembership.Role.choices, required=False)
    status = serializers.ChoiceField(choices=GroupMembership.Status.choices, required=False)


class GroupHandleSerializer(serializers.Serializer[Any]):
    value = serializers.CharField(max_length=64)


class GroupLogoUploadSerializer(serializers.Serializer[Any]):
    """POST /groups/{id}/logo — multipart, поле `file` (как аватар ADR-103).
    Лимит байт и проверка «это изображение» — в services (настройки)."""

    file = serializers.FileField()


class MembershipRowSerializer(
    _CounterpartyProfileMixin, serializers.ModelSerializer[GroupMembership]
):
    """Строка списка участников: + имя участника (get_full_name — то же, что
    в контактах). member — User.id (решения по заявкам адресуются membership.id).
    v2 (ADR-117 §6): + member_handle/member_profile_id — участник кликабелен
    в свою карточку репутации (те же приёмы, что ContactSerializer)."""

    member_name = serializers.SerializerMethodField()
    member_handle = serializers.SerializerMethodField()
    member_profile_id = serializers.SerializerMethodField()
    # ADR-173: фото участника/заявителя — тот же лид строки, что в разделах.
    member_avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = GroupMembership
        fields = [
            "id",
            "member",
            "member_name",
            "member_handle",
            "member_profile_id",
            "member_avatar_url",
            "role",
            "status",
            "joined_at",
        ]
        read_only_fields = fields

    def get_member_name(self, obj: GroupMembership) -> str | None:
        return get_full_name(obj.member)

    def get_member_handle(self, obj: GroupMembership) -> str | None:
        handle = selectors.get_active_handle_for_user(obj.member)
        return f"@{handle.value}" if handle else None

    def get_member_profile_id(self, obj: GroupMembership) -> str | None:
        profile = self._person_profile(obj.member)
        return str(profile.id) if profile is not None else None

    def get_member_avatar_url(self, obj: GroupMembership) -> str | None:
        return self._person_avatar_url(obj.member)


class GroupPortfolioPhotoSerializer(serializers.ModelSerializer[GroupPortfolioPhoto]):
    """ADR-128, зеркало PortfolioPhotoSerializer (apps.profiles): `url` —
    относительный путь под /v1, `is_primary` — первое фото (order 0)."""

    url = serializers.SerializerMethodField()
    is_primary = serializers.SerializerMethodField()

    class Meta:
        model = GroupPortfolioPhoto
        fields = ["id", "url", "order", "is_primary"]
        read_only_fields = fields

    def get_url(self, obj: GroupPortfolioPhoto) -> str:
        return selectors.group_portfolio_photo_url(obj)

    def get_is_primary(self, obj: GroupPortfolioPhoto) -> bool:
        return obj.order == 0


class GroupPortfolioProjectSerializer(serializers.ModelSerializer[GroupPortfolioProject]):
    """ADR-128. Форма ответа намеренно совпадает с
    PortfolioProjectSerializer в той части, которую рисует общий
    фронт-компонент витрины (`title`/`description`/даты/`location_label`/
    `photo_url`/`photos`); полей сделочных фактов у объединения нет."""

    photo_url = serializers.SerializerMethodField()
    photos = GroupPortfolioPhotoSerializer(many=True, read_only=True)

    class Meta:
        model = GroupPortfolioProject
        fields = [
            "id",
            "group",
            "photo_url",
            "photos",
            "title",
            "description",
            "sphere_code",
            "started_at",
            "completed_at",
            "location_label",
            "order",
            "created_at",
        ]
        read_only_fields = ["id", "group", "created_at"]

    def get_photo_url(self, obj: GroupPortfolioProject) -> str | None:
        """Основное фото — из уже подтянутой галереи (`photo_key` — его
        зеркало): один и тот же URL, что `photos[0].url`, без лишнего запроса."""
        primary = next((photo for photo in obj.photos.all() if photo.order == 0), None)
        if primary is None:
            return None
        return selectors.group_portfolio_photo_url(primary)


class GroupPortfolioProjectCreateSerializer(serializers.Serializer[Any]):
    """ADR-128 (как ADR-120 §3): `completed_at` обязательна, `started_at`,
    город и сфера — нет (пустая сфера = сфера самого объединения).
    Описание без лимита — «пусть пишут много»."""

    title = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    sphere_code = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")
    started_at = serializers.DateField(required=False, allow_null=True, default=None)
    completed_at = serializers.DateField()
    location_label = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )


class GroupPortfolioProjectUpdateSerializer(serializers.Serializer[Any]):
    """`started_at: null` снимает дату начала; `completed_at` снять нельзя."""

    title = serializers.CharField(max_length=200, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    sphere_code = serializers.CharField(max_length=64, required=False, allow_blank=True)
    started_at = serializers.DateField(required=False, allow_null=True)
    completed_at = serializers.DateField(required=False)
    location_label = serializers.CharField(max_length=200, required=False, allow_blank=True)
    order = serializers.IntegerField(required=False)


class GroupPortfolioPhotoUploadSerializer(serializers.Serializer[Any]):
    """POST .../photos — multipart, поле `file` (как логотип). Лимит байт и
    проверка «это изображение» — в services (настройки, не здесь)."""

    file = serializers.FileField()
