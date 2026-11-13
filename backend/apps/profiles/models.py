"""tech-spec.md §5.2.3, §8.3; domain-model.md §3.3, §3.4; docs/tasks/
etap-3.md 3.5; docs/tasks/etap-3-delta-adr059.md §1.4 (поля видимости
person-профиля — заведены раньше, в 3.3/feat/social, здесь расширяются, не
переопределяются — docs/adr/ADR-067-social-consent-profile-visibility.md,
docs/adr/ADR-074-authority-profiles.md).

owner_entity — FK на apps.entities.BusinessEntity СТРОКОЙ ("entities.
BusinessEntity") только в ОБЪЯВЛЕНИИ поля — обычная Django-конвенция для FK
на модель, зарегистрированную позже в INSTALLED_APPS, не принцип «не
импортировать чужую модель»: apps.profiles.services и apps.profiles.
selectors СВОБОДНО импортируют apps.entities.models.BusinessEntity напрямую
(в отличие от apps.notifications.models.Notification.related_deadline,
ЭФ.4, где строка была именно избеганием импорта — там это единственная
точка касания двух приложений)."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class Profile(models.Model):
    class Kind(models.TextChoices):
        PERSON = "person", "Физлицо"
        BUSINESS = "business", "Бизнес"

    class Visibility(models.TextChoices):
        PUBLIC = "public", "Публичный"
        LINK_AND_DEALS = "link_and_deals", "По ссылке и контрагентам сделок"

    class AvatarVisibility(models.TextChoices):
        PUBLIC = "public", "Публичный"
        DEALS_ONLY = "deals_only", "Только контрагентам сделок"

    class AvatarSource(models.TextChoices):
        NONE = "none", "Нет фото"
        UPLOAD = "upload", "Загружено пользователем"
        GOOGLE = "google", "Импортировано из Google при регистрации"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    owner_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        related_name="profiles",
        on_delete=models.CASCADE,
    )
    owner_entity = models.ForeignKey(
        "entities.BusinessEntity",
        null=True,
        blank=True,
        related_name="profiles",
        on_delete=models.CASCADE,
    )

    # docs/tasks/etap-3-delta-adr059.md §1.4 — из согласия profile_public
    # (apps.social, топик "social.consent_recorded", см. subscriber.py).
    # Для kind=business ЗНАЧЕНИЕ ИГНОРИРУЕТСЯ — всегда PUBLIC, пока карточка
    # операбельна (Р5 дельты): CheckConstraint ниже + services.
    # ProfileVisibilityLockedError как гейт до записи.
    profile_visibility = models.CharField(max_length=16, choices=Visibility.choices)
    hide_from_catalog = models.BooleanField(default=False)
    show_name = models.BooleanField(default=True)
    avatar_visibility = models.CharField(
        max_length=16, choices=AvatarVisibility.choices, default=AvatarVisibility.PUBLIC
    )

    # ADR-103: фото профиля. avatar_key — префикс объектов в бакете
    # (`avatars/<profile_id>/<uuid7>`, варианты `<key>/256.webp`, `<key>/64.webp`),
    # "" — фото нет. Хранится ТОЛЬКО своя уменьшенная копия; ссылка Google CDN
    # сюда не попадает никогда. Замена/удаление физически удаляют старые
    # объекты (ПД — без мягкого удаления, CLAUDE.md).
    avatar_key = models.CharField(max_length=200, blank=True, default="")
    avatar_source = models.CharField(
        max_length=16, choices=AvatarSource.choices, default=AvatarSource.NONE
    )
    avatar_updated_at = models.DateTimeField(null=True, blank=True)

    # Р6 дельты: только город, координаты не храним на этом шаге.
    #
    # УСТАРЕЛО (план 11.09 §4, ADR-182): это подпись в карточке для тех,
    # чьего города/посёлка нет в справочнике `apps.geo` (порог справочника —
    # города от 15 000 жителей, ADR-179) — свободный текст, ничем не
    # провалидирован. В ПОИСКЕ больше не участвует и не должен: реальная
    # география работы — `WorkArea` ниже, поиск переедет на неё в части 5
    # плана 11.09 (пока `apps.dashboards._zone_match` продолжает читать
    # именно это поле — трогать его не в этой части). Поле не удаляется:
    # карточка профиля («Ремонт, Алматы») читает его как есть.
    city_name = models.CharField(max_length=120, blank=True, default="")
    # УСТАРЕЛО (план 11.09 §4, ADR-182): «работаю удалённо» — при переносе
    # существующих профилей (management-команда `migrate_profile_geo_to_work_areas`)
    # становится записью `WorkArea` со scope=world («весь мир»). Поле
    # остаётся (его продолжает читать `apps.dashboards._zone_match`, часть 5
    # плана переведёт поиск на `WorkArea` и уберёт чтение отсюда) — но новых
    # писателей у него быть не должно, кроме уже существующего PATCH
    # /profiles/{id} (обратная совместимость на время миграции клиентов).
    works_remotely = models.BooleanField(default=False)
    # ADR-122 (отсмотр 2026-08-24): заявленные сферы деятельности — коды
    # сфер КАТАЛОГА (`apps.catalog.Sphere.code`, по значению, как у
    # объединений ADR-117 §2), до PROFILE_MAX_SPHERES (10); порядок — как
    # ввёл владелец. «По этим сферам вас могут находить заказчики»: поиск
    # ADR-121 матчит их с пометкой «заявлено» (в отличие от фактов сделок).
    sphere_codes = models.JSONField(default=list, blank=True)
    # ADR-190 (12.09, «подсферы» в профиле и поиске): выбранные виды работ —
    # составные коды каталога `<сфера>.<категория>` (тот же составной ключ,
    # что `apps.catalog.api.views._rank_work_types` уже использует для
    # ранжирования; НЕ голый код категории — `category` не уникальна
    # глобально, `other` есть почти в каждой сфере, docstring
    # `apps.catalog.selectors._by_sphere`). До PROFILE_MAX_WORK_TYPES (30);
    # порядок — как ввёл владелец, дубли схлопываются (тот же приём, что
    # sphere_codes). ИНВАРИАНТ (services.update_profile): сфера каждого
    # элемента ОБЯЗАНА быть в sphere_codes ЭТОГО же профиля — «нельзя
    # выбрать вид работ из сферы, которую не заявил»; сервис же обрезает
    # осиротевшие виды работ, если sphere_codes сузили в том же PATCH.
    work_type_codes = models.JSONField(default=list, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "profile"
        verbose_name = "профиль"
        verbose_name_plural = "профили"
        constraints = [
            # Значения Kind/Visibility не видны из области Meta (вложенный
            # класс, тот же приём, что apps/deadlines/models.py
            # domain_deadline_starts_from_valid) — литералы дублируют choices
            # намеренно. Не просто «ровно один владелец» — владелец должен
            # СООТВЕТСТВОВАТЬ kind (person -> owner_user, business ->
            # owner_entity); иначе ничто не мешало бы создать kind=business
            # с owner_user.
            models.CheckConstraint(
                condition=(
                    Q(kind="person", owner_user__isnull=False, owner_entity__isnull=True)
                    | Q(kind="business", owner_user__isnull=True, owner_entity__isnull=False)
                ),
                name="profile_owner_matches_kind",
            ),
            models.UniqueConstraint(
                fields=["kind", "owner_user"], name="unique_profile_kind_owner_user"
            ),
            models.UniqueConstraint(
                fields=["kind", "owner_entity"], name="unique_profile_kind_owner_entity"
            ),
            models.CheckConstraint(
                condition=(Q(kind="person") | Q(profile_visibility="public")),
                name="profile_business_always_public",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.kind}:{self.owner_user_id or self.owner_entity_id}"


class Portfolio(models.Model):
    """Витрина проектов — у ЛЮБОГО профиля (domain-model.md §3.4). Один
    портфолио на профиль, создаётся лениво при первом обращении
    (`services.get_or_create_portfolio`)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    profile = models.OneToOneField(Profile, related_name="portfolio", on_delete=models.CASCADE)
    headline = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        db_table = "portfolio"
        verbose_name = "портфолио"
        verbose_name_plural = "портфолио"

    def __str__(self) -> str:
        return f"портфолио {self.profile_id}"


