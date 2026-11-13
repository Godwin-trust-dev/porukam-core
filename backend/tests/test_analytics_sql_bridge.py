"""Мост `analytics/sql/*.sql` против селекторов `apps.analytics` (§9.3).

Смысл файла ровно один: форма и числа двух источников — контракт, а не
совпадение. Клиент аналитики (`analytics/client.py`) переключается между
psycopg-мостом и внутренним API одной переменной окружения, и переключение
обязано ничего не менять; расхождение в бою ловит `python -m analytics.pull
--compare`, а здесь — тест на живом PostgreSQL, до выкатки.

Тест лежит ВНЕ apps/ намеренно, как и test_analytics_marts.py: apps.analytics
ничего не импортирует из apps.* (ADR-145), а здесь нужен ещё и файл запроса
из каталога `analytics/`, который к бэкенду не относится вовсе.

Конверт (`metric`, `generated_at`, `source`) из сравнения исключён: это
служебные поля ответа, и `source` у моста и у API по определению разный —
ровно те же поля пропускает сверка в `analytics/pull.py`.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

import pytest
from django.conf import settings
from django.db import connection
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.analytics import selectors
from apps.analytics.models import InstallEvent, MartDailyPulse

SQL_DIR = Path(settings.BASE_DIR).parent / "analytics" / "sql"
pytestmark = [
    pytest.mark.django_db,
    # В публичном зеркале каталога analytics/sql/ может не быть — мост без файлов
    # запросов проверять нечем.
    pytest.mark.skipif(
        not SQL_DIR.is_dir(),
        reason="нет каталога analytics/sql/ (не входит в публичное зеркало)",
    ),
]
# Служебные поля конверта §9.1 — их и пропускает `_diff` в analytics/pull.py.
ENVELOPE_KEYS = {"metric", "generated_at", "source"}
TOKEN = "s3cr3t-metrics-token"


def _bridge(metric: str, **params: Any) -> dict[str, Any]:
    """Запуск файла моста ровно так, как его запускает SqlClient: один
    запрос, одна строка, одна колонка json."""
    sql = (SQL_DIR / f"{metric}.sql").read_text(encoding="utf-8")
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        row = cursor.fetchone()
    assert row is not None and row[0] is not None
    payload: dict[str, Any] = row[0]
    return payload


def _today() -> dt.date:
    return timezone.now().astimezone(dt.UTC).date()


def test_installs_bridge_repeats_the_selector_one_to_one() -> None:
    """✅ Мост и селектор дают ОДИН И ТОТ ЖЕ ответ: те же ключи, те же числа,
    та же воронка и те же разрезы (ADR-171)."""
    MartDailyPulse.objects.create(
        day=_today(),
        install_prompt_shown=10,
        install_clicks=5,
        pwa_installs=2,
        play_clicks=3,
        standalone_opens=7,
    )
    InstallEvent.objects.create(kind="install_click", platform="android", source="site")
    InstallEvent.objects.create(kind="pwa_installed", platform="android", source="site")
    InstallEvent.objects.create(kind="play_click", platform="ios", source="play")

    payload = _bridge("installs", window_days=7)
    expected = selectors.installs(window_days=7)

    assert payload["metric"] == "installs"
    assert payload["source"] == "sql"
    assert {k: v for k, v in payload.items() if k not in ENVELOPE_KEYS} == expected


def test_installs_bridge_fills_days_without_a_mart_row_with_zeros() -> None:
    """✅ Ряд непрерывен: день без строки витрины — нули, а не пропуск.
    Пропуск читался бы как «в этот день не ставили»."""
    MartDailyPulse.objects.create(day=_today(), install_prompt_shown=4, install_clicks=1)

    payload = _bridge("installs", window_days=3)

    assert len(payload["daily"]) == 3
    assert payload["daily"][0]["prompt_shown"] == 0
    assert payload["daily"][-1]["prompt_shown"] == 4
    assert payload["daily"] == selectors.installs(window_days=3)["daily"]


def test_installs_bridge_keeps_none_share_on_empty_denominator() -> None:
    """✅ Ноль показов — null, а не 0%: «никому не предлагали» и «предложили,
    не поставили» это разные диагнозы, и мост обязан врать не больше, чем
    селектор."""
    payload = _bridge("installs", window_days=5)

    assert payload["prompt_to_click"] is None
    assert payload["click_to_install"] is None
    assert payload["totals"]["pwa_installed"] == 0
    assert payload["play_installs"]["available"] is False
    assert (
        payload["play_installs"]["reason"]
        == (selectors.installs(window_days=5)["play_installs"]["reason"])
    )


def test_installs_endpoint_answers_in_the_same_envelope_as_the_bridge() -> None:
    """✅ Самостоятельная метрика — в конверте §9.1: ответ эндпоинта отдаёт тот
    же набор ключей, что и файл моста, иначе `pull --compare` ругался бы на
    служебные поля. Заодно проверен и сам маршрут, и алиас окна: клиент моста
    шлёт `window_days`, а не `window`."""
    MartDailyPulse.objects.create(day=_today(), install_prompt_shown=2, install_clicks=1)
    payload = _bridge("installs", window_days=7)

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    with override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["*"]):
        response = client.get("/internal/v1/metrics/installs?window_days=7")
    assert response.status_code == 200, response.content

    api_payload = dict(response.data)
    assert set(api_payload) == set(payload)
    assert api_payload["metric"] == "installs"
    assert api_payload["source"] == "api"
    assert api_payload["window_days"] == 7
    assert {k: v for k, v in api_payload.items() if k not in ENVELOPE_KEYS} == {
        k: v for k, v in payload.items() if k not in ENVELOPE_KEYS
    }
