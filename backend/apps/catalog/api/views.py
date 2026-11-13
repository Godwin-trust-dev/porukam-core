from __future__ import annotations

from collections.abc import Callable
from typing import Any

from django.conf import settings
from django.core.cache import cache
from drf_spectacular.utils import extend_schema
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.l10n import selectors as l10n_selectors
from common.i18n import resolve_request_locale

from .. import search, selectors
from ..models import ContractTypeCatalogItem
from .serializers import (
    ChecklistRecommendationsSerializer,
    ContractTypeOptionListSerializer,
    MaterialCatalogListSerializer,
    SphereListSerializer,
    UnitOptionListSerializer,
    WorkTypeListSerializer,
    localized_name,
)


def _cached_payload(key_parts: tuple[str, ...], build: Callable[[], Any]) -> Any:
    """Redis-кэш готовых ответов справочников (№8 отсмотра 2026-08-18:
    холодный каталог на проде отвечал до 16 с). Каталог меняется данными
    (миграции, l10n-импорт), а не на каждый запрос — короткий TTL честно
    отражает это без инвалидации. TTL задаёт CATALOG_CACHE_TTL: 0 (дефолт —
    dev/тесты) выключает кэш полностью, прод включает через окружение
    (docker-compose.prod.yml). Ключ обязан включать локаль: имена
    локализуются сервером."""
    ttl = settings.CATALOG_CACHE_TTL
    if ttl <= 0:
        return build()
    key = "catalog:" + ":".join(key_parts)
    payload = cache.get(key)
    if payload is None:
        payload = build()
        cache.set(key, payload, ttl)
    return payload


