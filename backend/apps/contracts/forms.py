"""apps.contracts.forms — П-16 (docs/contract-forms.md, док 30 v1.0):
реестр декларативных схем полей `form_data` по семи кодам Р1
(docs/catalog-v2.md §2). Дельта к Э4.1 (docs/tasks/etap-4-delta-p16.md) —
БЕЗ миграции ядра: схемы живут в коде, `Contract.form_data` остаётся
свободным jsonb (apps.contracts.models).

Правило конструктора (док 30 §8 п.4): «ничего обязательного — просто
возможности» — жёстко обязательны только поля, без которых договор
юридически не существует; всё остальное — опции с умными дефолтами.

Границы дельты (etap-4-delta-p16.md § «НЕ делать»): дерево этапов и
материалы — сущности Milestone/ContractMaterial (Э4.3), в `form_data` их
нет — здесь только маркеры секций (`FormSection.external_entity`) для
фронтенда; генерация юртекста из K/V-блоков — отдельный трек
(`FormField.kv_block` — только метаданные mapping, ничего не генерирует);
автоблоки §0 дока 30 (стороны, подписант, ПЭП) — не поля формы, сюда не
попадают.

Совместимость с Э4.1/Э4.2 (уже в main): их тесты создают/патчат черновики с
`form_data={}` — форма конструктора там не открывалась, это не относится
к содержимому сделки. Пустой `form_data` валиден для ЛЮБОГО типа без
исключений — валидация схемы запускается, только когда пришёл хотя бы один
ключ (форму начали заполнять). Это тот же принцип «ничего обязательного»,
доведённый до предела: не заполнено ничего — нечего проверять.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from django.conf import settings

from apps.contracts.models import Contract, ContractParty

Json = Any


class FormValidationError(ValueError):
    """Хотя бы одна жёсткая проверка схемы формы провалена. `errors` — список
    `{"field", "code", "message"}` (api/ переводит в 422 `form_data_invalid`,
    `context={"errors": ...}`)."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("form_data не прошёл валидацию схемы")
        self.errors = errors


class FormSchemaNotFoundError(LookupError):
    """Для `contract_type_code` нет зарегистрированной схемы формы — код не
    входит в семёрку Р1 этой дельты (либо скрыт/спец/excluded в каталоге,
    см. api/views._get_form_schema_or_error)."""


def _err(field_name: str, code: str, message: str) -> dict[str, str]:
    return {"field": field_name, "code": code, "message": message}


def _warn(field_name: str, i18n_key: str) -> dict[str, str]:
    return {"field": field_name, "i18n_key": i18n_key}


@dataclass(frozen=True, slots=True)
class Condition:
    """Видимость/условная обязательность поля — по значению ДРУГОГО поля той
    же формы (form_data — плоский словарь, без вложенности)."""

    field: str
    in_values: tuple[str, ...]

    def holds(self, data: dict[str, Any]) -> bool:
        return data.get(self.field) in self.in_values

    def as_json(self) -> dict[str, Any]:
        return {"field": self.field, "in": list(self.in_values)}


@dataclass(frozen=True, slots=True)
class ConditionalDefault:
    """Дефолт, зависящий от суммы в другом decimal-поле той же формы (заём:
    «беспроцентный» дефолт при сумме ≤ 100 тыс — док 30 §6, п.4 ст. 809).
    Декларативно, а не Python-функцией — чтобы то же правило отдавалось
    фронтенду через GET .../form-schema, не только считалось на сервере."""

    depends_on: str
    threshold: Decimal
    le_value: Json
    gt_value: Json

    def resolve(self, data: dict[str, Any]) -> Json:
        try:
            value = Decimal(str(data.get(self.depends_on, "0")))
        except (InvalidOperation, ValueError, TypeError):
            value = Decimal("0")
        return self.le_value if value <= self.threshold else self.gt_value

    def as_json(self) -> dict[str, Any]:
        return {
            "depends_on": self.depends_on,
            "threshold": str(self.threshold),
            "if_lte": self.le_value,
            "if_gt": self.gt_value,
        }


@dataclass(frozen=True, slots=True)
class FormField:
    key: str
    # "string" | "text" | "choice" | "decimal" | "integer" | "boolean" |
    # "date" | "list_str" | "list"
    field_type: str
    required: bool = False
    default: Json | ConditionalDefault | None = None
    choices: tuple[str, ...] | None = None
    # Живой источник choices (справочник в БД, напр. apps.catalog.Sphere):
    # схема собирается на импорте модуля, а коды справочника меняются
    # данными, не релизом — поэтому вызов откладывается до валидации/
    # сериализации. Задан → приоритетнее статичного `choices`.
    choices_resolver: Callable[[], tuple[str, ...]] | None = None
    min_value: Decimal | int | None = None
    max_value: Decimal | int | None = None
    exclusive_min: bool = True
    condition: Condition | None = None
    hint_i18n_key: str = ""
    # Метаданные mapping «поле → блок K/V» дока 30 (для будущей генерации
    # юртекста, отдельный трек — здесь только хранение, см. модульный докстринг).
    kv_block: str = ""

    def effective_choices(self) -> tuple[str, ...]:
        if self.choices_resolver is not None:
            return self.choices_resolver()
        return self.choices or ()

    def is_visible(self, data: dict[str, Any]) -> bool:
        return self.condition is None or self.condition.holds(data)

    def resolve_default(self, data: dict[str, Any]) -> Json:
        if isinstance(self.default, ConditionalDefault):
            return self.default.resolve(data)
        return self.default


@dataclass(frozen=True, slots=True)
class FormSection:
    key: str
    title_i18n_key: str
    fields: tuple[FormField, ...] = ()
    # Непусто — секция-маркер без полей формы: содержимое живёт в отдельной
    # сущности вне form_data (Milestone/ContractMaterial, Э4.3+). Значение —
    # условное имя той сущности, для фронтенда.
    external_entity: str = ""


ExtraValidator = Callable[[dict[str, Any], str], tuple[list[dict[str, str]], list[dict[str, str]]]]


