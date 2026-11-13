from __future__ import annotations

from typing import cast

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from common.api.exceptions import DomainAPIError

from .. import services
from ..permissions import require_verification
from ..providers import FakeEsiaProvider
from .serializers import (
    EsiaAuthorizeUrlSerializer,
    EsiaCallbackRequestSerializer,
    IdentityVerificationSerializer,
)

# Фейк-провайдер: реальной интеграции с ЕСИА нет и не будет в рамках 3.2
# (CLAUDE.md: "внешние провайдеры — только интерфейсы + фейки").
_esia_provider = FakeEsiaProvider()


class EsiaAuthorizeUrlView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: EsiaAuthorizeUrlSerializer})
    def get(self, request: Request) -> Response:
        url, state = services.build_authorize_url(cast(User, request.user), provider=_esia_provider)
        return Response(EsiaAuthorizeUrlSerializer({"authorize_url": url, "state": state}).data)


class EsiaCallbackView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=EsiaCallbackRequestSerializer, responses={200: IdentityVerificationSerializer}
    )
    def post(self, request: Request) -> Response:
        serializer = EsiaCallbackRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            verification = services.complete_verification(
                cast(User, request.user),
                code=serializer.validated_data["code"],
                state=serializer.validated_data["state"],
                provider=_esia_provider,
            )
        except services.EsiaStateInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="esia_state_invalid",
                title="Сессия верификации ЕСИА истекла или недействительна",
                detail=str(exc),
            ) from exc
        except services.EsiaCodeInvalidError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="esia_code_invalid",
                title="Код ЕСИА не распознан",
                detail=str(exc),
            ) from exc
        return Response(IdentityVerificationSerializer(verification).data)


class VerificationGateDemoView(APIView):
    """Демонстрационный эндпоинт гейта progressive KYC (tech-spec.md §7.4
    п.1) — единственная цель: показать переход 403 verification_required →
    200 после верификации (etap-3.md 3.2). Реальные применения гейта —
    claim (3.4), SigningAuthority (3.5)."""

    permission_classes = [IsAuthenticated, require_verification(User.VerificationLevel.VERIFIED)]

    def get(self, request: Request) -> Response:
        return Response({"ok": True})
