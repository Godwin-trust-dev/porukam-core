"""Метрики Celery worker'а (tech-spec.md §11: "лаг очередей", RED-подобные
метрики задач; docs/tasks/fundament-2.md ЭФ.6 п.2; ADR-068).

`PROMETHEUS_MULTIPROC_DIR` уже должен быть в `os.environ` к моменту, когда
выполняется этот модуль — переменную выставляет `config/celery.py` ПО ARGV,
раньше любых импортов (`prometheus_client` решает, писать ли метрики в
файловом режиме, ОДИН РАЗ при первом импорте `prometheus_client.values` в
процессе — выставлять переменную здесь было бы уже поздно: `django.setup()`,
вызываемый из `app.autodiscover_tasks()` в config/celery.py, транзитивно
импортирует `prometheus_client` через `AppConfig.ready()` до того, как
успеет сработать `celery.signals.worker_init`, к которому привязан `setup()`
ниже). Сюда переменная приходит уже готовой — читаем, не выставляем.

`setup()` подключён к `celery.signals.worker_init`, который физически
срабатывает ТОЛЬКО при старте настоящего процесса `celery worker`
(bootstep-последовательность) — импорт объекта `Celery()` сам по себе его
не создаёт. Поэтому объекты Counter/Histogram и HTTP-сервер метрик
создаются ЛЕНИВО внутри `setup()`, а не на уровне модуля — иначе они
существовали бы и в core/тестах (тот же процесс импортирует этот модуль
просто следуя import config -> config.celery).

Celery worker с дефолтным prefork-пулом — НЕСКОЛЬКО процессов; Counter/
Histogram в памяти одного из них не видны остальным. Файловый режим
prometheus_client (каждый child пишет свою mmap-копию) решает эту часть;
`start_metrics_server()` (вызывается из того же `setup()`, в родительском
процессе, ДО форка пула) агрегирует файлы и отдаёт их на отдельном порту
(METRICS_PORT, по умолчанию 9808) — Prometheus скрейпит его как отдельный
target, НЕ /metrics core (infra/compose/monitoring/prometheus.yml)."""

from __future__ import annotations

import logging
import os
import shutil
import time
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_MULTIPROC_DIR = "/tmp/porukam-prometheus-multiproc"
_DEFAULT_METRICS_PORT = 9808

_task_started_at: dict[str, float] = {}
_task_total: Any = None
_task_duration: Any = None


def _reset_multiproc_dir(directory: str) -> None:
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory, exist_ok=True)


def _on_task_prerun(task_id: str, task: Any, **kwargs: Any) -> None:
    _task_started_at[task_id] = time.monotonic()


def _on_task_postrun(task_id: str, task: Any, state: str = "", **kwargs: Any) -> None:
    started_at = _task_started_at.pop(task_id, None)
    if started_at is not None and _task_duration is not None:
        _task_duration.labels(task=task.name).observe(time.monotonic() - started_at)
    if _task_total is not None:
        _task_total.labels(task=task.name, state=state or "UNKNOWN").inc()


def _on_task_failure(task_id: str, sender: Any = None, **kwargs: Any) -> None:
    _task_started_at.pop(task_id, None)
    if _task_total is not None:
        _task_total.labels(task=getattr(sender, "name", "unknown"), state="FAILURE").inc()


def setup(**_kwargs: Any) -> None:
    """Обработчик `celery.signals.worker_init` — см. докстринг модуля:
    выполняется РОВНО ОДИН РАЗ в родительском процессе воркера, до форка
    prefork-пула. Идемпотентен (Celery может отправить сигнал единожды за
    процесс, но повторный вызов не должен пересоздавать метрики)."""
    global _task_total, _task_duration
    if _task_total is not None:
        return

    directory = os.environ.get("PROMETHEUS_MULTIPROC_DIR", _DEFAULT_MULTIPROC_DIR)
    _reset_multiproc_dir(directory)

    from celery.signals import task_failure, task_postrun, task_prerun
    from prometheus_client import (
        CollectorRegistry,
        Counter,
        Histogram,
        multiprocess,
        start_http_server,
    )

    namespace = "porukam"
    _task_total = Counter(
        f"{namespace}_celery_task_total",
        "Число выполненных задач Celery по итоговому статусу.",
        ["task", "state"],
    )
    _task_duration = Histogram(
        f"{namespace}_celery_task_duration_seconds",
        "Время выполнения задачи Celery, секунд.",
        ["task"],
    )

    task_prerun.connect(_on_task_prerun, weak=False)
    task_postrun.connect(_on_task_postrun, weak=False)
    task_failure.connect(_on_task_failure, weak=False)

    port = int(os.environ.get("METRICS_PORT", _DEFAULT_METRICS_PORT))
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
    try:
        start_http_server(port, registry=registry)
    except OSError:
        logger.warning("celery_metrics: порт %s уже занят, /metrics не поднят", port)