@dataclass(frozen=True, slots=True)
class FormSchema:
    code: str
    version: int
    sections: tuple[FormSection, ...]
    # (cleaned_data, deal_type) -> (доп. жёсткие ошибки, доп. предупреждения)
    # — кросс-полевые правила, которые не выражаются одним Condition
    # (график займа, B2C-блокировки и т.п.).
    extra_validate: ExtraValidator | None = None

    def fields(self) -> Iterator[FormField]:
        for section in self.sections:
            yield from section.fields


# --- Коэрсия значений полей -------------------------------------------------


def _coerce(f: FormField, value: Any) -> tuple[Any, list[dict[str, str]]]:  # noqa: ANN401
    t = f.field_type

    if t in ("string", "text"):
        if not isinstance(value, str):
            return None, [_err(f.key, "invalid_type", f"{f.key!r}: ожидалась строка")]
        if not value.strip():
            return None, [_err(f.key, "required", f"поле {f.key!r} не может быть пустым")]
        return value, []

    if t == "choice":
        if not isinstance(value, str) or value not in f.effective_choices():
            return None, [
                _err(f.key, "invalid_choice", f"{f.key!r}: недопустимое значение {value!r}")
            ]
        return value, []

    if t == "decimal":
        try:
            dec = Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError):
            return None, [_err(f.key, "invalid_decimal", f"{f.key!r}: ожидалось число")]
        if f.min_value is not None:
            min_v = f.min_value if isinstance(f.min_value, Decimal) else Decimal(f.min_value)
            ok = dec > min_v if f.exclusive_min else dec >= min_v
            if not ok:
                op = ">" if f.exclusive_min else ">="
                return None, [_err(f.key, "out_of_range", f"{f.key!r}: должно быть {op} {min_v}")]
        if f.max_value is not None:
            max_v = f.max_value if isinstance(f.max_value, Decimal) else Decimal(f.max_value)
            if dec > max_v:
                return None, [_err(f.key, "out_of_range", f"{f.key!r}: должно быть <= {max_v}")]
        return str(dec), []

    if t == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return None, [_err(f.key, "invalid_type", f"{f.key!r}: ожидалось целое число")]
        if f.min_value is not None:
            ok = value > f.min_value if f.exclusive_min else value >= f.min_value
            if not ok:
                op = ">" if f.exclusive_min else ">="
                return None, [
                    _err(f.key, "out_of_range", f"{f.key!r}: должно быть {op} {f.min_value}")
                ]
        if f.max_value is not None and value > f.max_value:
            return None, [_err(f.key, "out_of_range", f"{f.key!r}: должно быть <= {f.max_value}")]
        return value, []

    if t == "boolean":
        if not isinstance(value, bool):
            return None, [_err(f.key, "invalid_type", f"{f.key!r}: ожидалось true/false")]
        return value, []

    if t == "date":
        if not isinstance(value, str):
            return None, [_err(f.key, "invalid_date", f"{f.key!r}: ожидалась дата ISO 8601")]
        try:
            date.fromisoformat(value)
        except ValueError:
            return None, [_err(f.key, "invalid_date", f"{f.key!r}: ожидалась дата ISO 8601")]
        return value, []

    if t == "list_str":
        if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
            return None, [_err(f.key, "invalid_type", f"{f.key!r}: ожидался список непустых строк")]
        if f.required and not value:
            return None, [_err(f.key, "required", f"поле {f.key!r} требует хотя бы одно значение")]
        return value, []

    if t == "list":
        if not isinstance(value, list):
            return None, [_err(f.key, "invalid_type", f"{f.key!r}: ожидался список")]
        if f.required and not value:
            return None, [_err(f.key, "required", f"поле {f.key!r} требует хотя бы один элемент")]
        return value, []

    raise AssertionError(
        f"неизвестный field_type {t!r}"
    )  # pragma: no cover — программная ошибка схемы


# --- Движок валидации --------------------------------------------------------