class ContractTypeListView(APIView):
    """GET /contract-types[?client_option=] (ADR-094) — типы клиентского
    дерева для мастера создания: «Услуга» резолвится бэком по
    `client_option`, а Продажа/Аренда/Займ требуют явный
    `contract_type_code` в `POST /contracts` — этот список и есть источник
    кодов для фронта. Read-only, AllowAny — тот же уровень, что остальные
    справочники ADR-091."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: ContractTypeOptionListSerializer})
    def get(self, request: Request) -> Response:
        locale = resolve_request_locale(request)
        client_option = request.query_params.get("client_option") or None
        valid = set(ContractTypeCatalogItem.ClientOption.values)
        if client_option is not None and client_option not in valid:
            raise ValidationError({"client_option": f"один из {sorted(valid)}"})

        def build() -> Any:
            items = selectors.list_client_tree_contract_types(client_option=client_option)
            data = {"results": list(items)}
            return ContractTypeOptionListSerializer(data, context={"locale": locale}).data

        return Response(_cached_payload(("contract-types", locale, client_option or "all"), build))


def _category_labels_by_sphere(locale: str) -> dict[str, tuple[str, ...]]:
    """Имена категорий (`catalog.categories.<сфера>.<код>` из языковых
    пакетов, ADR-097) сгруппированные по коду сферы — кандидаты поиска:
    «маникюр» находит сферу beauty через её категорию nails. К цепочке
    locale → en всегда добавлен ru — запрос на языке, отличном от языка
    интерфейса, обычный случай двуязычного пользователя."""
    grouped: dict[str, list[str]] = {}
    merged = dict(l10n_selectors.get_catalog_map("categories", locale="ru"))
    if locale != "ru":
        merged.update(l10n_selectors.get_catalog_map("categories", locale=locale))
    for key, text in merged.items():
        sphere_code, _, category_code = key.partition(".")
        if category_code:
            grouped.setdefault(sphere_code, []).append(text)
    return {code: tuple(names) for code, names in grouped.items()}


def _localized_category_names(locale: str) -> dict[str, str]:
    """`catalog.categories.<сфера>.<код>` одним словарём с фолбэком
    locale → en → ru (ADR-097/ADR-190) — общий приём с
    `_category_labels_by_sphere`/`_rank_work_types`: базовый ru всегда в
    основании, локаль (со своим внутренним locale→en фолбэком) перекрывает
    его сверху. Ключ ОТСУТСТВУЕТ в результате, если подписи нет НИ В ОДНОЙ
    из локалей вовсе (не просто «не переведено на locale») — это и есть
    признак «не показывать как вид работ» (ADR-190: 4 кода `other.*`)."""
    labels_ru = l10n_selectors.get_catalog_map("categories", locale="ru")
    if locale == "ru":
        return dict(labels_ru)
    return {**labels_ru, **l10n_selectors.get_catalog_map("categories", locale=locale)}


# Сколько типов работ показывать в подсказках поиска: выдача — список под
# строкой ввода, длиннее десятка строк он уже не «подсказка».
_WORK_TYPE_HITS_LIMIT = 8


def _rank_work_types(q: str, locale: str, sphere_names: dict[str, str]) -> list[dict[str, str]]:
    """Типы работ (категории чек-листов с реальным контентом), совпавшие с
    запросом (ADR-100): «мебель» → «Мебель: сборка и ремонт» (renovation.
    furniture). Кандидаты — только пары, у которых есть текущие пункты
    чек-листа (`list_work_type_pairs`): иначе выбор вёл бы в пустые
    рекомендации. Имя — из пакета locale→en с добавленным ru (двуязычный
    запрос, как в `_category_labels_by_sphere`); ранжирование — тот же
    `search.rank_spheres` поверх составного кода `<сфера>.<категория>`."""
    labels_ru = l10n_selectors.get_catalog_map("categories", locale="ru")
    labels = (
        dict(labels_ru)
        if locale == "ru"
        else {**labels_ru, **l10n_selectors.get_catalog_map("categories", locale=locale)}
    )
    candidates: list[search.SphereCandidate] = []
    for sphere_code, category_code in selectors.list_work_type_pairs():
        if sphere_code not in sphere_names:
            continue
        key = f"{sphere_code}.{category_code}"
        names = {text for text in (labels.get(key), labels_ru.get(key)) if text}
        if not names:
            continue
        candidates.append(search.SphereCandidate(code=key, names=tuple(names)))
    ranked = search.rank_spheres(q, candidates)[:_WORK_TYPE_HITS_LIMIT]
    hits: list[dict[str, str]] = []
    for key in ranked:
        sphere_code, _, category_code = key.partition(".")
        hits.append(
            {
                "code": category_code,
                "name": labels.get(key) or labels_ru.get(key) or category_code,
                "sphere_code": sphere_code,
                "sphere_name": sphere_names[sphere_code],
            }
        )
    return hits


class SphereListView(APIView):
    """GET /spheres?q= (ADR-091, поиск пересмотрен ADR-097) — сферы для
    SpherePicker: без `q` — все активные (§1/§4, «Все сферы» иначе показала
    бы пустоту); с `q` — нечёткий ранжированный поиск (apps.catalog.search:
    токены, префикс/подстрока/опечатки, имена категорий как кандидаты).
    `popular` — всегда `[]` (§3, нет сигнала популярности)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: SphereListSerializer})
    def get(self, request: Request) -> Response:
        locale = resolve_request_locale(request)
        q = (request.query_params.get("q") or "").strip()

        def build() -> Any:
            spheres = list(selectors.list_active_spheres())
            # RU-контур остаётся на name_i18n (докстринг apps.l10n.selectors);
            # остальные языки берут имя из пакета (там все сферы, в отличие от
            # name_i18n, где en есть лишь у части) с фолбэком на name_i18n.
            pack_names = (
                {} if locale == "ru" else l10n_selectors.get_catalog_map("spheres", locale=locale)
            )
            if q:
                category_labels = _category_labels_by_sphere(locale)
                candidates: list[search.SphereCandidate] = []
                for s in spheres:
                    names = {name for name in s.name_i18n.values() if name}
                    if s.code in pack_names:
                        names.add(pack_names[s.code])
                    candidates.append(
                        search.SphereCandidate(
                            code=s.code,
                            names=tuple(names),
                            category_names=category_labels.get(s.code, ()),
                        )
                    )
                by_code = {s.code: s for s in spheres}
                sphere_names = {
                    s.code: pack_names.get(s.code) or localized_name(s.name_i18n, locale)
                    for s in spheres
                }
                work_types = _rank_work_types(q, locale, sphere_names)
                spheres = [by_code[code] for code in search.rank_spheres(q, candidates)]
            else:
                work_types = []
            data = {"results": spheres, "popular": [], "work_types": work_types}
            return SphereListSerializer(
                data, context={"locale": locale, "pack_names": pack_names}
            ).data

        if q:
            # Поисковые выдачи не кэшируем: пространство ключей — произвольные
            # строки пользователя, hit-rate ~0, а Redis замусоривается.
            return Response(build())
        return Response(_cached_payload(("spheres", locale), build))


