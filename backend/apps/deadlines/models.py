"""tech-spec.md §2.5, §5.2.10 (domain_deadline); docs/tasks/fundament.md ЭФ.2;
docs/adr/ADR-072-domain-deadline-sweep.md.

DomainDeadline — единый реестр доменных тайм-аутов (приёмка, окна оспаривания,
потолок спора, окно выгрузки доказательств, истечение хранения), СТРОКИ В БД,
не отложенные Celery-задачи (CLAUDE.md, tech-spec.md §2.5): отложенная задача
теряется при сбое брокера, строка в БД — нет; ADR-039 требует массового
пересчёта при простое платформы, что нереализуемо через отложенные задачи.

DeadlineKindConfig — длительность по `kind` ("таблица категорий договоров с
юристом" — tech-spec.md §11 п.4). Схема §5.2.10 не даёт `domain_deadline`
измерения по юрисдикции (нет `country_code`), поэтому конфигурация — не
расширение apps.jurisdictions.JurisdictionConfig, а отдельная таблица
категорий здесь же (разбор — ADR-072)."""

from __future__ import annotations

from django.db import models
from django.db.models import Q

from common.uuid7 import uuid7


class DeadlineKindConfig(models.Model):
    """Длительность тайм-аута по категории (`kind`) — данные, не константа в
    коде (CLAUDE.md). Финальные значения — предмет согласования с юристом
    (tech-spec.md §11 п.4); здесь — значения, уже зафиксированные в спеке
    (§2.5, §5.2.10) как параметры категорий."""

    kind = models.CharField(max_length=64, primary_key=True)
    duration = models.DurationField()

    class Meta:
        db_table = "deadline_kind_config"
        verbose_name = "длительность категории дедлайна"
        verbose_name_plural = "длительности категорий дедлайнов"

    def __str__(self) -> str:
        return f"{self.kind} ({self.duration})"


class DomainDeadline(models.Model):
    """tech-spec.md §5.2.10. `kind` ссылается на DeadlineKindConfig.kind
    логически (по значению) — не FK: схема §5.2.10 держит `kind` как
    свободный текст, а обработчики срабатывания (этап 4) сами решают, что
    делать с конкретной категорией."""

    class StartsFrom(models.TextChoices):
        CABINET_PLACEMENT = "cabinet_placement", "Размещение в личном кабинете"
        EVENT = "event", "Событие"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    kind = models.CharField(max_length=64)
    subject_type = models.CharField(max_length=32)
    subject_id = models.UUIDField()

    starts_from = models.CharField(max_length=20, choices=StartsFrom.choices)
    # ADR-057: при starts_from=cabinet_placement anchor_at проставляется
    # только при размещении уведомления в ЛК (apps.notifications, ЭФ.4) —
    # до этого дедлайн существует, но не тикает (deadline_at IS NULL).
    anchor_at = models.DateTimeField(null=True, blank=True)
    deadline_at = models.DateTimeField(null=True, blank=True)
    # ADR-140: длительность КОНКРЕТНОГО дедлайна из условий договора (окно
    # приёмки `acceptance_window_hours` из form_data). NULL — длительность
    # категории из DeadlineKindConfig (дефолт для всех остальных). Хранится в
    # строке, а не вычисляется при анкоринге: договор к этому моменту уже мог
    # быть недоступен вызывающему коду (anchor_deadline знает только дедлайн).
    duration_override = models.DurationField(null=True, blank=True)

    paused = models.BooleanField(default=False)
    pause_reason = models.CharField(max_length=255, null=True, blank=True)

    fired_at = models.DateTimeField(null=True, blank=True)
    outcome = models.CharField(max_length=32, null=True, blank=True)

    class Meta:
        db_table = "domain_deadline"
        verbose_name = "доменный дедлайн"
        verbose_name_plural = "доменные дедлайны"
        constraints = [
            models.CheckConstraint(
                # Значения StartsFrom не видны из области Meta (вложенный
                # класс) — литералы дублируют choices намеренно.
                condition=Q(starts_from__in=["cabinet_placement", "event"]),
                name="domain_deadline_starts_from_valid",
            ),
        ]
        indexes = [
            # tech-spec.md §5.2.10: INDEX (deadline_at) WHERE fired_at IS
            # NULL AND paused = false — под выборку sweep'а.
            models.Index(
                fields=["deadline_at"],
                name="domain_deadline_due_idx",
                condition=Q(fired_at__isnull=True, paused=False),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.kind}:{self.subject_id}"
