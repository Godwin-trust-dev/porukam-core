"""tech-spec.md §5.2.2 (business_entity, tax_identifier, ownership_epoch),
§8.2; domain-model.md §3.2, §3.2.1, §3.2.2, §5 (эпохи владения).

Р1-решение по открытому вопросу №3 спеки (docs/tasks/etap-3.md 3.4,
docs/adr/ADR-063-*.md): модель claim остаётся ПОЛНОЙ (весь `ClaimMethod` из
domain-model.md §3.2.2), но флоу реализованы только для
`DIRECTOR_IDENTITY_MATCH`, `OWNER_IDENTITY_MATCH` (авто, apps.entities.
services.try_auto_claim) и `MANUAL_REVIEW` (заявка в очередь для backoffice, без
UI оператора — см. `IMPLEMENTED_CLAIM_METHODS`). Остальные значения enum
существуют, но `claim-methods` показывает их как «скоро».

`local_form_code` — код формы РФ ("ru_ooo"/"ru_ip"/"ru_self_employed").
Полноценный справочник `LocalEntityForm` (jurisdictions) в кодовой базе пока
не построен (apps/jurisdictions/models.py содержит тот же комментарий) —
здесь это простой текстовый код, а `OWNER_CLAIMABLE_FORMS` — фиксированный
список кодов, а не FK на каталог. Разбор этого решения — ADR-063.

`director_full_name` — из ПУБЛИЧНОГО реестра (ЕГРЮЛ/ЕГРИП), поэтому БЕЗ
envelope-шифрования, в отличие от ПД физлица (совпадает со схемой
tech-spec.md, где поле — без суффикса `_encrypted`). `bank_details_encrypted`
— единственное ПД-поле этой модели, envelope-шифрование с первой миграции
(CLAUDE.md, ADR-035 / docs/adr/ADR-059-*.md).
"""

from __future__ import annotations

from typing import ClassVar

from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeOperators
from django.db import models
from django.db.models import Func

from common.uuid7 import uuid7


class TsTzRange(Func):
    """`tstzrange(started_at, ended_at)` — для EXCLUDE-констрейнта
    OwnershipEpoch (upper=NULL у Postgres означает «не ограничено сверху»,
    что и нужно для текущей активной эпохи)."""

    function = "TSTZRANGE"
    output_field = DateTimeRangeField()


