"""tech-spec.md §4 (`warranty` — «Гарантийные периоды и заявки»), §5.2.7
(`warranty_claim`); domain-model.md §12; ADR-029 (срок — по согласованию, с
рекомендацией по юрисдикции), ADR-030 (гарантийные обращения НЕ пересчитывают
рейтинг задним числом — отдельная метрика).

Почему отдельное приложение, а не таблица в `apps.disputes` (разбор —
ADR-131): гарантийная претензия и разногласие — разные юридические факты с
разной судьбой в репутации. Спор идёт в две оси карточки (ГВ.4), претензия —
в СВОЙ счётчик и рейтинг не трогает (ADR-030). Держать их одной таблицей
значило бы каждый раз помнить «а это тот Dispute, который в рейтинг не
считается». Диалоговый контур при этом ОДИН: претензия открывает
`Dispute(kind=warranty)` в apps.disputes (раунды исправления там неприменимы,
а окно ответа, потолок 30 дней и закрытие — те же)."""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.disputes.models import MAX_FIX_ROUNDS
from common.uuid7 import uuid7


class WarrantyClaim(models.Model):
    """`warranty_claim(id, contract_id FK, description, evidence uuid[],
    status, resolution_type NULL)` из tech-spec.md §5.2.7.

    `dispute_id` — по значению, БЕЗ FK: apps.warranty зависит от
    apps.disputes только через services-фасад (CLAUDE.md: «приложения
    общаются через services.py-фасады»), жёсткая FK сделала бы связь
    схемной, а не сервисной.

    ADR-133 (подтверждение претензии заказчиком): `awaiting_confirmation` —
    исполнитель сообщил об устранении (`WarrantyFix`), идёт окно
    подтверждения (`acceptance_deadline_id` — строка `DomainDeadline`
    kind=`warranty_claim_acceptance`, по значению, как `dispute_id`); молчание
    заказчика в окно = авто-`warranty_satisfied` (как автоприёмка этапа).
    `fix_rounds_used` — число возражений заказчика «не устранено», потолок
    тот же `MAX_FIX_ROUNDS`, что у раундов спора по этапу, и тоже
    CHECK-констрейнтом (литерал 2 — значение уходит в миграцию).

    Дополнение 26.08: `resolved_by` — кто закрыл претензию (заказчик —
    подтвердил, исполнитель — отказал, сторона, закрывшая спор общим
    `/resolve`); `resolved_auto` — закрыта системой без действия сторон
    (истекло окно подтверждения — `warranty.claim_auto_satisfied`, либо
    потолок спора `cap_reached`), тогда `resolved_by` пуст (CHECK). Фронт
    показывает «закрыта автоматически по истечении окна» по этому полю, а не
    вычисляет из событий outbox (те чистятся)."""

    class Status(models.TextChoices):
        SUBMITTED = "submitted", "Подана"
        AWAITING_CONFIRMATION = "awaiting_confirmation", "Ждёт подтверждения заказчика"
        RESOLVED = "resolved", "Закрыта"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="warranty_claims", on_delete=models.CASCADE
    )
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    description = models.TextField()
    evidence = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.SUBMITTED)
    resolution_type = models.CharField(max_length=32, blank=True, default="")
    dispute_id = models.UUIDField(null=True, blank=True)
    fix_rounds_used = models.PositiveSmallIntegerField(default=0)
    acceptance_deadline_id = models.UUIDField(null=True, blank=True)
    fix_submitted_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    resolved_auto = models.BooleanField(default=False)

    class Meta:
        db_table = "warranty_claim"
        verbose_name = "гарантийная заявка"
        verbose_name_plural = "гарантийные заявки"
        ordering = ["-submitted_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(status="resolved", resolved_at__isnull=False)
                    | Q(
                        status__in=["submitted", "awaiting_confirmation"],
                        resolved_at__isnull=True,
                        resolution_type="",
                    )
                ),
                name="warranty_claim_resolved_has_date",
            ),
            # ADR-133: потолок возражений «не устранено» — тот же, что у
            # раундов исправления спора (dispute_fix_rounds_within_cap).
            models.CheckConstraint(
                condition=Q(fix_rounds_used__lte=2),
                name="warranty_claim_fix_rounds_within_cap",
            ),
            # Окно подтверждения есть ровно у претензии в awaiting_confirmation.
            models.CheckConstraint(
                condition=(
                    Q(status="awaiting_confirmation", fix_submitted_at__isnull=False)
                    | ~Q(status="awaiting_confirmation")
                ),
                name="warranty_claim_awaiting_has_fix_submitted_at",
            ),
            # Автозакрытие — только у закрытой претензии и без актора.
            models.CheckConstraint(
                condition=(Q(resolved_auto=False) | Q(status="resolved", resolved_by__isnull=True)),
                name="warranty_claim_auto_resolution_has_no_actor",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.status}"

    @property
    def fix_rounds_left(self) -> int:
        return max(MAX_FIX_ROUNDS - self.fix_rounds_used, 0)


class WarrantyFix(models.Model):
    """Цикл «устранил -> подтвердил / не устранено» по претензии (ADR-133) —
    зеркало `apps.disputes.FixRequest`, но с обратным порядком действий: у
    спора по этапу заказчик сначала ПРОСИТ исправить, у претензии сам факт
    претензии и есть просьба, поэтому раунд открывает ИСПОЛНИТЕЛЬ
    (`submitted_at`), а закрывает заказчик возражением (`contested_at`) либо
    подтверждением/авто-подтверждением (тогда `contested_at` пуст и
    претензия закрыта). `round` = `fix_rounds_used + 1` на момент сдачи:
    первая сдача — раунд 1, после первого «не устранено» — раунд 2, после
    второго — раунд 3 (последний: третье возражение — `409
    fix_rounds_exhausted`, дальше отказ исполнителя, суд, потолок).

    Текст и доказательства хранятся строкой, а не только в payload события:
    outbox — техническая таблица реле, источником правды о том, что сторона
    заявила, быть не может (ADR-131, дополнение 26.08 про `DisputeReply`).
    `evidence` — тот же формат, что у `WarrantyClaim.evidence`."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    claim = models.ForeignKey(WarrantyClaim, related_name="fixes", on_delete=models.CASCADE)
    round = models.PositiveSmallIntegerField()
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    comment = models.TextField(blank=True, default="")
    evidence = models.JSONField(default=list, blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    contested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    contest_comment = models.TextField(blank=True, default="")
    contest_evidence = models.JSONField(default=list, blank=True)
    contested_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "warranty_fix"
        verbose_name = "устранение по гарантийной претензии"
        verbose_name_plural = "устранения по гарантийной претензии"
        ordering = ["claim_id", "round"]
        constraints = [
            models.UniqueConstraint(fields=["claim", "round"], name="warranty_fix_round_unique"),
            # Раундов сдачи не больше, чем возражений + 1 (литерал = MAX_FIX_ROUNDS + 1).
            models.CheckConstraint(
                condition=Q(round__gte=1) & Q(round__lte=3),
                name="warranty_fix_round_within_cap",
            ),
            models.CheckConstraint(
                condition=(
                    Q(contested_at__isnull=False, contested_by__isnull=False)
                    | Q(contested_at__isnull=True, contested_by__isnull=True)
                ),
                name="warranty_fix_contest_has_author",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.claim_id}:{self.round}"
