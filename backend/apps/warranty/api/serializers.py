from __future__ import annotations

from typing import Any

from rest_framework import serializers

from .. import services
from ..models import WarrantyClaim, WarrantyFix


class WarrantyFixSerializer(serializers.ModelSerializer[WarrantyFix]):
    """Цикл «устранил -> подтвердил / не устранено» (ADR-133): `contested_*`
    пусты, пока заказчик не возразил."""

    class Meta:
        model = WarrantyFix
        fields = [
            "id",
            "round",
            "submitted_by_id",
            "comment",
            "evidence",
            "submitted_at",
            "contested_by_id",
            "contest_comment",
            "contest_evidence",
            "contested_at",
        ]
        read_only_fields = fields


class WarrantyClaimSerializer(serializers.ModelSerializer[WarrantyClaim]):
    """`dispute_id` — разногласие, в котором идёт диалог по претензии
    (ADR-131): фронт ведёт по нему на карточку спора. ADR-133:
    `status=awaiting_confirmation` + `acceptance_deadline_at` — окно
    подтверждения заказчика (null, пока уведомление не размещено в ЛК),
    `fix_rounds_used`/`fix_rounds_left` — возражения «не устранено»,
    `fixes` — история устранений. Дополнение 26.08: `resolved_by_id` — кто
    закрыл (null у автозакрытия), `resolved_auto` — закрыта системой по
    истечении окна подтверждения / потолка спора."""

    fix_rounds_left = serializers.IntegerField(read_only=True)
    acceptance_deadline_at = serializers.SerializerMethodField()
    fixes = WarrantyFixSerializer(many=True, read_only=True)

    class Meta:
        model = WarrantyClaim
        fields = [
            "id",
            "contract_id",
            "submitted_by_id",
            "description",
            "evidence",
            "status",
            "resolution_type",
            "dispute_id",
            "fix_rounds_used",
            "fix_rounds_left",
            "fix_submitted_at",
            "acceptance_deadline_at",
            "fixes",
            "submitted_at",
            "resolved_at",
            "resolved_by_id",
            "resolved_auto",
        ]
        read_only_fields = fields

    def get_acceptance_deadline_at(self, obj: WarrantyClaim) -> Any:  # noqa: ANN401
        return services.acceptance_deadline_at(obj)


class WarrantyClaimCreateSerializer(serializers.Serializer[Any]):
    description = serializers.CharField()
    evidence = serializers.ListField(child=serializers.CharField(), allow_empty=False)


class WarrantyClaimDeclineSerializer(serializers.Serializer[Any]):
    """`POST /warranty-claims/{id}/decline` — текст отказа исполнителя
    (уходит заказчику в уведомлении `warranty.claim_declined`)."""

    comment = serializers.CharField(allow_blank=True, default="")


class WarrantyFixSubmitSerializer(serializers.Serializer[Any]):
    """`POST /warranty-claims/{id}/fix-submitted` — «устранил» (ADR-133)."""

    comment = serializers.CharField(allow_blank=True, default="")
    evidence = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class WarrantyClaimSatisfySerializer(serializers.Serializer[Any]):
    """`POST /warranty-claims/{id}/satisfy` — подтверждение заказчика."""

    comment = serializers.CharField(allow_blank=True, default="")


class WarrantyClaimContestSerializer(serializers.Serializer[Any]):
    """`POST /warranty-claims/{id}/contest` — «не устранено»: комментарий
    обязателен (юрзначимое возражение — без текста оно пустое)."""

    comment = serializers.CharField()
    evidence = serializers.ListField(child=serializers.CharField(), required=False, default=list)
