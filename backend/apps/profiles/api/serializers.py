from __future__ import annotations

from typing import Any

from rest_framework import serializers

from apps.geo.api.serializers import CitySerializer, CountrySerializer, RegionSerializer

from .. import selectors
from ..models import Portfolio, PortfolioPhoto, PortfolioProject, Profile, WorkArea


class ProfileSerializer(serializers.ModelSerializer[Profile]):
    """GET /profiles/{id} — публичная карточка. `display_name` уважает
    `show_name` (docs/tasks/etap-3-delta-adr059.md §1.4: False = «только
    @handle», хендл живёт в apps.social — здесь просто ничего не отдаём,
    фронт достаёт хендл своим запросом)."""

    display_name = serializers.SerializerMethodField()
    # ADR-103: null — фото нет ИЛИ зрителю нельзя (deals_only). Зритель —
    # из context["request"]; без него отдаётся только public.
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = Profile
        fields = [
            "id",
            "kind",
            "owner_user",
            "owner_entity",
            "display_name",
            "profile_visibility",
            "hide_from_catalog",
            "show_name",
            "avatar_visibility",
            "avatar_url",
            "city_name",
            "works_remotely",
            "sphere_codes",
            "work_type_codes",
            "created_at",
        ]
        read_only_fields = fields

    def get_display_name(self, profile: Profile) -> str | None:
        return selectors.public_display_name(profile)

    def get_avatar_url(self, profile: Profile) -> str | None:
        return selectors.avatar_url_for_request(profile, self.context.get("request"))


class ProfileSummarySerializer(serializers.ModelSerializer[Profile]):
    """Для GET /users/me (apps.accounts) — минимум, без display_name (тот
    уже доступен на самом /users/me для person-профиля владельца)."""

    # Владелец видит своё фото всегда (list_for_user отдаёт только свои
    # профили) — ссылка подписана независимо от avatar_visibility.
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = Profile
        fields = ["id", "kind", "owner_entity", "profile_visibility", "avatar_url"]
        read_only_fields = fields

    def get_avatar_url(self, profile: Profile) -> str | None:
        return selectors.avatar_url(profile, allowed=True)


class ProfileCreateSerializer(serializers.Serializer[Any]):
    kind = serializers.ChoiceField(choices=Profile.Kind.choices)
    owner_entity_id = serializers.UUIDField(required=False)


class ProfileUpdateSerializer(serializers.Serializer[Any]):
    city_name = serializers.CharField(required=False, allow_blank=True, max_length=120)
    works_remotely = serializers.BooleanField(required=False)
    # ADR-122: заявленные сферы — полный список кодов каталога, ≤ 10 (лимит и
    # существование кодов проверяет services.update_profile — 422).
    sphere_codes = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False, allow_empty=True
    )
    # ADR-190: виды работ — полный список составных кодов `<сфера>.<категория>`
    # (лимит, формат, согласованность со sphere_codes и существование
    # проверяет services.update_profile — 422).
    work_type_codes = serializers.ListField(
        child=serializers.CharField(max_length=129), required=False, allow_empty=True
    )
    profile_visibility = serializers.ChoiceField(choices=Profile.Visibility.choices, required=False)
    hide_from_catalog = serializers.BooleanField(required=False)
    show_name = serializers.BooleanField(required=False)
    avatar_visibility = serializers.ChoiceField(
        choices=Profile.AvatarVisibility.choices, required=False
    )


class WorkAreaSerializer(serializers.ModelSerializer[WorkArea]):
    """GET/PUT /profiles/{id}/work-areas — регион работы (план 11.09 §4,
    ADR-182). `location` — объект справочника `apps.geo` НА ЯЗЫКЕ ЗРИТЕЛЯ:
    переиспользуем те же сериализаторы, что `/v1/geo/*` (`_display_name`
    там уже резолвит локаль через `common.i18n.resolve_request_locale`,
    дублировать эту логику здесь незачем). `null` для `scope=world`
    (нечего показывать) и `scope=country` — название страны фронт
    локализует сам через `Intl.DisplayNames` (та же причина, по которой
    `apps.geo.models.Country` не хранит названий); ниже отдаётся только
    код."""

    location = serializers.SerializerMethodField()

    class Meta:
        model = WorkArea
        fields = ["id", "scope", "location", "created_at"]
        read_only_fields = fields

    def get_location(self, obj: WorkArea) -> dict[str, Any] | None:
        request = self.context.get("request")
        if obj.scope == WorkArea.Scope.COUNTRY and obj.country is not None:
            return dict(CountrySerializer(obj.country).data)
        if obj.scope == WorkArea.Scope.REGION and obj.region is not None:
            return dict(RegionSerializer(obj.region, context={"request": request}).data)
        if obj.scope == WorkArea.Scope.CITY and obj.city is not None:
            return dict(CitySerializer(obj.city, context={"request": request}).data)
        return None


