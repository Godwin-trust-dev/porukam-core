"""tech-spec.md §5.2.1b, §7.2, §8.1b; domain-model.md §3.6; docs/tasks/
etap-3.md 3.3; docs/tasks/etap-3-delta-adr059.md (дельта первична при
расхождении с etap-3.md — ADR-059 финал, журнал ч.4, внешний относительно
этого репозитория, НЕ путать с локальным docs/adr/ADR-059-envelope-
encryption-common.md — оба названы «ADR-059», это два разных документа).

import-linter (pyproject.toml): apps.social зависит ТОЛЬКО от apps.accounts
(+ common). Consent НЕ обновляет apps.profiles.Profile напрямую (импорт
запрещён контрактом) — согласие profile_public публикуется в outbox
(social.consent_recorded), apps.profiles подписан на топик и реагирует сам
(apps/profiles/subscriber.py), как apps.notifications на entity.claimed
(ЭФ.4). Это же решает «немедленное применение» (delta §2 тест 6) — тем же
приёмом, что и остальной домен: relay sweep каждые 5с, в тестах —
common.relay.deliver_due_events() синхронно.

Consent — БЕЗ envelope-шифрования сейчас (docs/tasks/etap-3-delta-adr059.md
§3: «3.5 privacy: ... таблица согласий — под envelope-ключом» — это явно
ОТЛОЖЕНО на будущую под-задачу privacy, не часть 3.3+дельты)."""

from __future__ import annotations

from django.conf import settings
from django.db import models

from common.uuid7 import uuid7

_CI_COLLATION = "case_insensitive"


class AddressableGroup(models.Model):
    """Объединение-витрина (tech-spec.md §5.2.1b): НЕ сторона договора, НЕ
    носит репутацию — подписывает и отвечает всегда лидер лично."""

    class Kind(models.TextChoices):
        """v2 (ADR-117, книга trust_economy/Block IV гл. 14): гильдия —
        постоянное профессиональное сообщество (коллективный гарант
        качества), клан — проектная команда 3–20 (дефолт), сообщество —
        открытая группа по интересам, витрина компании — публичное лицо
        компании. Миграция 0005: company_storefront→company_showcase,
        informal→clan."""

        GUILD = "guild", "Гильдия"
        CLAN = "clan", "Клан"
        COMMUNITY = "community", "Сообщество"
        COMPANY_SHOWCASE = "company_showcase", "Витрина компании"

    class GeoScope(models.TextChoices):
        """То же деление, что зоны поиска ADR-114 (ADR-117 §3)."""

        WORLD = "world", "Весь мир"
        COUNTRY = "country", "Страна"
        CITY = "city", "Город"

    class ReputationMode(models.TextChoices):
        AGGREGATE_ONLY = "aggregate_only", "Только агрегат"
        NONE = "none", "Не показывается"

    class JoinPolicy(models.TextChoices):
        """Отсмотр 2026-08-23: «открытые сообщества со свободным входом и
        закрытые — только при подтверждении администратора»."""

        OPEN = "open", "Свободный вход"
        APPROVAL = "approval", "По подтверждению администратора"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    kind = models.CharField(max_length=32, choices=Kind.choices, default=Kind.CLAN)
    leader = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="led_groups", on_delete=models.PROTECT
    )
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    # ADR-117 §2: код сферы КАТАЛОГА по значению, не FK (import-linter:
    # social зависит только от accounts — приём Consent.locale). "" —
    # легаси-строки до v2; новые объединения создаются только со сферой.
    sphere_code = models.CharField(max_length=64, blank=True, default="")
    # ADR-117 §3: география витрины; country_code/city_name — те же
    # форматы, что User.country_code и Profile.city_name (ADR-114).
    geo_scope = models.CharField(max_length=16, choices=GeoScope.choices, default=GeoScope.WORLD)
    country_code = models.CharField(max_length=8, blank=True, default="")
    city_name = models.CharField(max_length=120, blank=True, default="")
    # ADR-117 §4: [{"url": ..., "label": ...}] ≤ 10 — валидация в API-слое.
    links = models.JSONField(default=list, blank=True)
    # ADR-117 §8: логотип — квадратный WebP 256/64 (пайплайн ADR-103 через
    # common/images.py); ключ `group-logos/<group_id>/<uuid7>`, "" — нет.
    logo_key = models.CharField(max_length=255, blank=True, default="")
    is_public = models.BooleanField(default=True)
    join_policy = models.CharField(
        max_length=16, choices=JoinPolicy.choices, default=JoinPolicy.OPEN
    )
    reputation_mode = models.CharField(
        max_length=16, choices=ReputationMode.choices, default=ReputationMode.AGGREGATE_ONLY
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "addressable_group"
        verbose_name = "объединение"
        verbose_name_plural = "объединения"

    def __str__(self) -> str:
        return self.name


class GroupMembership(models.Model):
    class Role(models.TextChoices):
        LEADER = "leader", "Лидер"
        ADMIN = "admin", "Администратор"
        MEMBER = "member", "Участник"

    class Status(models.TextChoices):
        INVITED = "invited", "Приглашён"
        # Заявка на вступление в закрытое объединение (join_policy=approval) —
        # ждёт решения лидера/админа (отсмотр 2026-08-23).
        REQUESTED = "requested", "Заявка"
        ACTIVE = "active", "Активен"
        LEFT = "left", "Вышел"

    id = models.BigAutoField(primary_key=True)
    group = models.ForeignKey(
        AddressableGroup, related_name="memberships", on_delete=models.CASCADE
    )
    member = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="group_memberships", on_delete=models.CASCADE
    )
    role = models.CharField(max_length=16, choices=Role.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.INVITED)
    joined_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "group_membership"
        verbose_name = "членство в объединении"
        verbose_name_plural = "членства в объединениях"
        constraints = [
            models.UniqueConstraint(fields=["group", "member"], name="unique_group_membership"),
        ]

    def __str__(self) -> str:
        return f"{self.group_id}:{self.member_id}:{self.role}"


