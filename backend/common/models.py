"""Общая инфраструктура для всех apps.* (не bounded context — shared kernel,
вне графа контрактов import-linter, root_package = "apps"):

- OutboxEvent — транзакционный outbox для доменных событий (CLAUDE.md:
  "Приложения общаются ... через доменные события (transactional outbox)",
  реестр топиков — tech-spec.md §6.4). Запись — common.outbox.publish();
  доставка подписчикам — common.relay (ADR-064), реестр подписок в
  settings.OUTBOX_SUBSCRIBERS. published_at/delivery_attempts/next_attempt_at
  — служебные поля реле, не часть конверта события из §6.4.
- SubjectKey — KEK на субъект для envelope-шифрования ПД (ADR-035 внешнего
  журнала; локальная реализация — docs/adr/ADR-059-*.md). crypto-shredding
  = destroyed_at + обнуление kek_wrapped, см. common/crypto.py.
- IdempotencyKey — Idempotency-Key на денежных/подписных POST (CLAUDE.md,
  etap-4.md Э4.4). Хранит хеш тела первого запроса + сохранённый ответ:
  common/api/idempotency.py.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from .uuid7 import uuid7


class OutboxEvent(models.Model):
    event_id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    topic = models.CharField(max_length=200)
    occurred_at = models.DateTimeField()
    actor = models.JSONField(default=dict)
    subject = models.JSONField(default=dict)
    payload = models.JSONField(default=dict)
    schema_version = models.PositiveSmallIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    published_at = models.DateTimeField(null=True, blank=True)
    delivery_attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "outbox_event"
        verbose_name = "событие outbox"
        verbose_name_plural = "события outbox"
        indexes = [
            models.Index(fields=["topic", "occurred_at"]),
            models.Index(
                fields=["created_at"],
                name="outbox_event_unpubl_idx",
                condition=Q(published_at__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.topic} {self.event_id}"


class SubjectKey(models.Model):
    """KEK субъекта (пользователь/юрлицо/договор — subject_type), обёрнутый
    мастер-ключом (common.crypto._master_key). Один активный ключ на субъект:
    уникальность обеспечена частичным индексом (destroyed_at IS NULL).
    """

    id = models.BigAutoField(primary_key=True)
    subject_type = models.CharField(max_length=32)
    subject_id = models.CharField(max_length=64)
    kek_wrapped = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)
    destroyed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "subject_key"
        verbose_name = "ключ субъекта"
        verbose_name_plural = "ключи субъектов"
        constraints = [
            models.UniqueConstraint(
                fields=["subject_type", "subject_id"],
                condition=Q(destroyed_at__isnull=True),
                name="unique_active_subject_key",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.subject_type}:{self.subject_id}"


class TaskHeartbeat(models.Model):
    """Отметка "последний запуск" периодической Celery-задачи (docs/tasks/
    fundament-2.md ЭФ.6 п.2: лаг sweep'а, outbox — обнаружение остановки
    Celery beat). Пишется самой задачей на КАЖДЫЙ прогон (common.heartbeat.
    beat()), независимо от того, нашлось ли что обрабатывать — иначе на
    простое (нет просроченных дедлайнов/событий) метрика молчала бы точно
    так же, как при остановленном beat, и алёрт было бы нечем отличить.

    Читается common.metrics.HeartbeatCollector на каждый /metrics-скрейп
    ИЗ БД (не из памяти процесса-исполнителя) — задача выполняется в
    Celery worker, а метрику отдаёт core; общий durable-стейт в БД снимает
    вопрос "чей это процесс" полностью (в отличие от Prometheus Gauge в
    памяти воркера, который скрейпился бы из другого процесса)."""

    name = models.CharField(max_length=100, primary_key=True)
    last_run_at = models.DateTimeField()

    class Meta:
        db_table = "task_heartbeat"
        verbose_name = "отметка периодической задачи"
        verbose_name_plural = "отметки периодических задач"

    def __str__(self) -> str:
        return f"{self.name}@{self.last_run_at}"


class IdempotencyKey(models.Model):
    """Повторный вызов того же `endpoint` тем же пользователем с тем же
    заголовком `Idempotency-Key` и тем же телом запроса возвращает
    СОХРАНЁННЫЙ ответ первого вызова, не повторяя side-effects (денежные/
    подписные POST — CLAUDE.md, etap-4.md Э4.4). Тот же ключ с ДРУГИМ телом —
    ошибка (common/api/idempotency.py) — ключ не переиспользуется на другой
    запрос. `endpoint` — стабильный код действия (например
    `"contracts.sign"`), не URL с параметрами."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="idempotency_keys", on_delete=models.CASCADE
    )
    endpoint = models.CharField(max_length=100)
    key = models.CharField(max_length=200)
    request_hash = models.CharField(max_length=64)
    response_status = models.PositiveSmallIntegerField()
    response_body = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "idempotency_key"
        verbose_name = "ключ идемпотентности"
        verbose_name_plural = "ключи идемпотентности"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "endpoint", "key"], name="unique_idempotency_key_per_user_endpoint"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.endpoint}:{self.key}"