class PortfolioProject(models.Model):
    """Проект: описание + факты (domain-model.md §3.4). `is_verified`/
    `verified_facts` — ТОЛЬКО система (нет API записи, tech-spec.md §5.2.3);
    `media` — Р1: список ссылок/подписей (JSON), без реального пайплайна
    загрузки/EXIF-очистки (это apps.evidence/apps.documents, вне 3.5).

    `sphere` — плоский код, не FK на справочник (Р-3, domain-model.md §15:
    «в реализации — таблица-справочник», которой в кодовой базе пока нет —
    тот же приём упрощения, что `BusinessEntity.local_form_code`, ADR-063).

    `EDUCATION` (было `TUTORING` до chore/sphere-dedup) — код синхронизирован
    с `apps.catalog.models.Sphere`/`docs/content/checklists/
    CL-education_GLOBAL.md`/`l10n/packs/*.json` (`catalog.spheres.education`);
    миграция 0004 переносит уже сохранённые строки `sphere="tutoring"`."""

    class Source(models.TextChoices):
        MANUAL = "manual", "Заявлено вручную"
        FROM_CONTRACT = "from_contract", "Собрано из договора"

    # ADR-115 (отсмотр 2026-08-23 «портфолио работ»): реальная фото-обложка
    # проекта — первый настоящий байтовый пайплайн портфолио (media JSON
    # остаётся ссылками/подписями). Ключ в том же S3, что аватары:
    # `portfolio/<profile_id>/<uuid7>` с вариантами 1280/320 WebP.

    class Sphere(models.TextChoices):
        RENOVATION = "renovation", "Ремонт"
        DELIVERY = "delivery", "Доставка"
        EDUCATION = "education", "Обучение и репетиторство"
        IT = "it", "IT"
        HOUSEHOLD = "household", "Бытовые услуги"
        DESIGN = "design", "Дизайн"
        OTHER = "other", "Другое"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    portfolio = models.ForeignKey(Portfolio, related_name="projects", on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    sphere = models.CharField(max_length=16, choices=Sphere.choices)
    # ADR-120 (отсмотр 2026-08-24): даты выполнения — `completed_at`
    # ОБЯЗАТЕЛЬНА для ручных проектов (проверяет сервис, не БД: у
    # FROM_CONTRACT дата может быть неизвестна), `started_at` — опционально.
    started_at = models.DateField(null=True, blank=True)
    completed_at = models.DateField(null=True, blank=True)
    location_label = models.CharField(max_length=200, blank=True, default="")
    media = models.JSONField(default=list, blank=True)
    # ADR-115: реальная фото-обложка проекта (пусто — обложки нет); байты в
    # том же S3, что аватары; ключ `portfolio/<profile_id>/<uuid7>`,
    # варианты 1280/320 WebP (images.process_portfolio_image).
    # ADR-120: с галереей (`PortfolioPhoto`) это ЗЕРКАЛО ключа ОСНОВНОГО
    # фото (`photos[0]`) — `GET .../photo` и старые бандлы продолжают работать;
    # пишет только сервис (`_sync_cover`).
    photo_key = models.CharField(max_length=255, blank=True, default="")
    order = models.PositiveIntegerField(default=0)

    source = models.CharField(max_length=16, choices=Source.choices, default=Source.MANUAL)
    # contract_id — БЕЗ FK: apps.contracts не существует (см. docstring
    # apps/authority/models.py — тот же приём).
    source_contract_id = models.UUIDField(null=True, blank=True)
    is_verified = models.BooleanField(default=False)
    verified_facts = models.JSONField(default=dict, blank=True)

    is_published = models.BooleanField(default=False)
    counterparty_consent = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "portfolio_project"
        verbose_name = "проект портфолио"
        verbose_name_plural = "проекты портфолио"
        constraints = [
            # is_verified — ТОЛЬКО у FROM_CONTRACT (domain-model.md §3.4).
            models.CheckConstraint(
                condition=(Q(is_verified=False) | Q(source="from_contract")),
                name="portfolio_project_verified_only_from_contract",
            ),
        ]
        ordering = ["order", "-created_at"]

    def __str__(self) -> str:
        return f"{self.portfolio_id}:{self.title}"


class PortfolioPhoto(models.Model):
    """Фото проекта портфолио (ADR-120): до `PORTFOLIO_MAX_PHOTOS` (5) на
    проект, порядок — `order`, основное — `order == 0` (первое). Байты — тот
    же пайплайн, что обложка ADR-115 (WebP 1280/320, ключ
    `portfolio/<profile_id>/<uuid7>`). Порядок пересчитывает сервис, чтобы
    после удаления/смены основного не было дыр."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    project = models.ForeignKey(PortfolioProject, related_name="photos", on_delete=models.CASCADE)
    photo_key = models.CharField(max_length=255)
    order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "portfolio_photo"
        verbose_name = "фото проекта портфолио"
        verbose_name_plural = "фото проектов портфолио"
        ordering = ["order", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "photo_key"], name="portfolio_photo_key_unique"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.project_id}:{self.order}"


class WorkArea(models.Model):
    """География РАБОТЫ профиля — план 11.09 §4, ADR-182. НЕ юрисдикция:
    юрисдикция (применимое право) — это `apps.accounts.User.country_code`,
    выбирается отдельно и этой моделью не затрагивается («страна Россия,
    город Дели» перестаёт быть противоречием ровно потому, что это два
    независимых факта о человеке — где действует право и где он ищет
    заказы). Постановка владельца дословно — `docs/adr/ADR-182-*.md`.

    МАСШТАБ (`scope`), а не обязательный город: справочник `apps.geo`
    ограничен населёнными пунктами от 15 000 жителей (ADR-179) — житель
    посёлка, которого там нет, обязан иметь возможность указать себя
    КРУПНЕЕ (район/область — `region`, страна — `country`, весь мир —
    `world`), а не быть вынужденным придумывать ближайший крупный город.
    Поэтому у записи заполнена РОВНО ОДНА из трёх ссылок на справочник в
    зависимости от `scope` (`world` — ни одной) — проверяется
    CheckConstraint `work_area_scope_matches_level` (БД, не только код,
    CLAUDE.md), не только сериализатором.

    Ссылки — на `apps.geo.Country/Region/City` (нижний слой, `apps.profiles`
    имеет право импортировать его модели напрямую — import-linter это не
    запрещает, запрет только в обратную сторону). `on_delete=PROTECT`:
    `apps.geo` не удаляет строки (только `is_active=False` при
    переимпорте) — PROTECT здесь чисто защитный, ожидаемых удалений нет.

    Дубли одного и того же места у профиля запрещены — частичные
    `UniqueConstraint` ниже (по одной на `scope`, т.к. значимое поле у
    каждого масштаба своё; для `world` — вообще без него, поэтому
    уникальность у него просто `(profile, scope)` без доп. условия).
    Лимит «не больше 5 записей на профиль» — НЕ здесь: BulkCreate/DB не
    знает заранее, сколько строк придёт одной транзакцией replace'а, поэтому
    считает `services.replace_work_areas` (docs пункт «не больше 5» —
    сознательно уровень сервиса, не БД, план 11.09 §4)."""

    class Scope(models.TextChoices):
        WORLD = "world", "Весь мир"
        COUNTRY = "country", "Страна"
        REGION = "region", "Регион/область"
        CITY = "city", "Город"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    profile = models.ForeignKey(Profile, related_name="work_areas", on_delete=models.CASCADE)
    scope = models.CharField(max_length=16, choices=Scope.choices)
    country = models.ForeignKey(
        "geo.Country", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    region = models.ForeignKey(
        "geo.Region", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    city = models.ForeignKey(
        "geo.City", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "profile_work_area"
        verbose_name = "регион работы"
        verbose_name_plural = "регионы работы"
        ordering = ["created_at", "id"]
        constraints = [
            # «У масштаба заполнен ровно свой уровень» (план 11.09 §4) —
            # литералы Scope дублируются намеренно (тот же приём, что
            # profile_owner_matches_kind выше: значения TextChoices не
            # видны из области класса Meta).
            models.CheckConstraint(
                condition=(
                    Q(scope="world", country__isnull=True, region__isnull=True, city__isnull=True)
                    | Q(
                        scope="country",
                        country__isnull=False,
                        region__isnull=True,
                        city__isnull=True,
                    )
                    | Q(
                        scope="region",
                        country__isnull=True,
                        region__isnull=False,
                        city__isnull=True,
                    )
                    | Q(scope="city", country__isnull=True, region__isnull=True, city__isnull=False)
                ),
                name="work_area_scope_matches_level",
            ),
            models.UniqueConstraint(
                fields=["profile"],
                condition=Q(scope="world"),
                name="work_area_unique_world_per_profile",
            ),
            models.UniqueConstraint(
                fields=["profile", "country"],
                condition=Q(scope="country"),
                name="work_area_unique_country_per_profile",
            ),
            models.UniqueConstraint(
                fields=["profile", "region"],
                condition=Q(scope="region"),
                name="work_area_unique_region_per_profile",
            ),
            models.UniqueConstraint(
                fields=["profile", "city"],
                condition=Q(scope="city"),
                name="work_area_unique_city_per_profile",
            ),
        ]

    def __str__(self) -> str:
        ref = self.country_id or self.region_id or self.city_id or "—"
        return f"{self.profile_id}:{self.scope}:{ref}"
