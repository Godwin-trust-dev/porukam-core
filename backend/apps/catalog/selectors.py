"""Read-слой apps.catalog."""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from django.db.models import IntegerField, OuterRef, Q, QuerySet, Subquery, Value
from django.db.models.functions import Coalesce

from apps.l10n import selectors as l10n_selectors

from .models import (
    ChecklistTemplateItem,
    ChecklistTemplatePickStat,
    ClauseTemplate,
    ContractTypeCatalogItem,
    MaterialCatalogItem,
    Sphere,
)


def list_client_tree_contract_types(
    *, client_option: str | None = None
) -> QuerySet[ContractTypeCatalogItem]:
    """GET /contract-types[?client_option=] (ADR-094) — типы клиентского
    дерева (docs/catalog-v2.md §1): активные, не скрытые, с заполненным
    `client_option`. `excluded`-сегмент отсечён дополнительно (в сиде такие
    и так `is_hidden=True` — оборонительный пояс: создать excluded нельзя
    (403 в services), значит и предлагать нечего)."""
    qs = ContractTypeCatalogItem.objects.filter(
        is_active=True, is_hidden=False, client_option__isnull=False
    ).exclude(default_segment=ContractTypeCatalogItem.Segment.EXCLUDED)
    if client_option is not None:
        qs = qs.filter(client_option=client_option)
    return qs.order_by("sort_order", "code")


def list_active_spheres() -> QuerySet[Sphere]:
    """GET /spheres (ADR-091) — активные сферы, без фильтра `q` (тот
    накладывается на локализованное имя в api/views.py, не здесь — селектор
    ничего не знает про Accept-Language)."""
    return Sphere.objects.filter(is_active=True).order_by("code")


def is_active_sphere_code(code: str) -> bool:
    """ADR-117 §2: проверка сферы объединения (apps.social) — зовётся через
    settings.GROUP_SPHERE_EXISTS_SELECTOR + import_string, не прямым импортом
    (social по import-linter зависит только от accounts)."""
    return Sphere.objects.filter(code=code, is_active=True).exists()


def list_active_material_catalog(
    *, sphere_code: str | None = None
) -> QuerySet[MaterialCatalogItem]:
    """GET /material-catalog[?sphere=] (ADR-091 §1). `sphere_code=None` —
    единственный текущий вызов фронта (`useMaterialCatalog()`, без параметра,
    ADR-091 §«Не делать») — весь активный каталог."""
    qs = MaterialCatalogItem.objects.filter(is_active=True).select_related("sphere")
    if sphere_code is not None:
        qs = qs.filter(sphere__code=sphere_code)
    return qs.order_by("sphere_id", "code")


def is_active_material_catalog_code(code: str) -> bool:
    """Есть ли такая АКТИВНАЯ позиция каталога материалов (ADR-157) — пара к
    `is_active_sphere_code`. Нужна apps.contracts, чтобы проверить значение
    правки `material.<uuid>.type` на ПРЕДЛОЖЕНИИ: резолв самой позиции
    делает apps.milestones уже на применении (`_resolve_material_catalog_
    item`), но согласовывать несуществующий код нельзя."""
    return MaterialCatalogItem.objects.filter(code=code, is_active=True).exists()


def list_unit_codes() -> list[str]:
    """GET /units (ADR-091 §1) — отдельной модели «единица измерения» нет
    (докстринг ADR-091 «Не делать»); честная производная — непустые
    `suggested_unit` каталога материалов, без выдумывания подсказок/переводов."""
    return list(
        MaterialCatalogItem.objects.filter(is_active=True)
        .exclude(suggested_unit="")
        .order_by("suggested_unit")
        .values_list("suggested_unit", flat=True)
        .distinct()
    )


def _by_sphere(sphere_code: str) -> Q:
    """Союз обоих путей заполнения `ChecklistTemplateItem` (ADR-091 §1):
    `import_checklists` (ADR-081) всегда кладёт `sphere` напрямую; ручной сид
    0006 — только `catalog_item` (без `sphere`) для материал-привязанных
    пунктов. Без union по `catalog_item__sphere` пункты сидовых материалов
    (напр. `renovation_tile`) выпали бы из выборки по сфере."""
    return Q(sphere__code=sphere_code) | Q(catalog_item__sphere__code=sphere_code)


def list_work_type_codes(*, sphere_code: str) -> list[str]:
    """GET /work-types?sphere= (ADR-091 §1) — «вид работ» = DISTINCT
    `ChecklistTemplateItem.category` (ADR-081, реальный импортированный
    контент) в этой сфере, только текущие версии. Пусто на чистой БД без
    `import_checklists` (сид 0006 не заполняет `category`) — честно, не
    ошибка."""
    return list(
        ChecklistTemplateItem.objects.filter(_by_sphere(sphere_code), is_current=True)
        .exclude(category="")
        .order_by("category")
        .values_list("category", flat=True)
        .distinct()
    )