class Handle(models.Model):
    """@username — адресуемость, НЕ верифицированная личность (domain-model.md
    §3.6). Смена освобождает старый (частичный уникальный индекс WHERE
    is_active) — история хранится (антифрод: частая смена — как частая смена
    директора), не удаляется."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        related_name="handles",
        on_delete=models.CASCADE,
    )
    group = models.ForeignKey(
        AddressableGroup, null=True, blank=True, related_name="handles", on_delete=models.CASCADE
    )
    value = models.CharField(max_length=32, db_collation=_CI_COLLATION)
    is_active = models.BooleanField(default=True)
    assigned_at = models.DateTimeField(auto_now_add=True)
    changed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "handle"
        verbose_name = "хендл"
        verbose_name_plural = "хендлы"
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(user__isnull=False, group__isnull=True)
                    | models.Q(user__isnull=True, group__isnull=False)
                ),
                name="handle_exactly_one_owner",
            ),
            models.UniqueConstraint(
                fields=["value"],
                condition=models.Q(is_active=True),
                name="handle_value_unique_active",
            ),
        ]

    def __str__(self) -> str:
        return f"@{self.value}"


class Contact(models.Model):
    """Приватное ребро графа доверия (tech-spec.md §5.2.1b): видит только
    owner (chужие — 404, не 403, apps/social/selectors.py). target_phone_hash
    хранится для рёбер, найденных через phonebook (apps.social.services.
    reconcile_phonebook), target_user проставляется при совпадении хеша."""

    class Source(models.TextChoices):
        PHONEBOOK = "phonebook", "Телефонная книга"
        MANUAL = "manual", "Вручную"
        DEAL = "deal", "Сделка"
        LINK = "link", "Ссылка"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="contacts", on_delete=models.CASCADE
    )
    target_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, related_name="+", on_delete=models.CASCADE
    )
    target_phone_hash = models.CharField(max_length=64, null=True, blank=True)
    display_name_encrypted = models.BinaryField(null=True, blank=True)
    encryption_key_ref = models.CharField(max_length=64, null=True, blank=True)
    source = models.CharField(max_length=16, choices=Source.choices)
    is_mutual = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "contact"
        verbose_name = "контакт"
        verbose_name_plural = "контакты"
        constraints = [
            # Postgres UNIQUE допускает много NULL — «уникально, когда задано»
            # получаем без частичных индексов (tech-spec.md §5.2.1b — обе как
            # безусловный UNIQUE).
            models.UniqueConstraint(
                fields=["owner", "target_user"], name="unique_contact_owner_target_user"
            ),
            models.UniqueConstraint(
                fields=["owner", "target_phone_hash"], name="unique_contact_owner_target_phone_hash"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.owner_id} -> {self.target_user_id or self.target_phone_hash}"


class PhonebookHash(models.Model):
    """Необратимые хеши номеров телефонной книги (152-ФЗ; docs/tasks/
    etap-3-delta-adr059.md Р8): сырые номера не хранятся никогда. После
    каждой сверки (apps.social.services.reconcile_phonebook) в таблице
    остаются ТОЛЬКО хеши, совпавшие с discoverable_by_phone=true
    пользователем — несматченные удаляются в той же транзакции."""

    id = models.BigAutoField(primary_key=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="phonebook_hashes", on_delete=models.CASCADE
    )
    phone_hash = models.CharField(max_length=64)
    algorithm = models.CharField(max_length=32)
    salt_ref = models.CharField(max_length=32)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "phonebook_hash"
        verbose_name = "хеш телефонной книги"
        verbose_name_plural = "хеши телефонной книги"
        constraints = [
            models.UniqueConstraint(fields=["user", "phone_hash"], name="unique_phonebook_hash"),
        ]

    def __str__(self) -> str:
        return f"{self.user_id}:{self.phone_hash[:8]}…"


class Consent(models.Model):
    """Универсальная модель согласия (docs/tasks/etap-3-delta-adr059.md §1.2,
    152-ФЗ/ФЗ-156 — согласия отдельными документами, ст. 10.1 — «молчание ≠
    согласие»). Append-only: смена/отзыв — НОВАЯ строка, история не
    перезаписывается. text_version проставляется сервером по
    settings.CONSENT_TEXT_VERSIONS (данные, не выбор клиента — исключает
    рассинхрон между тем, что реально показали, и тем, что записали).

    locale (Л.2, docs/tasks/l10n-wave.md п.5, ADR-077) — язык ПОКАЗАННОГО
    текста согласия (что реально видел пользователь), по значению, не FK
    на apps.l10n.Locale: apps.social зависит только от apps.accounts
    (import-linter) — тот же приём, что JurisdictionConfig.primary_locale/
    ClauseTemplate.country_code."""

    class ConsentType(models.TextChoices):
        PD_PROCESSING = "pd_processing", "Обработка персональных данных"
        PROFILE_PUBLIC = "profile_public", "Публичность профиля"
        PHONE_DISCOVERABILITY = "phone_discoverability", "Находимость по телефону"
        # ГВ.2 (docs/tasks/global-wave.md, ADR-071) — четвёртое согласие
        # стартового пакета GLOBAL: история сделок как основа репутационной
        # карточки (ГВ.4). С первого дня — ретроспективно добавить нельзя,
        # поэтому тип согласия общий для всех контуров (Consent —
        # универсальная модель), а не только для GLOBAL-регистрации.
        REPUTATION_HISTORY_BASIS = "reputation_history_basis", "История сделок в репутации"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="consents", on_delete=models.CASCADE
    )
    consent_type = models.CharField(max_length=32, choices=ConsentType.choices)
    value = models.BooleanField()
    text_version = models.CharField(max_length=32)
    locale = models.CharField(max_length=16, default="ru")
    device = models.CharField(max_length=255, blank=True, default="")
    ip = models.GenericIPAddressField(null=True, blank=True)
    granted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "consent"
        verbose_name = "согласие"
        verbose_name_plural = "согласия"
        indexes = [
            models.Index(
                fields=["user", "consent_type", "-granted_at"], name="consent_user_type_idx"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user_id}:{self.consent_type}={self.value}"


class GroupPortfolioProject(models.Model):
    """Проект портфолио ОБЪЕДИНЕНИЯ (ADR-128) — витрина работ гильдии/клана
    рядом с личным портфолио человека (ADR-115/ADR-120, apps.profiles).

    Отдельная модель, а не `owner`-обобщение `PortfolioProject`: import-linter
    запрещает apps.social импортировать apps.profiles, а личный проект
    привязан к `Portfolio` (OneToOne на `Profile`), которого у объединения
    нет. Общий у двух витрин — байтовый пайплайн (common/images.py,
    common/object_store.py), ровно как у логотипа ADR-117 §8.

    Полей `source`/`is_verified`/`verified_facts`/`counterparty_consent` здесь
    НЕТ намеренно: объединение — не сторона договора и репутацию не носит
    (tech-spec.md §5.2.1b), сделочных фактов у него быть не может. Публикация
    (`is_published`) тоже не нужна — витрина объединения публична целиком, её
    видимость определяет `AddressableGroup.is_public`.

    `sphere_code` — код сферы КАТАЛОГА по значению, не FK (тот же приём, что
    `AddressableGroup.sphere_code`, ADR-117 §2); "" — сфера не указана."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    group = models.ForeignKey(
        AddressableGroup, related_name="portfolio_projects", on_delete=models.CASCADE
    )
    title = models.CharField(max_length=200)
    # Просторное описание без лимита — как у личного проекта (ADR-120 §3).
    description = models.TextField(blank=True, default="")
    sphere_code = models.CharField(max_length=64, blank=True, default="")
    # ADR-120 §3: `completed_at` обязательна (проверяет сервис, не БД —
    # симметрично личному портфолио), `started_at` опциональна.
    started_at = models.DateField(null=True, blank=True)
    completed_at = models.DateField(null=True, blank=True)
    # Город — опционально (ADR-120 §3).
    location_label = models.CharField(max_length=200, blank=True, default="")
    # Зеркало ключа ОСНОВНОГО фото (`photos[0]`), пишет только сервис
    # (`_sync_group_cover`) — как `PortfolioProject.photo_key` в ADR-120.
    photo_key = models.CharField(max_length=255, blank=True, default="")
    order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_portfolio_project"
        verbose_name = "проект портфолио объединения"
        verbose_name_plural = "проекты портфолио объединений"
        ordering = ["order", "-created_at"]

    def __str__(self) -> str:
        return f"{self.group_id}:{self.title}"


class GroupPortfolioPhoto(models.Model):
    """Фото проекта портфолио объединения (ADR-128): до
    `services.GROUP_PORTFOLIO_MAX_PHOTOS` (5) на проект, основное — `order == 0`
    (первое). Байты — WebP 1280/320 без кропа, ключ
    `group-portfolio/<group_id>/<uuid7>`, тот же бакет, что логотипы.
    Порядок пересчитывает сервис, чтобы после удаления не было дыр."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    project = models.ForeignKey(
        GroupPortfolioProject, related_name="photos", on_delete=models.CASCADE
    )
    photo_key = models.CharField(max_length=255)
    order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_portfolio_photo"
        verbose_name = "фото проекта портфолио объединения"
        verbose_name_plural = "фото проектов портфолио объединений"
        ordering = ["order", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "photo_key"], name="group_portfolio_photo_key_unique"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.project_id}:{self.order}"
