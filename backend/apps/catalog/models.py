"""tech-spec.md §5.2.5 (ревизия 2.0.3), §6.6; domain-model.md §15; docs/catalog-v2.md."""

from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class Currency(models.Model):
    """Справочник валют ISO 4217 — универсальный, одна таблица на все страны.

    ADR-041: справочник НЕ создаёт «валюту по умолчанию» — каждая Money
    несёт валюту явно. Подстановка в UI живёт в apps.jurisdictions
    (JurisdictionConfig.default_currency_code), не здесь.
    """

    code = models.CharField(max_length=3, primary_key=True)
    numeric_code = models.CharField(max_length=3)
    name_i18n = models.JSONField(default=dict)
    symbol = models.CharField(max_length=8)
    decimal_places = models.PositiveSmallIntegerField(default=2)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "currency"
        verbose_name = "валюта"
        verbose_name_plural = "валюты"

    def __str__(self) -> str:
        return self.code


class ContractTypeCatalogItem(models.Model):
    """Закрытый список типов договоров (ADR-058) — tech-spec.md §5.2.5/§6.6,
    domain-model.md §15, docs/catalog-v2.md. Данные, не код: белый список
    меняется миграцией, не релизом.

    В коде до этой миграции не существовало ни базовой схемы §5.2.5, ни
    отдельного «сида этапа 2» — docs/catalog-v2.md §7 оформлен как дельта к
    сиду, которого фактически не было, поэтому база (default_segment,
    requires_service_flag, allowed_deal_types, is_hidden,
    needs_special_handling, legal_basis, sort_order, is_active) и дельта
    (available_from, needs_official_clarification, client_option,
    tax_note_i18n, smz_own_production_only) заведены одной моделью и одним
    сидом Р1.

    `default_segment`/`requires_service_flag`/`needs_special_handling` —
    вход apps.catalog.services.compute_segment (§6.6). Для типов, где
    сегмент не зависит от статуса стороны на момент выбора кода
    (`services_individual`/`services_business` — код уже выбран
    apps.catalog.services.resolve_service_contract_type_code по статусу
    исполнителя; `sale_personal`/`sale_business`/`loan_individuals` —
    расщеплены на отдельные коды в клиентском дереве, docs/catalog-v2.md §1),
    `requires_service_flag=False`, и `default_segment` возвращается как есть.
    Для типов с единым кодом, где сегмент зависит от статуса стороны
    на момент КАЖДОГО договора (`rent_items`, `rent_home`),
    `requires_service_flag=True`.
    """

    class Segment(models.TextChoices):
        FREE_C2C = "free_c2c", "Бесплатный C2C"
        PAID_BUSINESS = "paid_business", "Платный бизнес"
        SPECIAL = "special", "Особая проработка"
        EXCLUDED = "excluded", "Не поддерживается"

    class ClientOption(models.TextChoices):
        """Опция первого экрана клиентского дерева (docs/catalog-v2.md §1, §7 п.4)."""

        SERVICE = "service", "Услуга"
        SALE = "sale", "Продажа"
        RENT = "rent", "Аренда"
        LOAN = "loan", "Займ"

    class Release(models.TextChoices):
        """`available_from` — с какого релиза тип виден в клиентском дереве
        (docs/catalog-v2.md §7 п.1; excluded скрыт независимо от релиза)."""

        R1 = "r1", "Релиз 1"
        R2 = "r2", "Релиз 2"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name_i18n = models.JSONField(default=dict)

    default_segment = models.CharField(max_length=16, choices=Segment.choices)
    requires_service_flag = models.BooleanField(default=False)
    allowed_deal_types = ArrayField(models.CharField(max_length=8), default=list, blank=True)
    is_hidden = models.BooleanField(default=False)
    needs_special_handling = models.BooleanField(default=False)
    legal_basis = models.TextField(blank=True, default="")
    sort_order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    # --- Дельта docs/catalog-v2.md §7 ---
    client_option = models.CharField(
        max_length=16, choices=ClientOption.choices, null=True, blank=True
    )
    available_from = models.CharField(max_length=2, choices=Release.choices, default=Release.R1)
    needs_official_clarification = models.BooleanField(default=False)
    tax_note_i18n = models.JSONField(default=dict)
    smz_own_production_only = models.BooleanField(
        default=False,
        help_text="ст. 4 ФЗ-422: СМЗ-продавцу запрещена перепродажа чужого товара.",
    )

    class Meta:
        db_table = "contract_type_catalog_item"
        verbose_name = "тип договора каталога"
        verbose_name_plural = "типы договоров каталога"
        ordering = ["sort_order", "code"]

    def __str__(self) -> str:
        return self.code