def validate_form_data(
    code: str, raw_data: dict[str, Any] | None, *, deal_type: str
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Возвращает `(cleaned_form_data, warnings)`; бросает FormValidationError
    со списком ошибок при жёстком нарушении. `cleaned_form_data` — данные с
    подставленными дефолтами и коэрсированными типами (суммы — строкой,
    CLAUDE.md), плюс `schema_version` (докстринг модуля: версионирование
    П-16 §2). Пустой `raw_data` — валиден без проверки схемы (см. докстринг
    модуля «Совместимость»)."""
    if not raw_data:
        return {}, []

    schema = get_form_schema(code)
    known_keys = {f.key for f in schema.fields()}
    errors: list[dict[str, str]] = []

    for key in raw_data:
        # `schema_version` пишет сам validate_form_data при сохранении — при
        # ре-валидации сохранённого form_data (compute_form_warnings) он не
        # «неизвестное поле». До правки любой сохранённый договор падал здесь
        # в FormValidationError, и ВСЕ схемные предупреждения (напр. «цена по
        # смете») молча глотались — оставались только кросс-типовые (отсмотр
        # 2026-08-19).
        if key == "schema_version":
            continue
        if key not in known_keys:
            errors.append(_err(key, "unknown_field", f"неизвестное поле {key!r} для типа {code!r}"))

    working: dict[str, Any] = dict(raw_data)
    cleaned: dict[str, Any] = {}

    for f in schema.fields():
        visible = f.is_visible(working)
        present = working.get(f.key) is not None
        if not present:
            if f.required and visible:
                errors.append(_err(f.key, "required", f"поле {f.key!r} обязательно"))
                continue
            # Дефолт — только ВИДИМОМУ полю: иначе выбор одной ветки
            # переключателя молча дописывал бы дефолт другой (rent_home:
            # краткосрочная аренда получала бы term_months=11 рядом с
            # term_days). До появления условных полей с дефолтами (2026-08-24)
            # различие не проявлялось — ни одно поле не сочетало default и
            # condition.
            if visible:
                default = f.resolve_default(working)
                if default is not None:
                    working[f.key] = default
                    cleaned[f.key] = default
            continue
        value, value_errors = _coerce(f, working[f.key])
        if value_errors:
            errors.extend(value_errors)
            continue
        working[f.key] = value
        cleaned[f.key] = value

    warnings: list[dict[str, str]] = []
    if schema.extra_validate is not None:
        extra_errors, extra_warnings = schema.extra_validate(cleaned, deal_type)
        errors.extend(extra_errors)
        warnings.extend(extra_warnings)

    if errors:
        raise FormValidationError(errors)

    cleaned["schema_version"] = schema.version
    return cleaned, warnings


def serialize_schema(schema: FormSchema) -> dict[str, Any]:
    """GET /contract-types/{code}/form-schema (etap-4-delta-p16.md п.4):
    секции по порядку заполнения, поля с дефолтами/условиями/подсказками."""
    return {
        "code": schema.code,
        "schema_version": schema.version,
        "sections": [_serialize_section(s) for s in schema.sections],
    }


def _serialize_section(section: FormSection) -> dict[str, Any]:
    return {
        "key": section.key,
        "title_i18n_key": section.title_i18n_key,
        "external_entity": section.external_entity or None,
        "fields": [_serialize_field(f) for f in section.fields],
    }


def _serialize_field(f: FormField) -> dict[str, Any]:
    default = f.default.as_json() if isinstance(f.default, ConditionalDefault) else f.default
    return {
        "key": f.key,
        "type": f.field_type,
        "required": f.required,
        "default": default,
        "choices": list(f.effective_choices()) or None,
        "min_value": str(f.min_value) if f.min_value is not None else None,
        "max_value": str(f.max_value) if f.max_value is not None else None,
        "condition": f.condition.as_json() if f.condition else None,
        "hint_i18n_key": f.hint_i18n_key or None,
        "kv_block": f.kv_block or None,
    }


# --- Справочники -------------------------------------------------------------
# Сферы: источник истины — apps.catalog.Sphere (таблица, НЕ enum: код сферы
# меняется данными, не релизом — докстринг модели). Валидация sphere_code идёт
# через `_active_sphere_codes` (choices_resolver): захардкоженный список из 7
# сфер ниже — ФОЛБЭК для пустого справочника (ранние тесты/миграции) и
# документация исходного набора. На проде каталог расширен полным деревом
# (l10n-импорт, catalog-v2) — статичный список резал сохранение form_data
# любой «новой» сферы 422-й invalid_choice (отсмотр 2026-08-19, мастер «Суть»).
#
# Категории продаж/аренды — по-прежнему плейсхолдеры (док 24 §2.2): своих
# таблиц ещё нет, останутся статикой до их появления.
#
# "education", не "tutoring" (chore/sphere-dedup, apps.catalog.migrations.
# 0014_dedupe_tutoring_into_education) — синхронизировано с
# apps.catalog.models.Sphere/docs/content/checklists/CL-education_GLOBAL.md/
# l10n/packs/*.json (catalog.spheres.education); уже сохранённые
# Contract.form_data["sphere_code"]=="tutoring" переносит миграция 0007.


def _active_sphere_codes() -> tuple[str, ...]:
    """Живые коды сфер из каталога (catalog — нижний слой, зависеть можно).
    Импорт внутри функции: схема собирается на импорте модуля, когда app
    registry может быть ещё не готов; сам запрос — только в момент
    валидации/сериализации."""
    from apps.catalog import selectors as catalog_selectors

    try:
        codes = tuple(catalog_selectors.list_active_spheres().values_list("code", flat=True))
    except Exception:
        # БД недоступна (юнит-тесты движка «без БД», ранний bootstrap) —
        # деградация до статичного фолбэка, а не 500 на сериализации схемы.
        return SPHERE_CODES
    return codes or SPHERE_CODES


SPHERE_CODES: tuple[str, ...] = (
    "renovation",
    "delivery",
    "education",
    "it",
    "household",
    "design",
    "other",
)

SALE_CATEGORY_CODES: tuple[str, ...] = (
    "electronics",
    "clothing_footwear",
    "furniture_interior",
    "appliances",
    "hobby_sport",
    "books_media",
    "kids",
    "beauty_health",
    "garden_tools",
    "food",
    "pets",
    "auto_parts",
    "building_materials",
    "household",
    "jewelry_watches",
    "handmade_collectibles",
    "business_equipment",
    "other",
)

# Ключевая ставка ЦБ РФ — в репозитории нет живого источника (нет ADR/
# конфигурации); плейсхолдер для порога «ростовщических процентов»
# (п. 5 ст. 809 ГК — свыше 2х ключевой). Заменить на реальный источник —
# отдельная задача (apps.jurisdictions?), вне этой дельты.
_LOAN_KEY_RATE_PERCENT = Decimal("16")
_LOAN_USURIOUS_THRESHOLD_PERCENT = _LOAN_KEY_RATE_PERCENT * 2


# --- 🔧 УСЛУГА (services_individual / services_business) --------------------


def _service_extra_validate(
    data: dict[str, Any], deal_type: str
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if data.get("term_type") == "dates":
        start, end = data.get("start_date"), data.get("end_date")
        if start and end and end < start:
            errors.append(_err("end_date", "invalid_range", "срок окончания раньше начала"))
    if data.get("price_type") == "estimate":
        warnings.append(_warn("price_type", "contract_forms.service.warning.estimate_price"))
    return errors, warnings


_SERVICE_SECTIONS = (
    FormSection(
        "sphere",
        "contract_forms.service.section.sphere",
        fields=(
            FormField(
                "sphere_code",
                "choice",
                required=True,
                choices=SPHERE_CODES,
                choices_resolver=_active_sphere_codes,
                hint_i18n_key="contract_forms.service.sphere_code.hint",
                kv_block="K2",
            ),
        ),
    ),
    FormSection(
        "description",
        "contract_forms.service.section.description",
        fields=(FormField("work_description", "text", required=True, kv_block="K2"),),
    ),
    FormSection(
        "location",
        "contract_forms.service.section.location",
        fields=(
            FormField(
                "location_type",
                "choice",
                required=True,
                choices=("onsite", "remote"),
                kv_block="K2",
            ),
            FormField(
                "location_address",
                "string",
                required=True,
                condition=Condition("location_type", ("onsite",)),
                kv_block="K2",
            ),
        ),
    ),
    FormSection(
        "term",
        "contract_forms.service.section.term",
        fields=(
            FormField(
                "term_type",
                "choice",
                required=True,
                choices=("dates", "relative_to_gate"),
                kv_block="K4",
            ),
            FormField(
                "start_date",
                "date",
                required=True,
                condition=Condition("term_type", ("dates",)),
                kv_block="K4",
            ),
            FormField(
                "end_date",
                "date",
                required=True,
                condition=Condition("term_type", ("dates",)),
                kv_block="K4",
            ),
            FormField(
                "duration_days",
                "integer",
                required=True,
                min_value=0,
                exclusive_min=False,
                condition=Condition("term_type", ("relative_to_gate",)),
                kv_block="K4",
            ),
        ),
    ),
    # Маркеры-секции: дерево этапов/материалы/раскладка оплат — сущности
    # Milestone/ContractMaterial (Э4.3), в form_data их нет (границы
    # дельты, модульный докстринг).
    FormSection(
        "milestones", "contract_forms.service.section.milestones", external_entity="milestone"
    ),
    FormSection(
        "materials", "contract_forms.service.section.materials", external_entity="contract_material"
    ),
    FormSection(
        "price",
        "contract_forms.service.section.price",
        fields=(
            FormField(
                "price_type", "choice", required=True, choices=("fixed", "estimate"), kv_block="K3"
            ),
        ),
    ),
    FormSection(
        "payment_split",
        "contract_forms.service.section.payment_split",
        external_entity="milestone_payment_split",
    ),
    FormSection(
        "warranty",
        "contract_forms.service.section.warranty",
        fields=(
            FormField(
                "warranty_period_days",
                "integer",
                default=14,
                min_value=0,
                exclusive_min=False,
                kv_block="K8",
            ),
        ),
    ),
    FormSection(
        "acceptance",
        "contract_forms.service.section.acceptance",
        fields=(
            FormField(
                "acceptance_window_hours",
                "integer",
                default=72,
                min_value=1,
                exclusive_min=False,
                kv_block="K7",
            ),
        ),
    ),
    FormSection(
        "modules",
        "contract_forms.service.section.modules",
        fields=(
            FormField("access_required", "boolean", default=False, kv_block="V-ACCESS"),
            FormField(
                "subcontract_policy",
                "choice",
                choices=("forbidden", "allowed", "with_consent"),
                default="forbidden",
                kv_block="V-SUB",
            ),
            FormField("portfolio_visible", "boolean", default=True, kv_block="V-PORT"),
        ),
    ),
)

SERVICE_SCHEMA = FormSchema(
    code="services", version=1, sections=_SERVICE_SECTIONS, extra_validate=_service_extra_validate
)


# --- 📦 ПРОДАЖА (sale_personal / sale_business) ------------------------------


_SALE_DELIVERY_ADDRESS_REQUIRED = ("pvz", "courier", "transport_company")
_SALE_DELIVERY_PAYER_REQUIRED = ("pvz", "courier", "transport_company")


def _sale_extra_validate(
    data: dict[str, Any], deal_type: str
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if data.get("condition") == "used" and not data.get("photos"):
        warnings.append(_warn("photos", "contract_forms.sale.warning.used_photos_recommended"))
    return errors, warnings


def _sale_sections(*, include_household_plot: bool) -> tuple[FormSection, ...]:
    sections: list[FormSection] = [
        FormSection(
            "category",
            "contract_forms.sale.section.category",
            fields=(
                FormField(
                    "category_code",
                    "choice",
                    required=True,
                    choices=SALE_CATEGORY_CODES,
                    kv_block="V-GOODS",
                ),
            ),
        ),
        FormSection(
            "item",
            "contract_forms.sale.section.item",
            fields=(
                FormField("item_name", "string", required=True, kv_block="V-GOODS"),
                FormField("item_description", "text", required=True, kv_block="V-GOODS"),
                FormField(
                    "condition",
                    "choice",
                    required=True,
                    choices=("new", "used"),
                    kv_block="V-GOODS",
                ),
                FormField(
                    "condition_defects_description",
                    "text",
                    required=True,
                    condition=Condition("condition", ("used",)),
                    kv_block="V-GOODS",
                ),
                FormField("completeness", "text", kv_block="V-GOODS"),
                FormField(
                    "identifiers",
                    "string",
                    required=True,
                    condition=Condition("category_code", ("electronics",)),
                    hint_i18n_key="contract_forms.sale.identifiers.hint",
                    kv_block="V-GOODS",
                ),
                FormField("photos", "list_str", kv_block="V-GOODS"),
            ),
        ),
    ]
    if include_household_plot:
        sections.append(
            FormSection(
                "household_plot",
                "contract_forms.sale.section.household_plot",
                fields=(
                    FormField(
                        "own_household_plot",
                        "boolean",
                        default=False,
                        hint_i18n_key="contract_forms.sale.household_plot.hint",
                        kv_block="tax_note",
                    ),
                ),
            )
        )
    sections += [
        FormSection(
            "price",
            "contract_forms.sale.section.price",
            fields=(
                FormField("price", "decimal", required=True, min_value=Decimal("0"), kv_block="K3"),
            ),
        ),
        FormSection(
            "delivery",
            "contract_forms.sale.section.delivery",
            fields=(
                FormField(
                    "delivery_type",
                    "choice",
                    required=True,
                    choices=("pickup", "handoff", "pvz", "courier", "transport_company"),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "delivery_address",
                    "string",
                    required=True,
                    condition=Condition("delivery_type", _SALE_DELIVERY_ADDRESS_REQUIRED),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "delivery_payer",
                    "choice",
                    required=True,
                    choices=("seller", "buyer", "split"),
                    condition=Condition("delivery_type", _SALE_DELIVERY_PAYER_REQUIRED),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "delivery_deadline_type",
                    "choice",
                    required=True,
                    choices=("date", "relative_to_payment"),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "delivery_date",
                    "date",
                    required=True,
                    condition=Condition("delivery_deadline_type", ("date",)),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "delivery_days",
                    "integer",
                    required=True,
                    min_value=0,
                    exclusive_min=False,
                    condition=Condition("delivery_deadline_type", ("relative_to_payment",)),
                    kv_block="V-HANDOVER",
                ),
                FormField(
                    "tracking_number",
                    "string",
                    condition=Condition("delivery_type", ("transport_company",)),
                    kv_block="V-HANDOVER",
                ),
            ),
        ),
        FormSection(
            "inspection",
            "contract_forms.sale.section.inspection",
            fields=(
                FormField(
                    "inspection_window_hours",
                    "integer",
                    default=24,
                    min_value=1,
                    exclusive_min=False,
                    kv_block="V-HANDOVER",
                ),
            ),
        ),
    ]
    return tuple(sections)


SALE_PERSONAL_SCHEMA = FormSchema(
    code="sale_personal",
    version=1,
    sections=_sale_sections(include_household_plot=True),
    extra_validate=_sale_extra_validate,
)
SALE_BUSINESS_SCHEMA = FormSchema(
    code="sale_business",
    version=1,
    sections=_sale_sections(include_household_plot=False),
    extra_validate=_sale_extra_validate,
)


# --- 🏠 АРЕНДА → Вещи (rent_items) -------------------------------------------


def _rent_b2c_deposit_block(data: dict[str, Any], deal_type: str) -> list[dict[str, str]]:
    """B2C — законные права потребителя не урезаются: невозвратный депозит
    запрещён конструктором (etap-4-delta-p16.md п.5; жёсткая валидация, не
    предупреждение)."""
    if deal_type == Contract.DealType.B2C and data.get("deposit_non_refundable"):
        return [
            _err(
                "deposit_non_refundable",
                "b2c_forbidden",
                "невозвратный депозит запрещён в B2C-сделках (права потребителя)",
            )
        ]
    return []


def _rent_items_extra_validate(
    data: dict[str, Any], deal_type: str
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    return _rent_b2c_deposit_block(data, deal_type), []


_RENT_ITEMS_SECTIONS = (
    FormSection(
        "item",
        "contract_forms.rent_items.section.item",
        fields=(
            FormField("item_name", "string", required=True, kv_block="V-RENT"),
            FormField(
                "item_identification",
                "text",
                required=True,
                hint_i18n_key="contract_forms.rent_items.identification.hint",
                kv_block="V-RENT",
            ),
            FormField("item_description", "text", kv_block="V-RENT"),
        ),
    ),
    FormSection(
        "value",
        "contract_forms.rent_items.section.value",
        fields=(
            FormField(
                "declared_value", "decimal", required=True, min_value=Decimal("0"), kv_block="V-INV"
            ),
        ),
    ),
    FormSection(
        "term",
        "contract_forms.rent_items.section.term",
        fields=(
            FormField(
                "term_type", "choice", required=True, choices=("date_range", "daily"), kv_block="K4"
            ),
            FormField("start_date", "date", required=True, kv_block="K4"),
            FormField(
                "end_date",
                "date",
                required=True,
                condition=Condition("term_type", ("date_range",)),
                kv_block="K4",
            ),
        ),
    ),
    FormSection(
        "payment",
        "contract_forms.rent_items.section.payment",
        fields=(
            FormField(
                "rent_amount", "decimal", required=True, min_value=Decimal("0"), kv_block="K3"
            ),
            FormField(
                "rent_period",
                "choice",
                required=True,
                choices=("day", "week", "month"),
                kv_block="K3",
            ),
        ),
    ),
    FormSection(
        "deposit",
        "contract_forms.rent_items.section.deposit",
        fields=(
            FormField(
                "deposit_amount",
                "decimal",
                min_value=Decimal("0"),
                exclusive_min=False,
                kv_block="V-RENT",
            ),
            FormField("deposit_terms", "text", kv_block="V-RENT"),
            FormField("deposit_non_refundable", "boolean", default=False, kv_block="V-RENT"),
        ),
    ),
    FormSection(
        "risk",
        "contract_forms.rent_items.section.risk",
        fields=(FormField("risk_transfer_enabled", "boolean", default=True, kv_block="V-RENT"),),
    ),
    FormSection(
        "usage",
        "contract_forms.rent_items.section.usage",
        fields=(FormField("usage_restrictions", "text", kv_block="V-RENT"),),
    ),
    FormSection(
        "handover",
        "contract_forms.rent_items.section.handover",
        fields=(
            FormField("handover_place", "string", required=True, kv_block="акт передачи"),
            FormField("handover_method", "text", kv_block="акт передачи"),
            FormField("return_place", "string", required=True, kv_block="акт возврата"),
            FormField("return_method", "text", kv_block="акт возврата"),
        ),
    ),
)

RENT_ITEMS_SCHEMA = FormSchema(
    code="rent_items",
    version=1,
    sections=_RENT_ITEMS_SECTIONS,
    extra_validate=_rent_items_extra_validate,
)


# --- 🏠 АРЕНДА → Жильё (rent_home) -------------------------------------------


def _rent_home_extra_validate(
    data: dict[str, Any], deal_type: str
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors = _rent_b2c_deposit_block(data, deal_type)
    warnings: list[dict[str, str]] = []
    term_months = data.get("term_months")
    if isinstance(term_months, int) and term_months >= 12:
        warnings.append(_warn("term_months", "contract_forms.rent_home.warning.registration_st674"))
    if not data.get("inventory_list"):
        warnings.append(
            _warn("inventory_list", "contract_forms.rent_home.warning.inventory_recommended")
        )
    if not data.get("meter_readings"):
        warnings.append(
            _warn("meter_readings", "contract_forms.rent_home.warning.meters_recommended")
        )
    return errors, warnings


_RENT_HOME_SECTIONS = (
    FormSection(
        "object",
        "contract_forms.rent_home.section.object",
        fields=(
            FormField("address", "string", required=True, kv_block="V-RENT"),
            FormField(
                "object_type",
                "choice",
                required=True,
                choices=("apartment", "room", "house"),
                kv_block="V-RENT",
            ),
            FormField("floor", "integer", min_value=0, exclusive_min=False, kv_block="V-RENT"),
            FormField(
                "area_sqm",
                "decimal",
                min_value=Decimal("0"),
                exclusive_min=False,
                kv_block="V-RENT",
            ),
            FormField("cadastral_number", "string", kv_block="V-RENT"),
        ),
    ),
    FormSection(
        "disposal_basis",
        "contract_forms.rent_home.section.disposal_basis",
        fields=(
            FormField(
                "disposal_basis_type",
                "choice",
                required=True,
                choices=("owner", "attorney", "sublease_with_consent"),
                kv_block="K1",
            ),
            FormField(
                "disposal_basis_document",
                "text",
                required=True,
                hint_i18n_key="contract_forms.rent_home.disposal_basis_document.hint",
                kv_block="K1",
            ),
        ),
    ),
    FormSection(
        "term",
        "contract_forms.rent_home.section.term",
        # Отсмотр 2026-08-24: «Краткосрочная — вводят кол-во в днях,
        # Долгосрочная — поле в месяцах, и можно не вписывать, как сейчас».
        # Дефолт long_term сохраняет валидность всех сохранённых form_data
        # (в них term_kind нет) и прежнее поведение term_months (default 11).
        fields=(
            FormField(
                "term_kind",
                "choice",
                default="long_term",
                choices=("short_term", "long_term"),
                kv_block="K4",
            ),
            FormField(
                "term_days",
                "integer",
                required=True,
                min_value=1,
                exclusive_min=False,
                condition=Condition("term_kind", ("short_term",)),
                kv_block="K4",
            ),
            FormField(
                "term_months",
                "integer",
                default=11,
                min_value=1,
                condition=Condition("term_kind", ("long_term",)),
                kv_block="K4",
            ),
        ),
    ),
    FormSection(
        "payment",
        "contract_forms.rent_home.section.payment",
        fields=(
            FormField(
                "rent_amount", "decimal", required=True, min_value=Decimal("0"), kv_block="K3"
            ),
            FormField(
                "rent_payment_day",
                "integer",
                required=True,
                min_value=1,
                max_value=31,
                exclusive_min=False,
                kv_block="K3",
            ),
        ),
    ),
    FormSection(
        "utilities",
        "contract_forms.rent_home.section.utilities",
        fields=(
            FormField(
                "utilities_mode",
                "choice",
                required=True,
                choices=("included", "by_meter", "fixed"),
                kv_block="V-RENT",
            ),
            FormField(
                "utilities_fixed_amount",
                "decimal",
                required=True,
                min_value=Decimal("0"),
                exclusive_min=False,
                condition=Condition("utilities_mode", ("fixed",)),
                kv_block="V-RENT",
            ),
        ),
    ),
    FormSection(
        "deposit",
        "contract_forms.rent_home.section.deposit",
        fields=(
            FormField(
                "deposit_amount",
                "decimal",
                min_value=Decimal("0"),
                exclusive_min=False,
                kv_block="V-RENT",
            ),
            FormField("deposit_terms", "text", kv_block="V-RENT"),
            FormField("deposit_non_refundable", "boolean", default=False, kv_block="V-RENT"),
        ),
    ),
    FormSection(
        "occupants",
        "contract_forms.rent_home.section.occupants",
        fields=(
            FormField("occupants", "list_str", required=True, kv_block="V-RENT"),
            FormField("pets_allowed", "boolean", default=False, kv_block="V-RENT"),
            FormField("smoking_allowed", "boolean", default=False, kv_block="V-RENT"),
        ),
    ),
    FormSection(
        "inventory",
        "contract_forms.rent_home.section.inventory",
        fields=(FormField("inventory_list", "list", kv_block="акт заселения"),),
    ),
    FormSection(
        "meters",
        "contract_forms.rent_home.section.meters",
        fields=(FormField("meter_readings", "list", kv_block="акт заселения"),),
    ),
)

RENT_HOME_SCHEMA = FormSchema(
    code="rent_home",
    version=2,
    sections=_RENT_HOME_SECTIONS,
    extra_validate=_rent_home_extra_validate,
)


# --- 💰 ЗАЙМ (loan_individuals) ----------------------------------------------


def _loan_extra_validate(
    data: dict[str, Any], deal_type: str
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    if data.get("repayment_type") == "schedule":
        schedule = data.get("schedule")
        # Отсутствие/неверный тип schedule уже поймал общий движок (required/
        # invalid_type на самом поле) — здесь дублировать нечего, довалидируем
        # только реально пришедший список.
        if isinstance(schedule, list) and schedule:
            if len(schedule) > 60:
                errors.append(
                    _err(
                        "schedule",
                        "too_many_payments",
                        "график не может превышать 60 платежей (решение 01.08)",
                    )
                )
            total = Decimal("0")
            items_valid = True
            for i, item in enumerate(schedule):
                if not isinstance(item, dict) or "due_date" not in item or "amount" not in item:
                    errors.append(
                        _err(
                            f"schedule[{i}]",
                            "invalid_item",
                            "элемент графика должен содержать due_date и amount",
                        )
                    )
                    items_valid = False
                    continue
                try:
                    date.fromisoformat(str(item["due_date"]))
                    total += Decimal(str(item["amount"]))
                except (InvalidOperation, ValueError, TypeError):
                    errors.append(
                        _err(
                            f"schedule[{i}]", "invalid_item", "некорректная дата или сумма платежа"
                        )
                    )
                    items_valid = False
            if items_valid:
                try:
                    expected = Decimal(str(data.get("amount", "0"))) + Decimal(
                        str(data.get("total_interest_amount", "0"))
                    )
                except (InvalidOperation, ValueError, TypeError):
                    expected = None
                if expected is not None and total != expected:
                    errors.append(
                        _err(
                            "schedule",
                            "sum_mismatch",
                            f"сумма графика {total} должна равняться сумме займа "
                            f"с процентами {expected}",
                        )
                    )

    if data.get("interest_type") == "rate":
        try:
            rate = Decimal(str(data.get("interest_rate_percent", "0")))
        except (InvalidOperation, ValueError, TypeError):
            rate = Decimal("0")
        if rate > _LOAN_USURIOUS_THRESHOLD_PERCENT:
            warnings.append(
                _warn("interest_rate_percent", "contract_forms.loan.warning.usurious_rate")
            )

    if data.get("transfer_method") == "off_platform":
        warnings.append(
            _warn("transfer_method", "contract_forms.loan.warning.off_platform_transfer")
        )

    try:
        amount_dec = Decimal(str(data.get("amount", "0")))
    except (InvalidOperation, ValueError, TypeError):
        amount_dec = Decimal("0")
    if amount_dec >= Decimal("10000"):
        warnings.append(_warn("amount", "contract_forms.loan.warning.written_form_required"))

    return errors, warnings


_LOAN_SECTIONS = (
    FormSection(
        "amount",
        "contract_forms.loan.section.amount",
        fields=(
            FormField(
                "amount", "decimal", required=True, min_value=Decimal("0"), kv_block="V-LOAN"
            ),
        ),
    ),
    FormSection(
        "interest",
        "contract_forms.loan.section.interest",
        fields=(
            FormField(
                "interest_type",
                "choice",
                choices=("interest_free", "rate"),
                default=ConditionalDefault(
                    depends_on="amount",
                    threshold=Decimal("100000"),
                    le_value="interest_free",
                    gt_value="rate",
                ),
                kv_block="V-LOAN",
            ),
            FormField(
                "interest_rate_percent",
                "decimal",
                required=True,
                min_value=Decimal("0"),
                condition=Condition("interest_type", ("rate",)),
                kv_block="V-LOAN",
            ),
        ),
    ),
    FormSection(
        "term",
        "contract_forms.loan.section.term",
        fields=(
            FormField(
                "repayment_type",
                "choice",
                required=True,
                choices=("lump_sum", "schedule"),
                kv_block="K4",
            ),
            FormField(
                "due_date",
                "date",
                required=True,
                condition=Condition("repayment_type", ("lump_sum",)),
                kv_block="K4",
            ),
            FormField(
                "total_interest_amount",
                "decimal",
                required=True,
                default="0",
                min_value=Decimal("0"),
                exclusive_min=False,
                condition=Condition("interest_type", ("rate",)),
                kv_block="K4",
            ),
            FormField(
                "schedule",
                "list",
                required=True,
                condition=Condition("repayment_type", ("schedule",)),
                kv_block="K4",
            ),
        ),
    ),
    FormSection(
        "transfer",
        "contract_forms.loan.section.transfer",
        fields=(
            FormField(
                "transfer_method",
                "choice",
                required=True,
                choices=("platform", "off_platform"),
                kv_block="K3",
            ),
            FormField(
                "transfer_confirmation_note",
                "text",
                required=True,
                condition=Condition("transfer_method", ("off_platform",)),
                kv_block="K3",
            ),
        ),
    ),
    FormSection(
        "options",
        "contract_forms.loan.section.options",
        fields=(
            FormField("early_repayment_allowed", "boolean", default=True, kv_block="V-LOAN"),
            FormField("purpose", "text", kv_block="V-LOAN"),
        ),
    ),
)

LOAN_SCHEMA = FormSchema(
    code="loan_individuals", version=1, sections=_LOAN_SECTIONS, extra_validate=_loan_extra_validate
)


# --- Реестр -------------------------------------------------------------------

_REGISTRY: dict[str, FormSchema] = {
    "services_individual": SERVICE_SCHEMA,
    "services_business": SERVICE_SCHEMA,
    "sale_personal": SALE_PERSONAL_SCHEMA,
    "sale_business": SALE_BUSINESS_SCHEMA,
    "rent_items": RENT_ITEMS_SCHEMA,
    "rent_home": RENT_HOME_SCHEMA,
    "loan_individuals": LOAN_SCHEMA,
}


def get_form_schema(code: str) -> FormSchema:
    try:
        return _REGISTRY[code]
    except KeyError:
        raise FormSchemaNotFoundError(code) from None


# --- Кросс-типовые предупреждения (etap-4-delta-p16.md п.5) ------------------

_SYSTEMATICITY_RELEVANT_CODES = frozenset(
    {
        "services_individual",
        "services_business",
        "sale_personal",
        "sale_business",
        "loan_individuals",
    }
)


def _systematicity_warning_stub(contract: Contract) -> list[dict[str, str]]:
    """Счётчик систематичности требует механики ADR-034 (N договоров того же
    типа/стороны за период), которой в main ещё нет — заглушка за
    фиче-флагом settings.CONTRACT_FORMS_SYSTEMATICITY_WARNING_ENABLED
    (default off, etap-4-delta-p16.md п.5). Даже при включённом флаге пока
    не считает ничего реального — подсчёт добавится вместе с ADR-034."""
    if contract.contract_type_id not in _SYSTEMATICITY_RELEVANT_CODES:
        return []
    if not settings.CONTRACT_FORMS_SYSTEMATICITY_WARNING_ENABLED:
        return []
    return []


def _milestone_checklist_warning_stub(contract: Contract) -> list[dict[str, str]]:
    """«Этап без чек-листа» (etap-4-delta-p16.md п.5) нечем проверить: дерево
    этапов — сущность Milestone, которая появится в Э4.3 (границы дельты,
    модульный докстринг). Заглушка до тех пор."""
    return []


def _cross_type_warnings(contract: Contract) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    if contract.payment_method in (Contract.PaymentMethod.CASH, Contract.PaymentMethod.EXTERNAL):
        warnings.append(_warn("payment_method", "contract_forms.cross.warning.no_evidence_base"))

    parties = {p.role: p for p in contract.parties.all()}
    customer = parties.get(ContractParty.Role.CUSTOMER)
    contractor = parties.get(ContractParty.Role.CONTRACTOR)
    if (
        customer is not None
        and contractor is not None
        and customer.acting_as == ContractParty.ActingAs.BUSINESS
        and contractor.acting_as == ContractParty.ActingAs.PERSON
    ):
        warnings.append(_warn("counterparty", "contract_forms.cross.warning.tax_agent_notice"))

    warnings.extend(_systematicity_warning_stub(contract))
    warnings.extend(_milestone_checklist_warning_stub(contract))
    return warnings


def compute_form_warnings(contract: Contract) -> list[dict[str, str]]:
    """Предупреждения для сериализации черновика (не блокируют сохранение —
    etap-4-delta-p16.md п.3): типовые (из схемы, по уже сохранённому
    `form_data`) + кросс-типовые (п.5)."""
    try:
        _cleaned, warnings = validate_form_data(
            contract.contract_type_id, contract.form_data, deal_type=contract.deal_type
        )
    except (FormValidationError, FormSchemaNotFoundError):
        # form_data сохранялся уже провалидированным; расхождение возможно
        # только при смене схемы задним числом — не роняем сериализацию.
        warnings = []
    return [*warnings, *_cross_type_warnings(contract)]


# --- Локализация предупреждений (отсмотр 2026-08-19) --------------------------
# Внутренняя форма предупреждения — {field, i18n_key}; наружу (ContractSerializer)
# уходит контракт фронта {field, code, message}: до этого фронт читал `w.message`
# из ключей и рисовал ПУСТЫЕ буллеты «Замечаний» на карточке. Тексты — на
# сервере (как имена каталога, ГВ.5): ru + en, язык — resolve_request_locale;
# ключ без записи безопасно отдаёт сам i18n_key вместо пустоты.
WARNING_TEXTS: dict[str, dict[str, str]] = {
    "contract_forms.service.warning.estimate_price": {
        "ru": (
            "Цена по смете (оценка) — итоговая сумма может "
            "измениться. Фиксируйте оценку и её изменения этапами."
        ),
        "en": (
            "Estimate-based price — the final amount may "
            "change. Capture the estimate and its changes as milestones."
        ),
    },
    "contract_forms.cross.warning.tax_agent_notice": {
        "ru": (
            "Заказчик-бизнес при расчётах с физлицом может выступать "
            "налоговым агентом — проверьте налоговые обязанности сторон."
        ),
        "en": (
            "A business customer paying an individual may act "
            "as a tax agent — check the parties' tax obligations."
        ),
    },
    # Отсмотр 2026-08-24: оплаты через платформу пока нет — предупреждение
    # обязано не только пугать, но и говорить, что делать (хранить квитанции).
    "contract_forms.cross.warning.no_evidence_base": {
        "ru": (
            "Расчёт вне платформы не оставляет следов оплаты — доказательная "
            "база сделки будет неполной без квитанций оплаты. Сохраняйте их."
        ),
        "en": (
            "Settling outside the platform leaves no payment trail — without "
            "payment receipts the deal's evidence base will be incomplete. Keep them."
        ),
    },
    "contract_forms.loan.warning.written_form_required": {
        "ru": "Для займа такого размера закон требует письменную форму договора.",
        "en": "A loan of this size legally requires a written agreement.",
    },
    "contract_forms.loan.warning.usurious_rate": {
        "ru": "Ставка выглядит ростовщической — суд может снизить её по требованию заёмщика.",
        "en": "The interest rate looks usurious — a court may reduce it at the borrower's request.",
    },
    "contract_forms.loan.warning.off_platform_transfer": {
        "ru": (
            "Передача денег вне платформы не фиксируется — "
            "подтверждение передачи останется только на сторонах."
        ),
        "en": (
            "Money transferred off-platform is not recorded "
            "— proof of transfer stays with the parties alone."
        ),
    },
    "contract_forms.rent_home.warning.inventory_recommended": {
        "ru": "Рекомендуем опись имущества: без неё трудно доказать состояние жилья при выезде.",
        "en": (
            "An inventory list is recommended: without it, "
            "the home's condition at move-out is hard to prove."
        ),
    },
    "contract_forms.rent_home.warning.meters_recommended": {
        "ru": (
            "Зафиксируйте показания счётчиков при передаче "
            "жилья — это снимет споры об оплате коммунальных услуг."
        ),
        "en": "Record meter readings at handover — it prevents disputes over utility bills.",
    },
    "contract_forms.rent_home.warning.registration_st674": {
        "ru": (
            "Договор на срок 12 месяцев и больше требует "
            "государственной регистрации договора (ст. 674 ГК РФ)."
        ),
        "en": (
            "A lease term of 12 months or longer requires state "
            "registration of the agreement (RU Civil Code art. 674)."
        ),
    },
    "contract_forms.sale.warning.used_photos_recommended": {
        "ru": (
            "Для б/у товара рекомендуем фото: они станут "
            "доказательством состояния на момент продажи."
        ),
        "en": (
            "Photos are recommended for used goods: they "
            "become evidence of condition at the time of sale."
        ),
    },
}


def localize_warning(warning: dict[str, str], *, locale: str) -> dict[str, str]:
    """{field, i18n_key} → {field, code, message} (контракт фронта). `code` —
    стабильный идентификатор (сам i18n_key), `message` — текст на языке
    запроса (не-ru без своей записи получают en, как error_texts)."""
    key = warning.get("i18n_key", "")
    texts = WARNING_TEXTS.get(key, {})
    message = texts.get(locale) or texts.get("en" if locale != "ru" else "ru") or key
    return {"field": warning.get("field", ""), "code": key, "message": message}
