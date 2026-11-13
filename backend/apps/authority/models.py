"""tech-spec.md §5.2.2 (representative, signing_authority,
contract_assignment), §8.2; domain-model.md §4 (ПОЛНОМОЧИЯ); docs/tasks/
etap-3.md 3.5; ADR-004 внешнего журнала (запрет ручной экспертизы для форм
с разделённой собственностью).

`business_entity` — реальный FK на `apps.entities.BusinessEntity` (обычный
Python-импорт в services.py, не строка): в отличие от `apps.notifications`/
`apps.profiles`, где связь с чужой моделью — единственная точка касания,
apps.authority ЦЕЛИКОМ работает с BusinessEntity (гейт assert_entity_operable,
has_separated_ownership, claim_status) — граница здесь через
services.py/models.py apps.entities, не через избегание импорта модели
(CLAUDE.md допускает и то, и другое — «через services.py-фасады и доменные
события», FK как таковой это не запрещает, когда приложения и так тесно
связаны по домену; import-linter не ограничивает apps.authority).

`basis` — значения ДОСЛОВНО из tech-spec.md §8.2 (`"registry_verified_director"`
и т.д.), а не из domain-model.md §4 SigningBasis (`"registry_director"`) —
при расхождении спека первична (CLAUDE.md).

`contract_id` на ContractAssignment — БЕЗ FK: apps.contracts ещё не
существует (etap 4). Обычный UUIDField до тех пор, пока контракт не
появится — тогда добавится настоящая FK новой миграцией (не редактируем эту).
"""

from __future__ import annotations

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models

from common.uuid7 import uuid7


class Representative(models.Model):
    """Операционный доступ к работе от имени юрлица. НИЗКИЙ риск — право
    подписи сюда НЕ входит (см. SigningAuthority)."""

    class Role(models.TextChoices):
        ADMINISTRATOR = "administrator", "Администратор"
        MANAGER = "manager", "Менеджер"
        MEMBER = "member", "Участник"

    class Permission(models.TextChoices):
        """Источник истины для проверок доступа — ТОЛЬКО по значениям этого
        поля, роль (Role) — лишь пресет для UI."""

        COMMUNICATE = "communicate", "Переписка"
        MANAGE_CHECKLIST = "manage_checklist", "Управление чек-листом"
        UPLOAD_EVIDENCE = "upload_evidence", "Загрузка доказательств"
        CONFIRM_MILESTONE = "confirm_milestone", "Подтверждение этапа"
        MANAGE_PROFILE = "manage_profile", "Управление профилем"
        MANAGE_REPRESENTATIVES = "manage_representatives", "Управление представителями"
        RESPOND_DISPUTE = "respond_dispute", "Ответ по спору"

    # Пресеты Role -> Permission (данные, не жёсткая проверка — permissions
    # хранится явно на записи и может быть скорректирован вручную; пресет
    # только заполняет значение по умолчанию при выдаче, CLAUDE.md: «проверки
    # ТОЛЬКО по permissions»).
    ROLE_PRESETS: dict[str, tuple[str, ...]] = {
        Role.ADMINISTRATOR: tuple(Permission.values),
        Role.MANAGER: (
            Permission.COMMUNICATE,
            Permission.MANAGE_CHECKLIST,
            Permission.UPLOAD_EVIDENCE,
            Permission.CONFIRM_MILESTONE,
            Permission.RESPOND_DISPUTE,
        ),
        Role.MEMBER: (Permission.COMMUNICATE, Permission.UPLOAD_EVIDENCE),
    }

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="representations", on_delete=models.CASCADE
    )
    business_entity = models.ForeignKey(
        "entities.BusinessEntity", related_name="representatives", on_delete=models.CASCADE
    )
    role = models.CharField(max_length=16, choices=Role.choices)
    permissions = ArrayField(
        models.CharField(max_length=32, choices=Permission.choices), default=list
    )
    is_active = models.BooleanField(default=True)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="approved_representatives",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "representative"
        verbose_name = "представитель"
        verbose_name_plural = "представители"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "business_entity"], name="unique_representative_user_entity"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user_id}@{self.business_entity_id}:{self.role}"

    def can(self, permission: str) -> bool:
        return self.is_active and permission in self.permissions


class SigningAuthority(models.Model):
    """Право юридически подписывать договор от имени юрлица. ВЫСОКИЙ риск —
    отдельно от Representative (domain-model.md §4)."""

    class Basis(models.TextChoices):
        REGISTRY_VERIFIED_DIRECTOR = "registry_verified_director", "Директор по реестру"
        NOTARIZED_POA = "notarized_poa", "Нотариальная доверенность"
        CHAINED_DELEGATION = "chained_delegation", "Цепочка передоверия"
        MANUAL_REVIEW = "manual_review", "Ручная экспертиза"

    # Основания, требующие перепроверки по реестру МЧД при КАЖДОМ подписании
    # (is_valid_now, domain-model.md §4).
    POA_VERIFIED_BASES: tuple[str, ...] = (Basis.NOTARIZED_POA, Basis.CHAINED_DELEGATION)

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="signing_authorities", on_delete=models.CASCADE
    )
    business_entity = models.ForeignKey(
        "entities.BusinessEntity", related_name="signing_authorities", on_delete=models.CASCADE
    )
    basis = models.CharField(max_length=32, choices=Basis.choices)
    max_amount_value = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    max_amount_currency = models.CharField(max_length=3, null=True, blank=True)
    poa_registry_id = models.CharField(max_length=64, blank=True, default="")
    parent_authority = models.ForeignKey(
        "self", null=True, blank=True, related_name="delegations", on_delete=models.SET_NULL
    )
    last_verified_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "signing_authority"
        verbose_name = "право подписи"
        verbose_name_plural = "права подписи"
        constraints = [
            # Деньги — всегда пара (CLAUDE.md): оба поля NULL (безлимит) либо
            # оба заданы, никогда одно без другого.
            models.CheckConstraint(
                condition=(
                    models.Q(max_amount_value__isnull=True, max_amount_currency__isnull=True)
                    | models.Q(max_amount_value__isnull=False, max_amount_currency__isnull=False)
                ),
                name="signing_authority_max_amount_pair",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user_id}@{self.business_entity_id}:{self.basis}"


class ContractAssignment(models.Model):
    """Кто из представителей закреплён за договором/этапами — начинает
    реально использоваться в apps.evidence (etap-3.md 3.5). `contract_id` —
    см. докстринг модуля (contracts ещё не существует)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    representative = models.ForeignKey(
        Representative, related_name="contract_assignments", on_delete=models.CASCADE
    )
    contract_id = models.UUIDField()
    milestone_ids = ArrayField(models.UUIDField(), null=True, blank=True)
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="granted_assignments", on_delete=models.PROTECT
    )
    valid_from = models.DateTimeField()
    valid_until = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "contract_assignment"
        verbose_name = "назначение на договор"
        verbose_name_plural = "назначения на договор"
        indexes = [
            models.Index(fields=["contract_id"]),
        ]

    def __str__(self) -> str:
        return f"{self.representative_id}@{self.contract_id}"