class BusinessEntity(models.Model):
    class VerificationStatus(models.TextChoices):
        DRAFT = "draft", "Черновик"
        VERIFIED = "verified", "Сверено с реестром"

    class ClaimStatus(models.TextChoices):
        UNCLAIMED = "unclaimed", "Контроль не подтверждён"
        PENDING = "pending", "На рассмотрении"
        CLAIMED = "claimed", "Подтверждено"
        DISPUTED = "disputed", "Оспаривается"

    class ClaimMethod(models.TextChoices):
        """Порядок — по убыванию силы и автоматизируемости (domain-model.md
        §3.2.2). Флоу реализованы только для первых трёх — см.
        `IMPLEMENTED_CLAIM_METHODS` и docstring модуля."""

        DIRECTOR_IDENTITY_MATCH = (
            "director_identity_match",
            "Директор по реестру = верифицированный пользователь",
        )
        OWNER_IDENTITY_MATCH = "owner_identity_match", "ИНН физлица = ИНН ИП/СМЗ"
        MANUAL_REVIEW = "manual_review", "Ручная экспертиза"
        ORGANIZATION_ESIGNATURE = "organization_esignature", "ЭП организации"
        NOTARIZED_POA = "notarized_poa", "Нотариальная доверенность"
        BANK_ACCOUNT_PROOF = "bank_account_proof", "Контрольный платёж со счёта компании"
        POSTAL_TO_LEGAL_ADDRESS = "postal_to_legal_address", "Код письмом на юр. адрес"

    OWNER_CLAIMABLE_FORMS: ClassVar[frozenset[str]] = frozenset({"ru_ip", "ru_self_employed"})
    # domain-model.md §3.2 (LocalEntityForm.has_separated_ownership), etap-3.md
    # 3.5 / docs/tasks/etap-3-delta-adr059.md: формы, где роли владельца и
    # исполнителя юридически разделены -> ручная экспертиза (MANUAL_REVIEW) как
    # основание SigningAuthority ЗАПРЕЩЕНА (ADR-004 внешнего журнала,
    # apps.authority.services.grant_signing_authority). Тот же приём
    # упрощения, что OWNER_CLAIMABLE_FORMS — полноценного справочника
    # LocalEntityForm в кодовой базе пока нет (см. докстринг модуля, ADR-063).
    SEPARATED_OWNERSHIP_FORMS: ClassVar[frozenset[str]] = frozenset({"ru_ooo"})
    IMPLEMENTED_CLAIM_METHODS: ClassVar[frozenset[str]] = frozenset(
        {
            ClaimMethod.DIRECTOR_IDENTITY_MATCH,
            ClaimMethod.OWNER_IDENTITY_MATCH,
            ClaimMethod.MANUAL_REVIEW,
        }
    )

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    country_of_registration = models.CharField(max_length=2)
    local_form_code = models.CharField(max_length=32)
    tax_regime_code = models.CharField(max_length=32, blank=True, default="")

    name = models.CharField(max_length=300)
    short_name = models.CharField(max_length=150, blank=True, default="")
    registered_address = models.JSONField(default=dict, blank=True)
    bank_details_encrypted = models.BinaryField(null=True, blank=True)
    encryption_key_ref = models.CharField(max_length=64, null=True, blank=True)

    verification_status = models.CharField(
        max_length=16, choices=VerificationStatus.choices, default=VerificationStatus.DRAFT
    )
    verified_against_registry = models.BooleanField(default=False)
    verified_at = models.DateTimeField(null=True, blank=True)

    claim_status = models.CharField(
        max_length=16, choices=ClaimStatus.choices, default=ClaimStatus.UNCLAIMED
    )
    claimed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="claimed_entities",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    claim_method = models.CharField(
        max_length=32, choices=ClaimMethod.choices, null=True, blank=True
    )
    claimed_at = models.DateTimeField(null=True, blank=True)

    director_full_name = models.CharField(max_length=300, blank=True, default="")
    director_position_label = models.CharField(max_length=150, blank=True, default="")
    director_since = models.DateField(null=True, blank=True)
    director_source = models.CharField(max_length=32, blank=True, default="registry")
    director_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="directed_entities",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="created_entities", on_delete=models.PROTECT
    )

    class Meta:
        db_table = "business_entity"
        verbose_name = "юрлицо"
        verbose_name_plural = "юрлица"

    def __str__(self) -> str:
        return self.name

    def has_separated_ownership(self) -> bool:
        return self.local_form_code in self.SEPARATED_OWNERSHIP_FORMS


class TaxIdentifier(models.Model):
    class IdType(models.TextChoices):
        INN = "inn", "ИНН"

    entity = models.ForeignKey(
        BusinessEntity, related_name="tax_identifiers", on_delete=models.CASCADE
    )
    id_type = models.CharField(max_length=16, choices=IdType.choices)
    value = models.CharField(max_length=32)

    class Meta:
        db_table = "tax_identifier"
        verbose_name = "налоговый идентификатор"
        verbose_name_plural = "налоговые идентификаторы"
        constraints = [
            models.UniqueConstraint(fields=["id_type", "value"], name="unique_tax_identifier"),
        ]

    def __str__(self) -> str:
        return f"{self.id_type}:{self.value}"


class OwnershipEpoch(models.Model):
    class DetectedVia(models.TextChoices):
        INITIAL_VERIFICATION = "initial_verification", "Первичная верификация"
        SCHEDULED_REGISTRY_CHECK = "scheduled_registry_check", "Плановая сверка с реестром"

    entity = models.ForeignKey(
        BusinessEntity, related_name="ownership_epochs", on_delete=models.CASCADE
    )
    epoch_number = models.PositiveIntegerField()
    director_identity_hash = models.CharField(max_length=128, blank=True, default="")
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    detected_via = models.CharField(max_length=32, choices=DetectedVia.choices)
    reputation_snapshot = models.JSONField(null=True, blank=True)
    contracts_count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "ownership_epoch"
        verbose_name = "эпоха владения"
        verbose_name_plural = "эпохи владения"
        ordering: ClassVar[list[str]] = ["entity_id", "epoch_number"]
        constraints = [
            # Эпохи одного юрлица не пересекаются во времени (tech-spec.md
            # §5.2.2); требует расширения btree_gist (миграция 0001).
            ExclusionConstraint(
                name="ownership_epoch_no_overlap",
                expressions=[
                    (TsTzRange("started_at", "ended_at"), RangeOperators.OVERLAPS),
                    ("entity", RangeOperators.EQUAL),
                ],
            ),
        ]

    def __str__(self) -> str:
        return f"{self.entity_id}#{self.epoch_number}"