def is_selectable_work_type(*, sphere_code: str, code: str) -> bool:
    """ADR-190 (профиль/поиск, 12.09) — «настоящий», подписанный вид работ:
    у категории есть текущие пункты чек-листа (`list_work_type_codes`) И
    человекочитаемая подпись хотя бы в ru ИЛИ en пакете (канонические
    языки — тот же признак, что `WorkTypeListView` использует, чтобы
    исключить код из выдачи `/work-types`, ADR-097). Локаль ЗРИТЕЛЯ здесь
    роли не играет: валидность выбора в профиле не должна зависеть от того,
    на каком языке человек сейчас смотрит интерфейс — 4 кода `other.*`
    (`loan`/`rent_home`/`rent_items`/`sale_vehicle`) не подписаны НИ В ОДНОЙ
    из 29 локалей (проверено), поэтому ru/en как канонический признак
    достаточны и не дублируют полный перебор языков ради каждой проверки."""
    if code not in list_work_type_codes(sphere_code=sphere_code):
        return False
    key = f"{sphere_code}.{code}"
    return bool(
        l10n_selectors.get_catalog_text("categories", key, locale="ru")
        or l10n_selectors.get_catalog_text("categories", key, locale="en")
    )


def list_work_type_pairs() -> list[tuple[str, str]]:
    """Все пары (код сферы, код категории) с текущими пунктами чек-листа —
    кандидаты поиска «типов работ» в `GET /spheres?q=` (ADR-100: запрос
    «мебель» должен предлагать «Мебель: сборка и ремонт», а не только сферу
    «Ремонт и строительство»). Тот же union обоих путей заполнения, что
    `_by_sphere`; пусто без `import_checklists` — честно."""
    rows = (
        ChecklistTemplateItem.objects.filter(is_current=True)
        .exclude(category="")
        .annotate(
            sphere_code_=Coalesce("sphere__code", "catalog_item__sphere__code"),
        )
        .values_list("sphere_code_", "category")
        .distinct()
    )
    return sorted({(sphere, category) for sphere, category in rows if sphere})


def list_checklist_recommendations(
    *, sphere_code: str, work_type: str
) -> QuerySet[ChecklistTemplateItem]:
    """GET /checklist-recommendations?sphere=&workType= (ADR-091 §1) — НОВЫЙ
    каталожный путь (не `GET /milestones/{id}/checklist-recommendations` —
    тот требует существующий milestone). `sphere_code` обязателен у
    вызывающей стороны (api/views.py, 400 без него) — `category` не
    уникальна глобально (`other` есть почти в каждой сфере).

    Порядок (ADR-153 — «подсказки должны быть самые релевантные»):

    1. `is_default` сначала — расширенный необязательный набор
       (`is_default=False`, «пусть читают и умнеют») идёт ПОСЛЕ дефолтных,
       сколько бы пиков он ни набрал: дефолт — редакторское решение
       автора CL-файла, востребованность его не отменяет. Раньше выборка
       расширенный набор вовсе отсекала; на реальном контенте он добавляет
       к паре (сфера, вид работ) медианно 2 пункта (максимум 6, потолок
       списка — 23), поэтому включён целиком, а не урезан.
    2. `pick_count` по убыванию — сколько раз пункт реально попадал в
       чек-листы этапов договоров (`ChecklistTemplatePickStat`, ключ —
       `slug`, счётчик двигает фасад `services.record_checklist_pick`).
    3. При равенстве — каталожный `order` (порядок автора файла), затем
       `slug` для полной детерминированности выдачи.

    Пункты без `slug` (ручной сид 0006) статистики не имеют — `pick_count`
    у них 0 (в этой выборке их и так нет: `category` у них пустая, а
    `work_type` непуст)."""
    return rank_checklist_templates(
        ChecklistTemplateItem.objects.filter(
            _by_sphere(sphere_code),
            category=work_type,
            is_current=True,
        )
    )


def rank_checklist_templates(
    queryset: QuerySet[ChecklistTemplateItem],
) -> QuerySet[ChecklistTemplateItem]:
    """Единый порядок подсказок чек-листа (ADR-153, распространён ADR-155):
    `is_default ↓, pick_count ↓, order ↑, slug ↑`.

    ОДИН хелпер на ОБА пути подсказок — каталожный
    `GET /checklist-recommendations` (`list_checklist_recommendations`) и
    этапный `GET /milestones/{id}/checklist-recommendations`
    (`recommended_checklist_template_items`, ADR-047). Решение владельца
    03.09: пользователь видит один и тот же список в двух местах
    интерфейса, и «самое востребованное сверху» не может зависеть от того,
    каким путём он туда пришёл. Скопированная в два места сортировка
    разошлась бы при первой правке (обоснование каждого ключа — в
    докстринге `list_checklist_recommendations`)."""
    pick_count = ChecklistTemplatePickStat.objects.filter(slug=OuterRef("slug")).values(
        "pick_count"
    )[:1]
    return queryset.annotate(
        pick_count=Coalesce(Subquery(pick_count, output_field=IntegerField()), Value(0))
    ).order_by("-is_default", "-pick_count", "order", "slug")


