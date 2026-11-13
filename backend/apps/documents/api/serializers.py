from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import Document


class DocumentSerializer(serializers.ModelSerializer[Document]):
    class Meta:
        model = Document
        fields = [
            "id",
            "contract_id",
            "milestone_id",
            "checklist_item_id",
            "kind",
            "file_name",
            "file_hash",
            "uploaded_by_id",
            "created_at",
        ]
        read_only_fields = fields


class DocumentUploadSerializer(serializers.Serializer[Any]):
    """Файл-заглушка (docstring apps/documents/models.py) — без реальной
    загрузки байт: клиент передаёт имя и (опционально) хеш, как если бы файл
    уже лежал в хранилище (полная загрузка — evidence ingest, этап 6)."""

    checklist_item_id = serializers.UUIDField(required=False, allow_null=True)
    file_name = serializers.CharField(max_length=255)
    file_hash = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")
    kind = serializers.ChoiceField(choices=Document.Kind.choices, default=Document.Kind.EVIDENCE)
