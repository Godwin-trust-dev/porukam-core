"""Каталожный поиск с фильтром (ADR-186, часть 7 плана 11.09) — третий и
последний ввод приложения: `apps.analytics.services.record_catalog_search`,
хранение (`purge_catalog_search_events`) и чтение (`selectors.search_filters`).

Единственный вопрос, на который заведена метрика: пользуются ли новыми
фильтрами каталога (часть 5, ADR-184) и какими именно. Каждый вид фильтра —
отдельным тестом, сочетание — отдельным, отсутствие персональных данных —
отдельным (CLAUDE.md).

Идентификаторы пользователей в тестах — ВСЕГДА свежий `uuid4`, а не
фиксированная строка: дедупликация (§5 ADR-186) живёт в общем Redis-кеше,
который переживает и повтор прогона, и параллельные `pytest-xdist`-воркеры
(`-n auto`, `pyproject.toml`). Фиксированная строка рано или поздно
столкнулась бы с самой собой — своим же ключом от прошлого прогона или от
соседнего воркера — и тест ошибочно решил бы, что событие «уже засчитано»."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.analytics import selectors, services
from apps.analytics.models import CatalogSearchEvent, MartDailyPulse

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _uid() -> str:
    return str(uuid.uuid4())


# --------------------------------------------------------------------------
# Запись: что считается «поиском с фильтром», а что нет
# --------------------------------------------------------------------------
def test_search_without_any_filter_is_recorded_as_unfiltered() -> None:
    """✅ Поиск без единого фильтра («весь мир», catalog=1) — тоже поиск,
    просто НЕ «с фильтром»: geo_level=none, сфера и опыт не заданы."""
    event = services.record_catalog_search(user_id=_uid())
    assert event is not None
    assert event.geo_level == CatalogSearchEvent.GeoLevel.NONE
    assert event.has_sphere is False
    assert event.has_experience is False


@pytest.mark.parametrize("level", ["country", "region", "city"])
def test_each_geo_level_is_recorded_separately(level: str) -> None:
    """✅ Каждый уровень гео-фильтра (страна/регион/город) — своим значением,
    а не общей отметкой «есть гео»."""
    event = services.record_catalog_search(user_id=_uid(), geo_level=level)
    assert event is not None
    assert event.geo_level == level


def test_sphere_filter_alone_is_recorded() -> None:
    """✅ Фильтр по сфере — независимая ось от гео и опыта."""
    event = services.record_catalog_search(user_id=_uid(), has_sphere=True)
    assert event is not None
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("none", True, False)


def test_experience_filter_alone_is_recorded() -> None:
    """✅ Фильтр по опыту — независимая ось, включая порог 0 (ADR-184: ноль —
    валидный порог, значит фильтр применён, и это решает вызывающий код,
    здесь просто фиксируется факт применения)."""
    event = services.record_catalog_search(user_id=_uid(), has_experience=True)
    assert event is not None
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("none", False, True)


def test_combination_of_all_filters_is_recorded_together() -> None:
    """✅ Сочетание фильтров — один факт с тремя измерениями сразу, а не три
    отдельных события."""
    event = services.record_catalog_search(
        user_id=_uid(), geo_level="city", has_sphere=True, has_experience=True
    )
    assert event is not None
    assert (event.geo_level, event.has_sphere, event.has_experience) == ("city", True, True)


def test_unknown_geo_level_is_rejected() -> None:
    """🚫 Уровень — из закрытого перечисления, а не произвольная строка."""
    with pytest.raises(ValueError):
        services.record_catalog_search(user_id=_uid(), geo_level="planet")


# --------------------------------------------------------------------------
# Отсутствие персональных данных (CLAUDE.md, ADR-186)
# --------------------------------------------------------------------------
def test_record_catalog_search_stores_no_personal_data() -> None:
    """✅ В записи нет ничего, что можно связать с человеком: ни user_id, ни
    IP, ни значений фильтра (кода страны/id города/кода сферы) — только
    коды уровней и булевы флаги."""
    event = services.record_catalog_search(
        user_id=_uid(), geo_level="city", has_sphere=True, has_experience=True
    )
    assert event is not None
    field_names = {f.name for f in CatalogSearchEvent._meta.get_fields()}
    forbidden = {
        "user",
        "user_id",
        "ip",
        "country",
        "region",
        "city",
        "sphere",
        "sphere_codes",
        "query",
    }
    assert not (field_names & forbidden)


# --------------------------------------------------------------------------
# Дедупликация — защита от случайного двойного вызова, не от накрутки
# --------------------------------------------------------------------------
@override_settings(ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS=60)
def test_identical_search_by_same_user_within_window_is_deduplicated() -> None:
    """✅ Тот же человек, то же сочетание фильтра, короткое окно — вторая
    запись не создаётся (защита от двойного клика/повторного рендера)."""
    user_id = _uid()
    first = services.record_catalog_search(user_id=user_id, geo_level="country")
    second = services.record_catalog_search(user_id=user_id, geo_level="country")
    assert first is not None
    assert second is None
    assert CatalogSearchEvent.objects.count() == 1


@override_settings(ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS=60)
def test_different_users_are_not_deduplicated_against_each_other() -> None:
    """✅ Дедупликация — по (пользователь, фильтр), а не глобальный лимит:
    два разных человека, ищущих одно и то же одновременно, оба считаются."""
    first = services.record_catalog_search(user_id=_uid(), geo_level="country")
    second = services.record_catalog_search(user_id=_uid(), geo_level="country")
    assert first is not None
    assert second is not None
    assert CatalogSearchEvent.objects.count() == 2


@override_settings(ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS=60)
def test_different_filters_by_same_user_are_not_deduplicated() -> None:
    """✅ Тот же человек с ДРУГИМ сочетанием фильтра — новый факт, не
    повтор прежнего поиска."""
    user_id = _uid()
    first = services.record_catalog_search(user_id=user_id, geo_level="country")
    second = services.record_catalog_search(user_id=user_id, geo_level="city")
    assert first is not None
    assert second is not None
    assert CatalogSearchEvent.objects.count() == 2


# --------------------------------------------------------------------------
# Хранение
# --------------------------------------------------------------------------
def test_purge_catalog_search_events_respects_retention() -> None:
    """✅ Хранение 90 дней — то же условие, на котором заведён весь
    поведенческий слой."""
    fresh = services.record_catalog_search(user_id=_uid())
    old = services.record_catalog_search(user_id=_uid())
    assert fresh is not None
    assert old is not None
    CatalogSearchEvent.objects.filter(pk=old.pk).update(
        created_at=timezone.now() - dt.timedelta(days=200)
    )
    assert services.purge_catalog_search_events() == 1
    assert CatalogSearchEvent.objects.count() == 1


# --------------------------------------------------------------------------
# Чтение: агрегат считает то, что ожидается
# --------------------------------------------------------------------------
def _record(**kwargs: object) -> CatalogSearchEvent:
    kwargs.setdefault("user_id", _uid())
    event = services.record_catalog_search(**kwargs)  # type: ignore[arg-type]
    assert event is not None
    return event


def test_search_filters_totals_split_filtered_from_unfiltered() -> None:
    """✅ «Сколько поисков вообще» и «сколько с фильтром» — разные числа:
    без единого фильтра поиск НЕ попадает в filtered. Витрина изолирована
    от других тестов транзакцией (`pytest.mark.django_db`), поэтому числа —
    абсолютные, без диффа."""
    today = timezone.now().astimezone(dt.UTC).date()
    MartDailyPulse.objects.create(day=today, catalog_searches_total=5, catalog_searches_filtered=2)
    payload = selectors.search_filters(window_days=7)
    assert payload["totals"] == {"total": 5, "filtered": 2}
    assert payload["filtered_share"] == pytest.approx(0.4)


def test_search_filters_totals_are_none_share_without_any_search() -> None:
    """✅ Ноль поисков — доля `None`, а не 0/0: «не искали» и «искали без
    фильтра» — разные диагнозы (тот же принцип, что у install-воронки)."""
    payload = selectors.search_filters(window_days=7)
    assert payload["totals"] == {"total": 0, "filtered": 0}
    assert payload["filtered_share"] is None


def test_search_filters_breaks_down_by_geo_level() -> None:
    """✅ Разрез по гео-уровню — независимый счётчик на каждый уровень."""
    _record(geo_level="country")
    _record(geo_level="country")
    _record(geo_level="city")
    _record()  # без гео вовсе
    payload = selectors.search_filters(window_days=7)
    assert payload["by_geo_level"] == {"none": 1, "country": 2, "city": 1}


def test_search_filters_breaks_down_by_sphere_and_experience() -> None:
    """✅ Разрез по сфере и по опыту — раздельно."""
    _record(has_sphere=True)
    _record(has_experience=True)
    _record()
    payload = selectors.search_filters(window_days=7)
    assert payload["by_sphere"] == {"yes": 1, "no": 2}
    assert payload["by_experience"] == {"yes": 1, "no": 2}


def test_search_filters_breaks_down_by_combination() -> None:
    """✅ Сочетание фильтров — отдельная строка на каждую встретившуюся
    комбинацию, со своим счётчиком."""
    _record(geo_level="city", has_sphere=True, has_experience=True)
    _record(geo_level="city", has_sphere=True, has_experience=True)
    _record(geo_level="country", has_sphere=True)
    payload = selectors.search_filters(window_days=7)
    combos = {
        (c["geo_level"], c["has_sphere"], c["has_experience"]): c["count"]
        for c in payload["combinations"]
    }
    assert combos[("city", True, True)] == 2
    assert combos[("country", True, False)] == 1


def test_search_filters_metric_envelope_names_itself() -> None:
    """✅ Тот же конверт §9.1, что у остальных внутренних метрик."""
    payload = selectors.search_filters_metric(window_days=7)
    assert payload["metric"] == "search_filters"
    assert "generated_at" in payload
