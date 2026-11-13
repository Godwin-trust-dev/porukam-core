from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import BusinessEntity, OwnershipEpoch


class BusinessEntityOnboardSerializer(serializers.Serializer[Any]):
    country = serializers.CharField(max_length=2)
    tax_id = serializers.CharField(max_length=32)


class BusinessEntitySerializer(serializers.ModelSerializer[BusinessEntity]):
    class Meta:
        model = BusinessEntity
        fields = [
            "id",
            "country_of_registration",
            "local_form_code",
            "tax_regime_code",
            "name",
            "short_name",
            "registered_address",
            "verification_status",
            "verified_against_registry",
            "verified_at",
            "claim_status",
            "claim_method",
            "claimed_at",
            "director_full_name",
            "director_position_label",
            "director_since",
        ]
        read_only_fields = fields


class BusinessEntityUpdateSerializer(serializers.Serializer[Any]):
    tax_regime_code = serializers.CharField(max_length=32, required=False)
    bank_details = serializers.JSONField(required=False)


class ClaimMethodInfoSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI/сериализации plain dict'ов из
    selectors.list_claim_methods() — не используется для валидации входа."""

    method = serializers.CharField()
    title = serializers.CharField()
    available = serializers.BooleanField()


class ClaimRequestSerializer(serializers.Serializer[Any]):
    method = serializers.ChoiceField(choices=BusinessEntity.ClaimMethod.choices)
    proof = serializers.JSONField(required=False, default=dict)


class ClaimDisputeRequestSerializer(serializers.Serializer[Any]):
    proof = serializers.JSONField(required=False, default=dict)


class OwnershipEpochSerializer(serializers.ModelSerializer[OwnershipEpoch]):
    class Meta:
        model = OwnershipEpoch
        fields = ["id", "epoch_number", "started_at", "ended_at", "detected_via", "contracts_count"]
        read_only_fields = fields
