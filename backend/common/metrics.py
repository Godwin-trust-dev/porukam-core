"""Кастомные Prometheus-коллекторы общего ядра (docs/tasks/fundament-2.md
ЭФ.6 п.2). Каждый коллектор считает значение НА МОМЕНТ /metrics-скрейпа
прямым запросом к БД/памяти процесса — не накапливает счётчик по ходу
работы задач. Это сознательный выбор (см. docs/adr — ADR наблюдаемости):
sweep/relay выполняются в процессе Celery worker, а /metrics отдаёт core —
Prometheus Gauge/Counter в памяти воркера был бы невидим оттуда, куда
приходит скрейпер. Коллектор же читает ту же БД, что видят все процессы,
поэтому не зависит от того, какой процесс выполнил работу.

ВАЖНО: глобальный `prometheus_client.REGISTRY` создан с `auto_describe=True`
— `register()` вызывает `describe()` (а без него — `collect()`) СРАЗУ, чтобы
проверить имена метрик на дубликаты, то есть уже на старте процесса
(AppConfig.ready()), когда БД может быть ещё не готова (миграции не
накатаны/сеть недоступна). Поэтому у каждого коллектора есть `describe()`,
возвращающий пустые метрики (только имя/тип, без данных) — не трогает БД
вообще; а `collect()` (реальный скрейп) на всякий случай всё равно ловит
django.db.Error и молча отдаёт пустой набор метрик на этом скрейпе — те же
"без каскадного падения", что и config/health.py (ЭФ.6 п.5), только для
/metrics, а не для /v1/health.

register() вызывается один раз из CommonConfig.ready()."""

from __future__ import annotations

import logging

from django.conf import settings
from django.db import Error as DjangoDBError
from prometheus_client import REGISTRY
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.registry import Collector

from . import circuit
from .models import OutboxEvent, TaskHeartbeat

logger = logging.getLogger(__name__)
_NAMESPACE = "porukam"
_DEFAULT_QUEUES = ["celery"]


class OutboxBacklogCollector(Collector):
    """tech-spec.md §2.6/ЭФ.6 п.2: "счётчики outbox (неопубликованные,
    возраст старейшего)" — алёрт "outbox не разгребается > 5 мин"
    (docs/tasks/fundament-2.md ЭФ.6 п.3) стоит на возрасте старейшей
    неопубликованной записи."""

    def describe(self):  # type: ignore[no-untyped-def]
        return [
            GaugeMetricFamily(f"{_NAMESPACE}_outbox_unpublished_total", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_outbox_oldest_unpublished_age_seconds", ""),
        ]

    def collect(self):  # type: ignore[no-untyped-def]
        from django.utils import timezone

        try:
            unpublished = OutboxEvent.objects.filter(published_at__isnull=True)
            count = unpublished.count()
            oldest = unpublished.order_by("created_at").values_list("created_at", flat=True).first()
        except DjangoDBError:
            logger.warning("metrics: сбой запроса outbox backlog", exc_info=True)
            return
        age_seconds = (timezone.now() - oldest).total_seconds() if oldest is not None else 0.0

        count_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_outbox_unpublished_total",
            "Число ещё не доставленных всем подписчикам событий outbox.",
        )
        count_metric.add_metric([], count)
        yield count_metric

        age_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_outbox_oldest_unpublished_age_seconds",
            "Возраст самого старого недоставленного события outbox, секунд (0, если очередь пуста)",
        )
        age_metric.add_metric([], age_seconds)
        yield age_metric


class HeartbeatCollector(Collector):
    """Возраст последнего запуска периодических задач (common.heartbeat.beat,
    common.models.TaskHeartbeat) — универсальный "мертвецкий выключатель"
    под sweep/relay/checkpoint, ЭФ.6 п.2/3."""

    def describe(self):  # type: ignore[no-untyped-def]
        return [GaugeMetricFamily(f"{_NAMESPACE}_task_heartbeat_age_seconds", "", labels=["task"])]

    def collect(self):  # type: ignore[no-untyped-def]
        from django.utils import timezone

        try:
            rows = list(TaskHeartbeat.objects.values_list("name", "last_run_at"))
        except DjangoDBError:
            logger.warning("metrics: сбой запроса task heartbeat", exc_info=True)
            return

        metric = GaugeMetricFamily(
            f"{_NAMESPACE}_task_heartbeat_age_seconds",
            "Секунд с последнего запуска периодической задачи (по имени).",
            labels=["task"],
        )
        now = timezone.now()
        for name, last_run_at in rows:
            metric.add_metric([name], (now - last_run_at).total_seconds())
        yield metric


class ProviderCircuitCollector(Collector):
    """Заготовка под circuit breaker внешних провайдеров (common.circuit,
    tech-spec.md §9.3; ЭФ.6 п.2: "статусы фейк-провайдеров"). В памяти
    процесса, не в БД — DjangoDBError здесь не грозит."""

    def describe(self):  # type: ignore[no-untyped-def]
        return [
            GaugeMetricFamily(f"{_NAMESPACE}_provider_circuit_open", "", labels=["provider"]),
            GaugeMetricFamily(
                f"{_NAMESPACE}_provider_calls_total", "", labels=["provider", "outcome"]
            ),
        ]

    def collect(self):  # type: ignore[no-untyped-def]
        state_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_provider_circuit_open",
            "1, если circuit breaker провайдера разомкнут (заготовка — сейчас всегда 0).",
            labels=["provider"],
        )
        calls_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_provider_calls_total",
            "Число вызовов фейк-провайдера по итогу (заготовка под реальные метрики §9.3).",
            labels=["provider", "outcome"],
        )
        for provider, info in circuit.states().items():
            state_metric.add_metric([provider], 1 if info.state == circuit.OPEN else 0)
            calls_metric.add_metric([provider, "success"], info.successes)
            calls_metric.add_metric([provider, "failure"], info.failures)
        yield state_metric
        yield calls_metric


class CeleryQueueCollector(Collector):
    """tech-spec.md §11: "лаг очередей [Celery]" — глубина очереди в брокере
    (Redis LLEN), не время: список задач по имени/времени постановки Redis
    не хранит, а инструментировать это в самих задачах означало бы то же
    "метрика видна только в процессе воркера", от чего сознательно уходим
    здесь (см. докстринг модуля). Список очередей — settings.CELERY_METRICS_QUEUES
    (сейчас реально используется только "celery" — маршрутизации по очередям
    задач в CELERY_TASK_ROUTES ещё нет, см. ADR наблюдаемости)."""

    def describe(self):  # type: ignore[no-untyped-def]
        return [GaugeMetricFamily(f"{_NAMESPACE}_celery_queue_length", "", labels=["queue"])]

    def collect(self):  # type: ignore[no-untyped-def]
        import redis

        queues: list[str] = getattr(settings, "CELERY_METRICS_QUEUES", _DEFAULT_QUEUES)
        metric = GaugeMetricFamily(
            f"{_NAMESPACE}_celery_queue_length",
            "Число сообщений, ожидающих обработки в очереди Celery (брокер Redis).",
            labels=["queue"],
        )
        try:
            client = redis.Redis.from_url(settings.CELERY_BROKER_URL)
            for queue in queues:
                metric.add_metric([queue], client.llen(queue))
        except redis.RedisError:
            logger.warning("metrics: сбой запроса длины очередей Celery (Redis)", exc_info=True)
            return
        yield metric


def register() -> None:
    REGISTRY.register(OutboxBacklogCollector())
    REGISTRY.register(HeartbeatCollector())
    REGISTRY.register(ProviderCircuitCollector())
    REGISTRY.register(CeleryQueueCollector())