class WorkAreaWriteItemSerializer(serializers.Serializer[Any]):
    """Тело PUT /profiles/{id}/work-areas — список этих элементов. Здесь —
    только типы/диапазоны (CLAUDE.md: бизнес-логика не в сериализаторах);
    состав полей под `scope`, существование и внутренняя согласованность
    ссылки на `apps.geo` — `services.replace_work_areas` (422 при
    расхождении). `country` — код ISO 3166-1 alpha-2, `region` —
    композитный код из `/v1/geo/regions` (например `KZ-02`), `city` — id
    из `/v1/geo/cities`."""

    scope = serializers.ChoiceField(choices=WorkArea.Scope.choices)
    country = serializers.CharField(required=False, allow_blank=True, max_length=8)
    region = serializers.CharField(required=False, allow_blank=True, max_length=40)
    city = serializers.IntegerField(required=False, allow_null=True)


class PortfolioPhotoSerializer(serializers.ModelSerializer[PortfolioPhoto]):
    """ADR-120: фото галереи; `url` — относительный путь под /v1 (как
    photo_url), `is_primary` — первое (order 0)."""

    url = serializers.SerializerMethodField()
    is_primary = serializers.SerializerMethodField()

    class Meta:
        model = PortfolioPhoto
        fields = ["id", "url", "order", "is_primary"]
        read_only_fields = fields

    def get_url(self, obj: PortfolioPhoto) -> str:
        version = obj.photo_key.rsplit("/", 1)[-1]
        return f"/v1/portfolio/projects/{obj.project_id}/photos/{obj.id}?v={version}"

    def get_is_primary(self, obj: PortfolioPhoto) -> bool:
        return obj.order == 0


class PortfolioProjectSerializer(serializers.ModelSerializer[PortfolioProject]):
    """+ photo_url (ADR-115): относительный путь под /v1 (как avatar_url),
    null — обложки нет; `?v=` — версия ключа для долгого кэша.
    ADR-120: + `photos` (галерея до 5, первое — основное = photo_url) и
    `started_at`."""

    photo_url = serializers.SerializerMethodField()
    photos = PortfolioPhotoSerializer(many=True, read_only=True)

    def get_photo_url(self, obj: PortfolioProject) -> str | None:
        if not obj.photo_key:
            return None
        version = obj.photo_key.rsplit("/", 1)[-1]
        return f"/v1/portfolio/projects/{obj.id}/photo?v={version}"

    class Meta:
        model = PortfolioProject
        fields = [
            "id",
            "photo_url",
            "photos",
            "title",
            "description",
            "sphere",
            "started_at",
            "completed_at",
            "location_label",
            "media",
            "order",
            "source",
            "is_verified",
            "verified_facts",
            "is_published",
            "counterparty_consent",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "source",
            "is_verified",
            "verified_facts",
            "is_published",
            "created_at",
        ]


class PortfolioProjectCreateSerializer(serializers.Serializer[Any]):
    """ADR-120: `completed_at` обязательна (даты выполнения), `started_at` и
    `location_label` (город) — нет; описание без лимита («пусть пишут много»)."""

    title = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    sphere = serializers.ChoiceField(choices=PortfolioProject.Sphere.choices)
    started_at = serializers.DateField(required=False, allow_null=True, default=None)
    completed_at = serializers.DateField()
    location_label = serializers.CharField(required=False, allow_blank=True, default="")
    media = serializers.ListField(child=serializers.JSONField(), required=False)


class PortfolioProjectUpdateSerializer(serializers.Serializer[Any]):
    """ADR-120: + сфера и даты (редактирование проекта). `started_at: null`
    снимает дату начала; `completed_at` снять нельзя (обязательна)."""

    title = serializers.CharField(max_length=200, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    sphere = serializers.ChoiceField(choices=PortfolioProject.Sphere.choices, required=False)
    started_at = serializers.DateField(required=False, allow_null=True)
    completed_at = serializers.DateField(required=False)
    location_label = serializers.CharField(required=False, allow_blank=True)
    media = serializers.ListField(child=serializers.JSONField(), required=False)
    order = serializers.IntegerField(required=False)


class PortfolioSerializer(serializers.ModelSerializer[Portfolio]):
    class Meta:
        model = Portfolio
        fields = ["id", "profile", "headline"]
        read_only_fields = fields


class AvatarUploadSerializer(serializers.Serializer[Any]):
    """POST /profiles/{id}/avatar — multipart, поле `file`. Лимит байт и
    проверка «это изображение» — в services (настройки, не здесь)."""

    file = serializers.FileField()
