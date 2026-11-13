"""Audit Vault — модели (tech-spec.md §5.2.10, §10.3; ADR-038;
docs/adr/ADR-065-*.md). Живут на отдельной БД `audit` — маршрутизация:
common.db_routers.AuditVaultRouter (по app_label="audit_vault", см.
services/audit_vault/apps.py). Другие приложения НЕ импортируют эти модели
напрямую — только через services.audit_vault.api (append/verify_chain/read)
и фасад apps.audit.client.
"""

from __future__ import annotations

from django.db import models
from django.db.models import Q


class AuditEntry(models.Model):
    """Одна запись хеш-цепочки. `this_hash = sha256(prev_hash ||
    canonical(entry))` (services/audit_vault/canonical.py) — неизменяема
    после записи; изменений/удалений строк в обычной работе не бывает
    (append-only, отсюда и название)."""

    seq = models.BigAutoField(primary_key=True)
    actor = models.JSONField(default=dict)
    actor_role = models.CharField(max_length=32)
    action = models.CharField(max_length=200)
    target_type = models.CharField(max_length=64)
    target_id = models.CharField(max_length=64)
    payload = models.JSONField(default=dict)
    at = models.DateTimeField()
    prev_hash = models.CharField(max_length=64)
    this_hash = models.CharField(max_length=64, unique=True)

    # Не входит в состав tech-spec.md §5.2.10 audit_entry — служебное поле
    # дедупликации (ADR-064: "идемпотентность подписчиков — event_id — ключ
    # дедупликации"), не участвует в canonical(entry)/хеш-цепочке.
    source_event_id = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "audit_entry"
        verbose_name = "запись Audit Vault"
        verbose_name_plural = "записи Audit Vault"
        ordering = ["seq"]
        indexes = [
            models.Index(fields=["target_type", "target_id"]),
            models.Index(fields=["action"]),
            models.Index(
                fields=["source_event_id"],
                name="audit_entry_event_id_idx",
                condition=Q(source_event_id__isnull=False),
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["source_event_id"],
                condition=Q(source_event_id__isnull=False),
                name="unique_audit_entry_source_event_id",
            ),
        ]

    def __str__(self) -> str:
        return f"#{self.seq} {self.action}"


class AuditCheckpoint(models.Model):
    """Ежесуточный якорь цепочки (tech-spec.md §10.3, ADR-135): диапазон
    [seq_from, seq_to], корень `digest` (this_hash последней записи,
    алгоритм — поле `alg`, не константа), метки времени RFC 3161 —
    `timestamps` (список слоёв: .tsr + цепочка сертификатов + OCSP/CRL на
    момент штампования, формат — services/audit_vault/checkpoint.py),
    `tsa_status` — семантика кворума (attested | unattested | fake),
    `host_id` — идентификатор хоста из env, и ключ объекта в бакете с Object
    Lock, куда выгружен тот же checkpoint вместе с листьями
    (services/audit_vault/storage.py)."""

    TSA_STATUS_CHOICES = [
        ("attested", "заверен (кворум TSA достигнут)"),
        ("unattested", "не заверен (недобор кворума TSA)"),
        ("fake", "фейковая метка (dev/test)"),
    ]

    id = models.BigAutoField(primary_key=True)
    seq_from = models.BigIntegerField()
    seq_to = models.BigIntegerField()
    digest = models.CharField(max_length=64)
    alg = models.CharField(max_length=16, default="sha256")
    host_id = models.CharField(max_length=128, blank=True, default="")
    tsa_status = models.CharField(max_length=16, choices=TSA_STATUS_CHOICES, default="fake")
    timestamps = models.JSONField(default=list)
    tsa_failures = models.JSONField(default=list)
    object_key = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "audit_checkpoint"
        verbose_name = "checkpoint Audit Vault"
        verbose_name_plural = "checkpoint'ы Audit Vault"
        ordering = ["-seq_to"]
        constraints = [
            models.UniqueConstraint(fields=["seq_to"], name="unique_audit_checkpoint_seq_to"),
        ]

    def __str__(self) -> str:
        return f"checkpoint [{self.seq_from}, {self.seq_to}]"


class ChainVerificationRun(models.Model):
    """Результат периодического api.verify_chain() (docs/tasks/fundament-2.md
    ЭФ.6 п.3: "разрыв цепочки Vault — экспорт результата verify_chain по
    расписанию") — services/audit_vault/tasks.py:export_chain_verification.
    Читается services/audit_vault/metrics.py на каждый /metrics-скрейп: сам
    verify_chain() — дорогая операция (пересчёт хеша каждой записи), гонять
    её на каждый скрейп Prometheus (раз в 10-15 с) недопустимо, поэтому
    задача считает её РЕДКО (расписание в CELERY_BEAT_SCHEDULE) и кладёт
    результат сюда, а метрика отдаёт последнюю сохранённую строку."""

    id = models.BigAutoField(primary_key=True)
    ok = models.BooleanField()
    entries_checked = models.PositiveIntegerField()
    first_broken_seq = models.BigIntegerField(null=True, blank=True)
    verified_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "audit_chain_verification_run"
        verbose_name = "прогон проверки цепочки Vault"
        verbose_name_plural = "прогоны проверки цепочки Vault"
        ordering = ["-verified_at"]

    def __str__(self) -> str:
        return f"verify@{self.verified_at} ok={self.ok}"
