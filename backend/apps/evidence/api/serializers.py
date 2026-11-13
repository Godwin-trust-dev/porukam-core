from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from rest_framework import serializers

from .. import services
from ..models import Evidence


class EvidenceUploadSerializer(serializers.Serializer[Any]):
    """`POST /evidence`, `POST /milestones/{id}/evidence`,
    `POST /disputes/{id}/evidence` — multipart (ГВ.3 п.1).

    `manifest` (JSON-строка) + `signature` (base64) — подписанный DeviceKey
    манифест (tech-spec.md §8.9 `POST /evidence/batches`, ADR-053/ADR-136
    п.6): вместо отдельного batch-эндпоинта манифест принимается ТЕМ ЖЕ
    upload'ом по одному файлу; принимается только при
    `EVIDENCE_DEVICE_MANIFEST_ENABLED` (Э10), иначе 409.

    `description` (решение владельца 05.09) — необязательное пояснение
    автора к файлу. Партия уходит по одному запросу НА ФАЙЛ, и одно описание
    отправитель повторяет в каждом: «партии» в доменной модели нет, а строка
    Evidence путешествует дальше в одиночку (лента спора, архивная выгрузка,
    релей контрагенту) и обязана объяснять себя сама."""

    file = serializers.FileField()
    description = serializers.CharField(
        required=False, allow_blank=True, max_length=2000, trim_whitespace=True
    )
    manifest = serializers.JSONField(required=False)
    signature = serializers.CharField(required=False, allow_blank=False)

    def validate_manifest(self, value: Any) -> dict[str, Any]:  # noqa: ANN401
        # multipart несёт JSON строкой — JSONField DRF из form-data отдаёт
        # строку как есть (binary=False), разбираем сами.
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError as exc:
                raise serializers.ValidationError("manifest: не JSON") from exc
        if not isinstance(value, dict):
            raise serializers.ValidationError("manifest: ожидается объект")
        return value

    def validate_signature(self, value: str) -> bytes:
        try:
            return base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise serializers.ValidationError("signature: не base64") from exc

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if ("manifest" in attrs) != ("signature" in attrs):
            raise serializers.ValidationError("manifest и signature передаются только вместе")
        return attrs


class EvidenceSerializer(serializers.ModelSerializer[Evidence]):
    """ADR-136: поля манифеста/хранения наружу. `strong_protection` —
    ОТСУТСТВИЕ пометки «без усиленной доказательной защиты» (tech-spec.md
    §1.3, §14 п.17): веб-загрузка всегда `false`, фронт показывает пометку.
    Гео НЕ отдаётся никогда (ПД, ADR-045) — только `has_geo`."""

    has_thumbnail = serializers.SerializerMethodField()
    has_geo = serializers.SerializerMethodField()
    has_tsa_token = serializers.SerializerMethodField()
    strong_protection = serializers.SerializerMethodField()
    encrypted_at_rest = serializers.SerializerMethodField()
    original_available = serializers.SerializerMethodField()

    class Meta:
        model = Evidence
        fields = [
            "id",
            "contract_id",
            "milestone_id",
            "checklist_item_id",
            "dispute_id",
            "uploaded_by_id",
            "file_name",
            # Пояснение автора, заданное при загрузке (решение владельца
            # 05.09). Только чтение: менять описание после создания нечем.
            "description",
            "mime_type",
            "file_size",
            "file_hash",
            "trusted_timestamp_at",
            "trusted_timestamp_source",
            "has_thumbnail",
            "metadata",
            "storage_mode",
            "delivery_status",
            "delivered_to_counterparty_at",
            "backup_status",
            "backup_provider",
            "backup_completed_at",
            "backup_failure_reason",
            "backup_drive_file_id",
            "backup_drive_web_view_link",
            # ADR-136 (Э6): манифест DeviceKey / окно 72 ч / хранение.
            "device_key_id",
            "assignment_id",
            "captured_at_device",
            "device_clock_skew_ms",
            "has_geo",
            "has_tsa_token",
            "lateness",
            "is_evidence_role",
            "strong_protection",
            "encrypted_at_rest",
            "retention_state",
            "archived_at",
            "shredded_at",
            "original_available",
            "created_at",
        ]
        read_only_fields = fields

    def get_has_thumbnail(self, obj: Evidence) -> bool:
        return obj.thumbnail is not None

    def get_has_geo(self, obj: Evidence) -> bool:
        return obj.geo_encrypted is not None

    def get_has_tsa_token(self, obj: Evidence) -> bool:
        return obj.tsa_token is not None

    def get_strong_protection(self, obj: Evidence) -> bool:
        return services.is_strongly_protected(obj)

    def get_encrypted_at_rest(self, obj: Evidence) -> bool:
        return bool(obj.encryption_key_ref)

    def get_original_available(self, obj: Evidence) -> bool:
        if obj.retention_state == Evidence.RetentionState.SHREDDED:
            return False
        if obj.storage_mode == Evidence.StorageMode.GLOBAL:
            return obj.transit_payload is not None
        return bool(obj.s3_object_key)


class EvidenceVerifySerializer(serializers.Serializer[Any]):
    """`POST /evidence/{id}/verify` (ГВ.3 п.2: «сверить предъявленный файл
    с хешом»)."""

    file = serializers.FileField()


class EvidenceVerifyResultSerializer(serializers.Serializer[Any]):
    matches = serializers.BooleanField()


class RetentionPolicySerializer(serializers.Serializer[Any]):
    """`GET /evidence/retention-policy` (ADR-137): дни — из
    DeadlineKindConfig; `null` — категория не засеяна."""

    hot_days = serializers.IntegerField(allow_null=True)
    archive_days = serializers.IntegerField(allow_null=True)
    notice_days = serializers.IntegerField(allow_null=True)
    dispute_pause_cap_days = serializers.IntegerField(allow_null=True)
    hashes_forever = serializers.BooleanField()
