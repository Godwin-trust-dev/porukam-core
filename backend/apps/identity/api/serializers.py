from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import IdentityVerification


class EsiaAuthorizeUrlSerializer(serializers.Serializer[Any]):
    """Только для описания ответа в OpenAPI."""

    authorize_url = serializers.CharField()
    state = serializers.CharField()


class EsiaCallbackRequestSerializer(serializers.Serializer[Any]):
    code = serializers.CharField()
    state = serializers.CharField()


class IdentityVerificationSerializer(serializers.ModelSerializer[IdentityVerification]):
    class Meta:
        model = IdentityVerification
        fields = ["id", "provider", "level", "status", "verified_at", "expires_at"]
        read_only_fields = fields
