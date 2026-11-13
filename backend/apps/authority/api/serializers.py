from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import Representative, SigningAuthority


class MoneySerializer(serializers.Serializer[Any]):
    """Суммы в API — строкой (CLAUDE.md)."""

    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    currency = serializers.CharField(max_length=3)


class RepresentativeSerializer(serializers.ModelSerializer[Representative]):
    class Meta:
        model = Representative
        fields = ["id", "user", "business_entity", "role", "permissions", "is_active", "created_at"]
        read_only_fields = ["id", "business_entity", "created_at"]


class RepresentativeGrantSerializer(serializers.Serializer[Any]):
    user_id = serializers.UUIDField()
    role = serializers.ChoiceField(choices=Representative.Role.choices)
    permissions = serializers.ListField(
        child=serializers.ChoiceField(choices=Representative.Permission.choices), required=False
    )


class RepresentativeUpdateSerializer(serializers.Serializer[Any]):
    role = serializers.ChoiceField(choices=Representative.Role.choices, required=False)
    permissions = serializers.ListField(
        child=serializers.ChoiceField(choices=Representative.Permission.choices), required=False
    )
    is_active = serializers.BooleanField(required=False)


class SigningAuthoritySerializer(serializers.ModelSerializer[SigningAuthority]):
    max_amount = serializers.SerializerMethodField()

    class Meta:
        model = SigningAuthority
        fields = [
            "id",
            "user",
            "business_entity",
            "basis",
            "max_amount",
            "poa_registry_id",
            "last_verified_at",
            "expires_at",
            "is_active",
            "created_at",
        ]
        read_only_fields = fields

    def get_max_amount(self, obj: SigningAuthority) -> dict[str, str] | None:
        if obj.max_amount_value is None:
            return None
        return {"amount": str(obj.max_amount_value), "currency": obj.max_amount_currency or ""}


class SigningAuthorityGrantSerializer(serializers.Serializer[Any]):
    user_id = serializers.UUIDField()
    basis = serializers.ChoiceField(choices=SigningAuthority.Basis.choices)
    max_amount = MoneySerializer(required=False)
    proof = serializers.JSONField(required=False, default=dict)
