"""tech-spec.md §5.2.1 (identity_verification), §9.1 (ADR-052); domain-model.md §3.1.

`provider` — код провайдера строгой идентификации (ADR-052): ядро не
оперирует словом «ЕСИА», только строковым кодом; конкретная реализация —
деталь apps.identity.providers.

`verified_full_name_encrypted` — ФИО, ПОДТВЕРЖДЁННОЕ провайдером, отдельно
от `user.full_name_encrypted` (самостоятельно указанное пользователем,
apps.accounts) — это разные вещи: одно заявлено, другое доказано. ПД —
envelope-шифрование (common/crypto.py) с первой миграции (CLAUDE.md).
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class IdentityVerification(models.Model):
    class Level(models.TextChoices):
        VERIFIED = "verified", "Верифицирован"

    class Status(models.TextChoices):
        PENDING = "pending", "В процессе"
        SUCCEEDED = "succeeded", "Успешно"
        FAILED = "failed", "Отклонено"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="identity_verifications",
        on_delete=models.CASCADE,
    )
    provider = models.CharField(max_length=32)
    level = models.CharField(max_length=16, choices=Level.choices)

    verified_full_name_encrypted = models.BinaryField(null=True, blank=True)
    encryption_key_ref = models.CharField(max_length=64, null=True, blank=True)
    verified_attributes = models.JSONField(default=dict, blank=True)

    verified_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "identity_verification"
        verbose_name = "верификация личности"
        verbose_name_plural = "верификации личности"

    def __str__(self) -> str:
        return f"{self.user_id}:{self.provider}:{self.status}"