class WorkTypeListView(APIView):
    """GET /work-types?sphere= (ADR-091, подписи — ADR-097/ADR-190) — «вид
    работ» = категория импортированного чек-листа этой сферы (§1/«Контекст»).
    `sphere` обязателен. `name` — ТОЛЬКО человекочитаемое имя категории из
    языковых пакетов (`catalog.categories.<сфера>.<код>`, фолбэк
    locale → en → ru, `_localized_category_names`); коды БЕЗ подписи ни в
    одной локали (4 штуки в сфере `other` — `loan`/`rent_home`/
    `rent_items`/`sale_vehicle`, социальные/имущественные архетипы, не
    услуги) из выдачи ИСКЛЮЧЕНЫ решением владельца 12.09 — не подставляем
    сырой код вместо имени (прежнее поведение ADR-091 §1 отменено ADR-190)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: WorkTypeListSerializer})
    def get(self, request: Request) -> Response:
        sphere_code = request.query_params.get("sphere")
        if not sphere_code:
            raise ValidationError({"sphere": "обязателен"})
        locale = resolve_request_locale(request)

        def build() -> Any:
            labels = _localized_category_names(locale)
            codes = selectors.list_work_type_codes(sphere_code=sphere_code)
            results = []
            for c in codes:
                name = labels.get(f"{sphere_code}.{c}")
                if not name:
                    continue
                results.append({"code": c, "name": name, "sphere_code": sphere_code})
            return WorkTypeListSerializer({"results": results}).data

        return Response(_cached_payload(("work-types", locale, sphere_code), build))


class MaterialCatalogListView(APIView):
    """GET /material-catalog[?sphere=] (ADR-091) — `sphere` опционален
    (единственный текущий вызов фронта его не передаёт, §«Не делать»)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: MaterialCatalogListSerializer})
    def get(self, request: Request) -> Response:
        locale = resolve_request_locale(request)
        sphere_code = request.query_params.get("sphere") or None

        def build() -> Any:
            items = selectors.list_active_material_catalog(sphere_code=sphere_code)
            data = {"results": list(items)}
            return MaterialCatalogListSerializer(data, context={"locale": locale}).data

        return Response(_cached_payload(("material-catalog", locale, sphere_code or "all"), build))


class UnitListView(APIView):
    """GET /units (ADR-091) — единицы измерения, производная выборка из
    каталога материалов (§1 — своей модели нет)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: UnitOptionListSerializer})
    def get(self, request: Request) -> Response:
        def build() -> Any:
            codes = selectors.list_unit_codes()
            results = [{"code": c, "label": c} for c in codes]
            return UnitOptionListSerializer({"results": results}).data

        return Response(_cached_payload(("units",), build))


class ChecklistRecommendationsView(APIView):
    """GET /checklist-recommendations?sphere=&workType= (ADR-091) — НОВЫЙ
    каталожный путь (не GET /milestones/{id}/checklist-recommendations —
    тот требует существующий milestone). Оба параметра обязательны:
    `category` не уникальна глобально («other» почти в каждой сфере,
    §1 докстринг selectors._by_sphere)."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: ChecklistRecommendationsSerializer})
    def get(self, request: Request) -> Response:
        sphere_code = request.query_params.get("sphere")
        work_type = request.query_params.get("workType")
        if not sphere_code or not work_type:
            raise ValidationError({"sphere": "обязателен", "workType": "обязателен"})
        locale = resolve_request_locale(request)
        items = selectors.list_checklist_recommendations(
            sphere_code=sphere_code, work_type=work_type
        )
        results = [item.description_i18n.get(locale) or item.description for item in items]
        return Response(ChecklistRecommendationsSerializer({"results": results}).data)