def find_checklist_template_by_description(
    *, description: str, sphere_id: UUID | None = None
) -> ChecklistTemplateItem | None:
    """Шаблонный пункт, из которого сделан пункт чек-листа этапа, — по
    точному совпадению формулировки (ADR-153).

    Совпадение по тексту, а не по id, потому что этого id у вызывающей
    стороны нет: `GET /checklist-recommendations` отдаёт плоский
    `{results: string[]}` (ADR-091 §1, форма, которую ждёт фронт), и
    `POST /milestones/{id}/checklist-items` приносит обратно только текст.
    Пункт, набранный руками, ни с чем не совпадёт — и счётчик не двинет.

    Один и тот же текст может встречаться в разных сферах (категория
    `other` есть почти в каждом CL-файле), поэтому сначала пробуем сферу
    этапа, и только потом — глобально (у листа сфера может быть не
    задана вовсе, `effective_sphere_id` → None). Остаточная
    неоднозначность разрешается наименьшим `slug` — детерминированно.

    Только `is_current=True` и непустой `slug`: пик учитывается за
    ДЕЙСТВУЮЩЕЙ редакцией пункта, а ручной сид 0006 статистики не ведёт
    (докстринг `ChecklistTemplatePickStat`)."""
    candidates = ChecklistTemplateItem.objects.filter(
        is_current=True, description=description
    ).exclude(slug="")
    if sphere_id is not None:
        scoped = candidates.filter(
            Q(sphere_id=sphere_id) | Q(catalog_item__sphere_id=sphere_id)
        ).order_by("slug")
        match = scoped.first()
        if match is not None:
            return match
    return candidates.order_by("slug").first()


def recommended_checklist_template_items(
    *, catalog_item_ids: Iterable[UUID], sphere_id: UUID | None
) -> QuerySet[ChecklistTemplateItem]:
    """Шаблонные пункты чек-листа по материалам листа + базовые пункты его
    сферы (tech-spec.md §8.5 `GET .../checklist-recommendations`, ADR-047).
    `apps.milestones.services` собирает `catalog_item_ids`/`sphere_id` из
    структуры договора — здесь только запрос к справочнику (нижний слой,
    import-linter: apps.catalog ни от кого не зависит).

    Порядок — общий с каталожным путём (`rank_checklist_templates`,
    решение владельца 03.09): тот же список в другом месте интерфейса
    ранжируется тем же счётчиком востребованности. Форма ответа не
    меняется — это по-прежнему объекты, ранжирование трогает только
    очерёдность."""
    catalog_item_ids = list(catalog_item_ids)
    condition = Q(catalog_item_id__in=catalog_item_ids) if catalog_item_ids else Q(pk=None)
    if sphere_id is not None:
        condition |= Q(sphere_id=sphere_id, catalog_item__isnull=True)
    if not catalog_item_ids and sphere_id is None:
        return ChecklistTemplateItem.objects.none()
    # is_current=True — пункты, версионированные import_checklists (ADR-081),
    # отдают только актуальную редакцию; ручной сид (slug="") всегда
    # is_current=True по умолчанию, фильтр его не затрагивает.
    return rank_checklist_templates(
        ChecklistTemplateItem.objects.filter(condition, is_current=True).select_related(
            "catalog_item", "sphere"
        )
    )


def assemble_clauses(*, country_code: str, block_codes: Iterable[str]) -> QuerySet[ClauseTemplate]:
    """Пункты договора по контуру для набора блоков конструктора (ГВ.5,
    docs/tasks/global-wave.md, ADR-075) — «черновик договора в GLOBAL
    собирается из GLOBAL-блоков без правовых анкоров».

    `block_codes` — список блоков, реально задействованных в форме
    договора (apps.contracts.forms.FormField.kv_block по всем полям формы) —
    вызывающая сторона их собирает, apps.catalog про формы ничего не знает
    (нижний слой). Блоков без ClauseTemplate для этого country_code в
    результате не будет — молча (это ожидаемо, пока не вся таблица
    заполнена; полнота — забота вызывающей стороны, не этого селектора)."""
    return ClauseTemplate.objects.filter(country_code=country_code, block_code__in=block_codes)
