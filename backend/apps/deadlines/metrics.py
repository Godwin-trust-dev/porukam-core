"""Лаг sweep'а доменных дедлайнов (tech-spec.md §11: "лаг sweep'а дедлайнов,
SLO < 60 с" — юридически значимая метрика, на ней стоит пауза тайм-аутов
ADR-039). Гистограмма считается НА КАЖДЫЙ /metrics-скрейп прямым запросом
к DomainDeadline (fired_at - deadline_at уже хранятся на модели, отдельной
записи "в момент срабатывания" не требуется) — тот же приём, что
common.metrics (см. докстринг там): sweep выполняется в Celery worker,
/metrics отдаёт core, общая БД снимает вопрос синхронизации между процессами.

Бакеты — кумулятивные счётчики "за всё время" в окне `_LOOKBACK`, а не
инкрементальный Counter: с точки зрения формата экспозиции Prometheus это
валидный histogram (bucket'ы обязаны быть кумулятивными счётчиками, откуда
именно взято число — не важно), `histogram_quantile()`/`rate()` работают
как обычно. Окно ограничено 7 днями, чтобы запрос не деградировал по мере
роста таблицы; смена окна отражается как обычный сброс counter'а (как при
рестарте процесса) — приемлемо для этой метрики."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.db import Error as DjangoDBError
from django.db.models import DurationField, ExpressionWrapper, F
from django.utils import timezone
from prometheus_client import REGISTRY
from prometheus_client.core import HistogramMetricFamily
from prometheus_client.registry import Collector

from .models import DomainDeadline

logger = logging.getLogger(__name__)
_NAMESPACE = "porukam"
_LOOKBACK = timedelta(days=7)
# Последняя граница перед +Inf — 60 с — ровно SLO из tech-spec.md §11.
_BUCKETS_SECONDS = [5.0, 15.0, 30.0, 45.0, 60.0, 90.0, 120.0, 300.0, 600.0]


class SweepLagCollector(Collector):
    def describe(self):  # type: ignore[no-untyped-def]
        # Пустая гистограмма — только имя/тип для регистрации (см.
        # common/metrics.py про auto_describe=True), без запроса к БД.
        return [HistogramMetricFamily(f"{_NAMESPACE}_deadlines_sweep_lag_seconds", "")]

    def collect(self):  # type: ignore[no-untyped-def]
        try:
            lags = list(
                DomainDeadline.objects.filter(
                    fired_at__isnull=False,
                    fired_at__gte=timezone.now() - _LOOKBACK,
                )
                .annotate(
                    lag=ExpressionWrapper(
                        F("fired_at") - F("deadline_at"), output_field=DurationField()
                    )
                )
                .values_list("lag", flat=True)
            )
        except DjangoDBError:
            logger.warning("metrics: сбой запроса sweep lag дедлайнов", exc_info=True)
            return
        lag_seconds = [lag.total_seconds() for lag in lags if lag is not None]

        # Кумулятивно по определению формата Prometheus — каждый бакет
        # считает ВСЕ значения <= его границы, не только "новые" относительно
        # предыдущего бакета.
        buckets: list[tuple[str, int]] = [
            (str(boundary), sum(1 for value in lag_seconds if value <= boundary))
            for boundary in _BUCKETS_SECONDS
        ]
        buckets.append(("+Inf", len(lag_seconds)))

        metric = HistogramMetricFamily(
            f"{_NAMESPACE}_deadlines_sweep_lag_seconds",
            "Задержка срабатывания доменного дедлайна (fired_at - deadline_at), секунд.",
            buckets=buckets,
            sum_value=sum(lag_seconds),
        )
        yield metric


def register() -> None:
    REGISTRY.register(SweepLagCollector())
