from __future__ import annotations

from typing import Any

from rest_framework import serializers


class ExportOptionsSerializer(serializers.Serializer[Any]):
    """`POST /contracts/{id}/archive/export` — `ExportOptions` DEV-12 §2
    (взаимоисключающие тумблеры проверяет сервис)."""

    include_originals = serializers.BooleanField(required=False, default=True)
    manifest_only = serializers.BooleanField(required=False, default=False)


class ArtifactSerializer(serializers.Serializer[Any]):
    url = serializers.CharField(allow_null=True)
    size_bytes = serializers.IntegerField(allow_null=True)
    sha256 = serializers.CharField(allow_null=True)
    state = serializers.CharField()
    expires_at = serializers.DateTimeField(allow_null=True)
    shredded_at = serializers.DateTimeField(allow_null=True)


class ArchiveLinkSerializer(serializers.Serializer[Any]):
    id = serializers.UUIDField()
    kind = serializers.CharField()
    party_role = serializers.CharField()
    url = serializers.CharField(allow_null=True)
    created_at = serializers.DateTimeField()
    revoked_at = serializers.DateTimeField(allow_null=True)
    last_access_at = serializers.DateTimeField(allow_null=True)
    access_count = serializers.IntegerField()


class ExportJobSerializer(serializers.Serializer[Any]):
    """`ExportJob` DEV-12 §2 + поля бэка. `status` — queued|running|ready|
    failed (фронт маппит queued/running -> pending, failed -> error);
    `progress` 0/50/100; `pdf` всегда null (нет генератора PDF, см.
    package.py); `zip` = файлы (files.zip), `package` = доказательный пакет."""

    id = serializers.UUIDField()
    export_id = serializers.UUIDField()
    contract_id = serializers.UUIDField()
    status = serializers.CharField()
    progress = serializers.IntegerField()
    trigger = serializers.CharField()
    is_snapshot = serializers.BooleanField()
    snapshot_at = serializers.DateTimeField()
    include_originals = serializers.BooleanField()
    manifest_only = serializers.BooleanField()
    evidence_count = serializers.IntegerField()
    package = ArtifactSerializer(allow_null=True)
    zip = ArtifactSerializer(allow_null=True)
    pdf = ArtifactSerializer(allow_null=True)
    expires_at = serializers.DateTimeField(allow_null=True)
    links = ArchiveLinkSerializer(many=True)
    error = serializers.CharField(allow_blank=True)
    created_at = serializers.DateTimeField()
    finished_at = serializers.DateTimeField(allow_null=True)


class ExportAcceptedSerializer(serializers.Serializer[Any]):
    export_id = serializers.UUIDField()
    jobId = serializers.UUIDField()  # noqa: N815 — имя поля фронта (DEV-12 §5)
    status = serializers.CharField()


class SectionSerializer(serializers.Serializer[Any]):
    key = serializers.CharField()
    count = serializers.IntegerField(allow_null=True)
    size_bytes = serializers.IntegerField(allow_null=True)
    complete = serializers.BooleanField()


class ArchivePreviewSerializer(serializers.Serializer[Any]):
    contract_id = serializers.UUIDField()
    contract_no = serializers.CharField()
    counterparty = serializers.CharField(allow_blank=True)
    contract_status = serializers.CharField()
    is_snapshot = serializers.BooleanField()
    snapshot_at = serializers.DateTimeField(allow_null=True)
    sections = SectionSerializer(many=True)
    format = serializers.DictField()
    est_size_bytes = serializers.IntegerField()
    drive_backup = serializers.CharField()
    can_export = serializers.BooleanField()
    retention = serializers.DictField()
    exports = ExportJobSerializer(many=True)
