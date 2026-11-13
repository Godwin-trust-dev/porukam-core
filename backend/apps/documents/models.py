"""tech-spec.md §4 (`documents` — "Договорные PDF, закрывающие документы,
провайдеры", модель `Document`); domain-model.md §14. Полноценный контур
(шифрование `file_encrypted`/`encryption_key_ref`, delegированная офлайн-
съёмка, DeviceKey, окно выгрузки) — этап 6/ГВ.3 (evidence ingest, отдельный
периферийный сервис, CLAUDE.md).

Э4.6 (docs/tasks/etap-4.md): «формальная сдача submit только с покрытием
required_evidence (доказательства — файлы-заглушки через существующую
загрузку документов)». До этой ветки `apps.documents` был пустым каркасом
(зарезервированное имя bounded context, tech-spec.md §4) — здесь заводится
МИНИМАЛЬНАЯ версия `Document`: ссылка + хеш-заглушка (клиент передаёт
`file_name`/`file_hash`, реальной загрузки байт и шифрования нет — этим
занимается evidence ingest на этапе 6). Модель уже держит правильную форму
связей (`contract`/`milestone`/`checklist_item`), чтобы полный контур
эволюционировал без миграции ядра (тот же приём, что `form_data` в
apps.contracts, etap-4.md «Общие требования»)."""

from __future__ import annotations

from django.conf import settings
from django.db import models

from common.uuid7 import uuid7


class Document(models.Model):
    """Файл-заглушка, приложенный как доказательство к пункту чек-листа
    (или к листу целиком — `checklist_item=None`, свободное приложение).
    `file_hash` — то, что доказательство должно нести бессрочно даже после
    исчезновения самого файла (domain-model.md §14 `Document.file_hash`);
    здесь клиент передаёт его сам (честная заглушка — реального контроля
    целостности загрузки нет до этапа 6)."""

    class Kind(models.TextChoices):
        EVIDENCE = "evidence", "Доказательство сдачи этапа"
        OTHER = "other", "Прочее"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="documents", on_delete=models.CASCADE
    )
    milestone = models.ForeignKey(
        "milestones.Milestone",
        related_name="documents",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    checklist_item = models.ForeignKey(
        "milestones.ChecklistItem",
        related_name="documents",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.EVIDENCE)
    file_name = models.CharField(max_length=255)
    file_hash = models.CharField(max_length=64, blank=True, default="")
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="uploaded_documents", on_delete=models.PROTECT
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "document"
        verbose_name = "документ"
        verbose_name_plural = "документы"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.file_name}"
