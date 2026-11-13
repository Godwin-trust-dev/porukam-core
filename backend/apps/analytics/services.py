"""Пересчёт витрин аналитики (docs/tasks/marketing-metrics.md §8.3).

Единственный сценарий записи в приложении: витрины пересчитываются раз в час,
всё остальное — чтение. Приложение НЕ импортирует чужие модели: пересчёт идёт
SQL-запросами из `sql/` по outbox и доменным таблицам — тому же единственному
источнику истины, из которого строятся хроника, уведомления и журнал аудита
(§1 п.4). Границу проверяет import-linter.

Порядок пересчёта важен: `mart_daily_pulse` и его разрезы считаются ПОВЕРХ
`mart_contract_lifecycle` и `mart_user_cohorts` (§8.3: «всё остальное
считается поверх них»), поэтому базовые витрины идут первыми.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import connection, transaction
from django.utils import timezone

from .models import CatalogSearchEvent, ConstructorStepEvent, InstallEvent, MartRefreshRun

logger = logging.getLogger(__name__)

SQL_DIR = Path(__file__).resolve().parent / "sql"

# Порядок — часть контракта, не деталь реализации (см. докстринг модуля).
MART_ORDER: tuple[str, ...] = (
    "mart_contract_lifecycle",
    "mart_user_cohorts",
    "mart_daily_pulse",
    "mart_daily_pulse_slice",
)


@dataclass(frozen=True)
class RefreshResult:
    mart: str
    ok: bool
    rows: int
    duration_ms: int
    error: str = ""


def _params() -> dict[str, Any]:
    return {
        "days": int(getattr(settings, "ANALYTICS_PULSE_WINDOW_DAYS", 90)),
        "abandoned_after_days": int(getattr(settings, "ANALYTICS_ABANDONED_DRAFT_DAYS", 14)),
        "dispute_attention_days": int(getattr(settings, "ANALYTICS_DISPUTE_ATTENTION_DAYS", 20)),
        "dispute_escalation_days": int(getattr(settings, "ANALYTICS_DISPUTE_ESCALATION_DAYS", 25)),
    }


def _read_sql(mart: str) -> str:
    path = SQL_DIR / f"{mart}.sql"
    if not path.is_file():
        raise FileNotFoundError(f"нет файла пересчёта витрины: {path}")
    return path.read_text(encoding="utf-8")


def refresh_mart(mart: str) -> RefreshResult:
    """Пересчёт одной витрины. Полный (INSERT ... ON CONFLICT DO UPDATE):
    на нынешних объёмах это дешевле инкрементальной логики и не оставляет
    вопроса «а вдруг какая-то строка отстала»."""
    if mart not in MART_ORDER:
        raise ValueError(f"неизвестная витрина {mart!r}, есть: {', '.join(MART_ORDER)}")
    sql = _read_sql(mart)
    params = {k: v for k, v in _params().items() if f"%({k})s" in sql}
    started_at = timezone.now()
    began = time.monotonic()
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql, params)
            rows = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    except Exception as exc:  # noqa: BLE001 — прогон витрины не должен ронять beat
        duration_ms = int((time.monotonic() - began) * 1000)
        logger.exception("analytics: пересчёт витрины %s провалился", mart)
        MartRefreshRun.objects.create(
            mart=mart,
            ok=False,
            rows=0,
            duration_ms=duration_ms,
            error=str(exc)[:2000],
            started_at=started_at,
        )
        return RefreshResult(mart=mart, ok=False, rows=0, duration_ms=duration_ms, error=str(exc))

    duration_ms = int((time.monotonic() - began) * 1000)
    MartRefreshRun.objects.create(
        mart=mart, ok=True, rows=rows, duration_ms=duration_ms, started_at=started_at
    )
    return RefreshResult(mart=mart, ok=True, rows=rows, duration_ms=duration_ms)


def refresh_marts(marts: tuple[str, ...] | None = None) -> list[RefreshResult]:
    """Пересчёт всех витрин в правильном порядке. Провал одной не отменяет
    остальные — но и не маскируется: каждая попытка ложится в MartRefreshRun,
    а возраст последнего успешного прогона отдаётся в /metrics/health.
    Витрина, которая молча перестала пересчитываться, хуже отсутствующей:
    по ней принимают решения, считая её свежей."""
    targets = marts or MART_ORDER
    return [refresh_mart(mart) for mart in targets]


def record_constructor_step(
    *, step_code: str, action: str, contract_id: Any | None = None, occurred_at: Any = None
) -> ConstructorStepEvent:
    """Единственный поведенческий слой продукта (§8.1) — шаг конструктора
    договора. Нужен потому, что брошенный черновик иначе неизмерим:
    доменного события «бросил на шаге 3» не существует и не должно
    существовать.

    Никаких персональных данных: идентификатор черновика, код шага, действие.
    Ни `user_id`, ни IP, ни содержимого полей формы здесь нет и не появится —
    иначе слой перестаёт быть узким и превращается в клиентский трекинг,
    от которого §9.4 отказывается сознательно."""
    if action not in ConstructorStepEvent.Action.values:
        raise ValueError(f"недопустимое действие {action!r}")
    return ConstructorStepEvent.objects.create(
        contract_id=contract_id,
        step_code=step_code[:64],
        action=action,
        occurred_at=occurred_at or timezone.now(),
    )


def purge_constructor_step_events() -> int:
    """Хранение 90 дней (§8.1) — не «когда-нибудь почистим», а часть условия,
    на котором слой вообще заведён."""
    days = int(getattr(settings, "ANALYTICS_CONSTRUCTOR_RETENTION_DAYS", 90))
    cutoff = timezone.now() - timedelta(days=days)
    deleted, _ = ConstructorStepEvent.objects.filter(occurred_at__lt=cutoff).delete()
    return int(deleted)


# --------------------------------------------------------------------------
# Установки приложения (ADR-171) — второй и последний ввод приложения
# --------------------------------------------------------------------------
class InstallEventRateLimitedError(RuntimeError):
    """Адрес превысил лимит событий установки за окно."""


def _install_rate_limit_key(client_ip: str) -> str:
    # В ключе кеша — ХЕШ адреса, а не адрес. Кеш переживает запрос, и держать
    # в нём разбираемый IP значило бы завести хранилище адресов посетителей
    # в приложении, которое обязано быть без персональных данных (§1 п.3).
    digest = hashlib.sha256((client_ip or "unknown").encode("utf-8")).hexdigest()[:32]
    return f"analytics:install:{digest}"


def check_install_event_rate_limit(client_ip: str) -> None:
    """Приёмник событий установки открыт анонимно — иначе он не измерял бы
    ровно тот случай, ради которого заведён (человек ставит приложение до
    регистрации). Открытая ручка обязана иметь лимит: без него кто угодно
    зальёт витрину выдуманными установками. Приём тот же, что у публичной
    ссылки на архив (ADR-137) — счётчик в кеше по адресу."""
    key = _install_rate_limit_key(client_ip)
    window = int(getattr(settings, "ANALYTICS_INSTALL_RATE_WINDOW_SECONDS", 3600))
    limit = int(getattr(settings, "ANALYTICS_INSTALL_RATE_LIMIT", 60))
    try:
        count = int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=window)
        count = 1
    if count > limit:
        raise InstallEventRateLimitedError("превышен лимит событий установки")


def record_install_event(
    *,
    kind: str,
    platform: str = InstallEvent.Platform.OTHER,
    display_mode: str = InstallEvent.DisplayMode.BROWSER,
    source: str = InstallEvent.Source.UNKNOWN,
    user_id: Any | None = None,
) -> InstallEvent:
    """Записывает факт из воронки установки (ADR-171).

    Набор видов ЗАКРЫТ: произвольный код здесь означал бы клиентский
    трекинг, от которого §9.4 отказывается сознательно. Ни User-Agent, ни
    IP, ни отпечатка устройства — платформа приходит уже грубой корзиной,
    и сузить её обратно до устройства нельзя.

    `user_id` пуст у гостя и это НЕ дефект данных: установка до входа —
    нормальный сценарий, ради которого ручка и открыта анонимно."""
    if kind not in InstallEvent.Kind.values:
        raise ValueError(f"недопустимый вид события установки {kind!r}")
    if platform not in InstallEvent.Platform.values:
        platform = InstallEvent.Platform.OTHER
    if display_mode not in InstallEvent.DisplayMode.values:
        display_mode = InstallEvent.DisplayMode.BROWSER
    if source not in InstallEvent.Source.values:
        source = InstallEvent.Source.UNKNOWN
    return InstallEvent.objects.create(
        user_id=user_id,
        kind=kind,
        platform=platform,
        display_mode=display_mode,
        source=source,
    )


def purge_install_events() -> int:
    """Хранение 90 дней — то же условие, на котором заведён слой шагов
    конструктора. Здесь оно жёстче по смыслу: у события установки есть
    `user_id`, то есть связь с человеком, пусть и псевдонимная."""
    days = int(getattr(settings, "ANALYTICS_INSTALL_RETENTION_DAYS", 90))
    cutoff = timezone.now() - timedelta(days=days)
    deleted, _ = InstallEvent.objects.filter(created_at__lt=cutoff).delete()
    return int(deleted)


# --------------------------------------------------------------------------
# Каталожный поиск с фильтром (ADR-186) — третий и последний ввод приложения
# --------------------------------------------------------------------------
def _catalog_search_dedup_key(
    user_id: Any | None, *, geo_level: str, has_sphere: bool, has_experience: bool
) -> str:
    # В ключе кеша — ХЕШ, а не сам идентификатор пользователя: он нужен
    # только чтобы отличить «тот же человек нажал дважды» от «два разных
    # человека одновременно ищут одно и то же», и не должен переживать окно
    # дедупликации в развёрнутом виде (тот же приём, что у client_ip выше).
    signature = f"{user_id}:{geo_level}:{int(has_sphere)}:{int(has_experience)}"
    digest = hashlib.sha256(signature.encode("utf-8")).hexdigest()[:32]
    return f"analytics:catalog-search-dedup:{digest}"


def record_catalog_search(
    *,
    user_id: Any | None,
    geo_level: str = CatalogSearchEvent.GeoLevel.NONE,
    has_sphere: bool = False,
    has_experience: bool = False,
) -> CatalogSearchEvent | None:
    """Записывает факт каталожного поиска (ADR-186). Вызывается НЕ по HTTP от
    браузера, а обычным вызовом фасада из `apps.dashboards` (та же обвязка
    `GET /dashboard/search`, что вычислила ветку `catalog`) — единственный
    ввод приложения, устроенный так, а не POST-эндпоинтом: факт распознаёт
    сам бэкенд, фронта в этой задаче нет.

    Короткое окно дедупликации (`ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS`) —
    защита от случайного повторного вызова (двойной клик, повторный рендер
    формы фильтра), а не от целенаправленной накрутки: ручка и так за
    `IsAuthenticated`. `user_id` участвует ТОЛЬКО в ключе дедупликации и
    никогда не попадает в саму запись — CatalogSearchEvent не должен уметь
    указать на конкретного человека."""
    if geo_level not in CatalogSearchEvent.GeoLevel.values:
        raise ValueError(f"недопустимый уровень гео-фильтра {geo_level!r}")
    key = _catalog_search_dedup_key(
        user_id, geo_level=geo_level, has_sphere=has_sphere, has_experience=has_experience
    )
    window = int(getattr(settings, "ANALYTICS_CATALOG_SEARCH_DEDUP_SECONDS", 5))
    if not cache.add(key, 1, timeout=window):
        return None
    return CatalogSearchEvent.objects.create(
        geo_level=geo_level, has_sphere=has_sphere, has_experience=has_experience
    )


def purge_catalog_search_events() -> int:
    """Хранение 90 дней — то же условие, на котором заведён весь
    поведенческий слой (§8.1/ADR-171/ADR-186), хотя здесь оно даже не про
    людей: в записи нет ничего, что можно было бы связать с человеком."""
    days = int(getattr(settings, "ANALYTICS_CATALOG_SEARCH_RETENTION_DAYS", 90))
    cutoff = timezone.now() - timedelta(days=days)
    deleted, _ = CatalogSearchEvent.objects.filter(created_at__lt=cutoff).delete()
    return int(deleted)