class Sphere(models.Model):
    """Справочник сфер услуг/работ (tech-spec.md §5.2.5) — таблица, НЕ enum
    (docs/plan.md этап 2: «Sphere ... правка Р-3» — код сферы меняется
    данными, не релизом). Milestone.sphere (apps.milestones, Э4.3,
    domain-model.md §7.1) задаётся на ветке дерева этапов
    («мультисферность» — разные сферы в разных частях одного договора).

    Наполнение всех 17 сфер полными чек-листами (решение 01.08,
    docs/contract-forms.md §8 п.1) — отдельный контентный трек (П-03/Б9,
    генерация партиями с ревью владельца), вне этой миграции: здесь только
    механизм (модель + сид минимального набора для тестов Э4.3).
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name_i18n = models.JSONField(default=dict)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "sphere"
        verbose_name = "сфера"
        verbose_name_plural = "сферы"
        ordering = ["code"]

    def __str__(self) -> str:
        return self.code


class MaterialCatalogItem(models.Model):
    """Универсальная номенклатура материалов (tech-spec.md §5.2.5,
    domain-model.md §7.3). Справочник ПОДСКАЗЫВАЕТ (рекомендация чек-листа
    по материалу, `ChecklistTemplateItem.catalog_item`), но НЕ ограничивает:
    `suggested_unit`/`spec_template` — только подсказки, единицы измерения
    ContractMaterial не валидируются по ним.

    `sphere` обязательна: у КАЖДОЙ сферы есть запасная позиция «Прочее»
    (`code=f"other_{sphere.code}"`) — не общая на все сферы, а своя у
    каждой (domain-model.md §7.3 докстринг Material CatalogItem)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    code = models.CharField(max_length=64, unique=True)
    sphere = models.ForeignKey(Sphere, related_name="material_items", on_delete=models.PROTECT)
    name_i18n = models.JSONField(default=dict)
    suggested_unit = models.CharField(max_length=32, blank=True, default="")
    spec_template = models.JSONField(default=list, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "material_catalog_item"
        verbose_name = "позиция каталога материалов"
        verbose_name_plural = "позиции каталога материалов"
        ordering = ["sphere_id", "code"]

    def __str__(self) -> str:
        return self.code


class ChecklistTemplateItem(models.Model):
    """Шаблонный пункт чек-листа (tech-spec.md §5.2.5, ADR-047):
    привязывается либо к конкретной позиции материала (`catalog_item`),
    либо к сфере целиком (базовые пункты сферы) — используется
    `apps.milestones.services` для GET .../checklist-recommendations.

    description_i18n (ГВ.5, docs/tasks/global-wave.md, ADR-075) — EN-болванка
    рядом с `description`, НЕ вместо него: `description` — часть ключа
    выборки в сид-миграции 0006 (update_or_create по catalog_item/sphere/
    description) и читается apps.milestones.services напрямую — менять его
    смысл здесь означало бы трогать чужой домен (apps.milestones) с этой
    ветки. `description_i18n` — новое, отдельное поле-справочник, тот же
    механизм, что name_i18n у остальных каталогов, но параллельно
    существующему тексту, не взамен.

    `slug`/`version`/`is_current` (ADR-081, П-03) — версионирование
    контента, ввезённого `import_checklists` из `docs/content/checklists/`
    (18 GLOBAL-файлов CL-*.md, 17 сфер + `other` + `social`-акты). `slug` —
    стабильный человекочитаемый ID вида `<сфера>.<категория>.<код пункта>`
    (код пункта берётся из markdown-таблицы как есть — уже человекочитаем и
    уникален по замыслу самих файлов, `00_индекс.md` §2); присваивается
    ОДИН РАЗ при первом импорте строки и дальше не меняется. Правка текста
    пункта в markdown при повторном импорте не перезаписывает существующую
    строку — заводится НОВАЯ строка с тем же `slug`, `version + 1`,
    `is_current=True`, у старой строки `is_current` становится `False`; сама
    старая строка не удаляется и не редактируется — на неё могут ссылаться
    уже сделанные снепшоты договоров (`ContractVersion`), тот же принцип,
    что `apps.catalog.services.ClauseTemplate`-подобные справочники текста,
    зафиксированного в договоре навсегда. Пункты, заведённые НЕ через
    `import_checklists` (ручной сид миграции 0006 — `renovation_tile` и
    т.п.), `slug` не имеют (`""`) — версионирование их не касается,
    `is_current=True` по умолчанию, в выборках участвуют как раньше.

    `category`/`code` — сырые значения из markdown-таблицы (колонки
    «категория» и «код пункта»), нужны, чтобы восстановить `slug` и чтобы
    материалы (`MaterialCatalogItem`, §2 файлов) могли сослаться на пункт
    по паре (категория, код), как это сделано в самих файлах («связанные
    пункты чек-листа»). `check_method`/`photo_required`/`is_default` —
    прямой маппинг колонок «как проверить»/«фото»/«дефолт», см. docstring
    `CL-renovation_GLOBAL.md` §0 «Маппинг на модель данных». `source_file` —
    имя исходного CL-файла, для трассировки при ревью контента.

    `measurable_criterion` для импортированных пунктов равен `description`:
    в GLOBAL-формате «формулировка» уже несёт единственный измеримый
    критерий одним предложением (`00_индекс.md` §2 «один пункт — один
    критерий») — отдельного текста критерия markdown не содержит, заводить
    его синтетически отдельно от текста было бы дублированием без
    источника.

    `is_jurisdiction_sensitive` (ADR-081, доп. 2026-08-12) — пункт содержит
    страновую реалию (в исходном markdown размечался инлайн-маркером
    «[Л]», см. `00_индекс.md` §2 «GLOBAL-правила»; допускался и вариант
    «[L]», латиницей). Маркер — соглашение авторов контента, из markdown
    НЕ вычищается (файлы остаются читаемым источником для ревью и для
    будущих правок), а вычищается парсером (`checklist_markdown.parse_file`)
    ТОЛЬКО из значения этого поля перед сохранением в `description` —
    структурный флаг заменяет текстовый артефакт разметки. Существующие на
    момент этой правки строки почищены миграцией 0017 БЕЗ инкремента
    `version` — правка текста здесь удаляет только служебный маркер, не
    меняет содержание пункта (решение и обоснование — ADR-081, раздел
    «Дополнение»)."""

    class CheckMethod(models.TextChoices):
        """Enum «как проверить» (`00_индекс.md` §2, 6 значений, принято ревью 05.08)."""

        VISUAL = "осмотр", "Осмотр"
        MEASURE = "замер", "Замер"
        ACTIVATION = "включение", "Включение"
        WATER_TEST = "пролив", "Пролив"
        DOCUMENT = "документ", "Документ"
        PHOTO = "фото", "Фото"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    catalog_item = models.ForeignKey(
        MaterialCatalogItem,
        related_name="suggested_checklist_items",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    sphere = models.ForeignKey(
        Sphere,
        related_name="base_checklist_items",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    description = models.TextField()
    description_i18n = models.JSONField(default=dict, blank=True)
    measurable_criterion = models.TextField()
    required_evidence = ArrayField(models.CharField(max_length=64), default=list, blank=True)
    order = models.PositiveSmallIntegerField(default=0)

    # --- Дельта import_checklists (ADR-081, П-03) ---
    slug = models.CharField(max_length=160, blank=True, default="")
    version = models.PositiveIntegerField(default=1)
    is_current = models.BooleanField(default=True)
    category = models.CharField(max_length=64, blank=True, default="")
    code = models.CharField(max_length=96, blank=True, default="")
    check_method = models.CharField(
        max_length=16, choices=CheckMethod.choices, blank=True, default=""
    )
    photo_required = models.BooleanField(default=False)
    is_default = models.BooleanField(default=True)
    source_file = models.CharField(max_length=128, blank=True, default="")
    is_jurisdiction_sensitive = models.BooleanField(default=False)

    class Meta:
        db_table = "checklist_template_item"
        verbose_name = "шаблонный пункт чек-листа"
        verbose_name_plural = "шаблонные пункты чек-листа"
        ordering = ["order"]
        constraints = [
            models.CheckConstraint(
                condition=Q(catalog_item__isnull=False) | Q(sphere__isnull=False),
                name="checklist_template_item_needs_source",
            ),
            # Ровно одна текущая версия на slug (импортированные пункты;
            # slug="" у ручного сида в constraint не участвует).
            models.UniqueConstraint(
                fields=["slug"],
                condition=Q(is_current=True) & ~Q(slug=""),
                name="checklist_template_item_slug_current_unique",
            ),
            models.UniqueConstraint(
                fields=["slug", "version"],
                condition=~Q(slug=""),
                name="checklist_template_item_slug_version_unique",
            ),
        ]

    def __str__(self) -> str:
        return self.description[:60]


class ClauseTemplate(models.Model):
    """Текст пункта договора по К/V-блоку конструктора, per-контур (ГВ.5,
    docs/tasks/global-wave.md, ADR-075).

    `block_code` — код блока конструктора (docs/contract-forms.md: К1–К15 +
    V-модули; конкретные значения, реально используемые сейчас формами
    договоров, — `apps.contracts.forms.FormField.kv_block`, например "K2",
    "V-GOODS", "tax_note"). `apps.catalog` НЕ импортирует apps.contracts
    (нижний слой, ADR-070) — значения block_code синхронизируются вручную,
    как и коды валют между apps.catalog/apps.jurisdictions (0007_seed_usd_eur).

    `country_code` — по значению (как apps.jurisdictions.JurisdictionConfig.
    country_code), не FK: apps.catalog и apps.jurisdictions — сиблинги
    нижнего слоя, ни один их сид не зависит от миграций другого.

    `legal_anchors` — пусто для GLOBAL (юрсилу не заявляем, ГВ.1 §2:
    «фиксируем факты; их юридическую судьбу определяет ваша юрисдикция»);
    для RU-контура (когда появится — отдельный трек генерации юртекста,
    apps/contracts/forms.py docstring) — ссылки на нормы права.

    RU-строки этой таблицы здесь НЕ заводятся: генерация юридического
    текста из К/V-блоков для RU — отдельный, ещё не начатый трек
    (`apps/contracts/forms.py`: «генерация юртекста из K/V-блоков —
    отдельный трек»); ГВ.5 добавляет только GLOBAL-профиль той же формы,
    чтобы RU-трек, когда начнётся, просто заполнил недостающие страны той
    же моделью, не переопределяя её."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    country_code = models.CharField(max_length=8)
    block_code = models.CharField(max_length=32)
    text = models.TextField()
    legal_anchors = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = "clause_template"
        verbose_name = "текст пункта договора"
        verbose_name_plural = "тексты пунктов договора"
        constraints = [
            models.UniqueConstraint(
                fields=["country_code", "block_code"], name="clause_template_country_block_unique"
            ),
        ]
        ordering = ["country_code", "block_code"]

    def __str__(self) -> str:
        return f"{self.country_code}:{self.block_code}"


class ChecklistTemplatePickStat(models.Model):
    """Востребованность шаблонного пункта чек-листа — сколько раз пункт
    реально попал в чек-лист этапа настоящего договора (ADR-153).

    Отдельная таблица, а не поле `pick_count` на `ChecklistTemplateItem`,
    по двум причинам:

    1. Версионирование (ADR-081): правка формулировки в markdown заводит
       НОВУЮ строку `ChecklistTemplateItem` с тем же `slug` и `version + 1`,
       старая остаётся с `is_current=False`. Счётчик на строке обнулялся бы
       при каждой правке текста; ключ `slug` переживает переимпорт —
       востребованность копится по ПУНКТУ, а не по его редакции.
    2. Счётчик — горячая на запись величина (инкремент на каждое создание
       пункта чек-листа), справочник — холодная на чтение таблица под
       кешем `_cached_payload`; разводить их по разным строкам дешевле, чем
       трогать справочник на каждый пик.

    `slug` непустой (CheckConstraint): пункты ручного сида миграции 0006
    (`slug=""`) стабильного идентификатора, переживающего переимпорт, не
    имеют — их пики не учитываются (и в ранжируемую выдачу
    `list_checklist_recommendations` они не попадают: у них пустая
    `category`, а `workType` в запросе обязателен и непуст).

    Считает apps.milestones через фасад `apps.catalog.services.
    record_checklist_pick` (milestones → catalog разрешено import-linter'ом,
    обратное — нет; каталог сам про договоры ничего не знает и знать не
    должен)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    slug = models.CharField(max_length=160, unique=True)
    pick_count = models.PositiveIntegerField(default=0)
    last_picked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "checklist_template_pick_stat"
        verbose_name = "востребованность шаблонного пункта"
        verbose_name_plural = "востребованность шаблонных пунктов"
        ordering = ["-pick_count", "slug"]
        constraints = [
            models.CheckConstraint(
                condition=~Q(slug=""),
                name="checklist_template_pick_stat_slug_not_empty",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.slug}: {self.pick_count}"
