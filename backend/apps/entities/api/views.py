from __future__ import annotations

from typing import cast
from uuid import UUID

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from ..providers import FakeEntityRegistryProvider
from .serializers import (
    BusinessEntityOnboardSerializer,
    BusinessEntitySerializer,
    BusinessEntityUpdateSerializer,
    ClaimDisputeRequestSerializer,
    ClaimMethodInfoSerializer,
    ClaimRequestSerializer,
    OwnershipEpochSerializer,
)

# Фейк-провайдер: реальной интеграции с ЕГРЮЛ/ЕГРИП нет и не будет в рамках
# 3.4 (CLAUDE.md: "внешние провайдеры — только интерфейсы + фейки").
_registry_provider = FakeEntityRegistryProvider()


class BusinessEntityOnboardView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=BusinessEntityOnboardSerializer, responses={201: BusinessEntitySerializer}
    )
    def post(self, request: Request) -> Response:
        serializer = BusinessEntityOnboardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            entity = services.register_business_entity(
                serializer.validated_data["tax_id"],
                country=serializer.validated_data["country"],
                created_by=cast(User, request.user),
                provider=_registry_provider,
            )
        except services.EntityNotFoundInRegistryError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_404_NOT_FOUND,
                code="entity_not_found_in_registry",
                title="Компания не найдена в реестре",
                detail=str(exc),
            ) from exc
        except services.EntityLiquidatedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="entity_liquidated",
                title="Компания ликвидирована по данным реестра",
                detail=str(exc),
            ) from exc
        return Response(BusinessEntitySerializer(entity).data, status=status.HTTP_201_CREATED)


class BusinessEntityDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: BusinessEntitySerializer})
    def get(self, request: Request, entity_id: UUID) -> Response:
        entity = selectors.get_business_entity_or_404(entity_id)
        return Response(BusinessEntitySerializer(entity).data)

    @extend_schema(
        request=BusinessEntityUpdateSerializer, responses={200: BusinessEntitySerializer}
    )
    def patch(self, request: Request, entity_id: UUID) -> Response:
        entity = selectors.get_business_entity_or_404(entity_id)
        serializer = BusinessEntityUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            entity = services.update_business_entity(
                entity,
                cast(User, request.user),
                tax_regime_code=serializer.validated_data.get("tax_regime_code"),
                bank_details=serializer.validated_data.get("bank_details"),
            )
        except services.EntityNotOperableError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="entity_not_operable",
                title="Контроль над юрлицом не подтверждён",
                detail=str(exc),
            ) from exc
        except services.EntityPermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Редактировать карточку может только подтвердивший контроль пользователь",
                detail=str(exc),
            ) from exc
        return Response(BusinessEntitySerializer(entity).data)


class ClaimMethodsView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ClaimMethodInfoSerializer(many=True)})
    def get(self, request: Request, entity_id: UUID) -> Response:
        selectors.get_business_entity_or_404(entity_id)
        data = selectors.list_claim_methods()
        return Response(ClaimMethodInfoSerializer(data, many=True).data)


class ClaimView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ClaimRequestSerializer, responses={200: BusinessEntitySerializer})
    def post(self, request: Request, entity_id: UUID) -> Response:
        entity = selectors.get_business_entity_or_404(entity_id)
        serializer = ClaimRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            entity = services.claim_business_entity(
                entity,
                cast(User, request.user),
                method=serializer.validated_data["method"],
                proof=serializer.validated_data.get("proof", {}),
            )
        except services.ClaimMethodNotAvailableError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="claim_method_not_available",
                title="Способ подтверждения контроля пока не реализован",
                detail=str(exc),
            ) from exc
        except services.ClaimMethodNotSatisfiedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="claim_method_not_satisfied",
                title="Условия выбранного способа не выполнены",
                detail=str(exc),
            ) from exc
        return Response(BusinessEntitySerializer(entity).data)


class ClaimDisputeView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ClaimDisputeRequestSerializer, responses={200: BusinessEntitySerializer})
    def post(self, request: Request, entity_id: UUID) -> Response:
        entity = selectors.get_business_entity_or_404(entity_id)
        serializer = ClaimDisputeRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        entity = services.dispute_claim(
            entity, cast(User, request.user), proof=serializer.validated_data.get("proof", {})
        )
        return Response(BusinessEntitySerializer(entity).data)


class EpochListView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: OwnershipEpochSerializer(many=True)})
    def get(self, request: Request, entity_id: UUID) -> Response:
        entity = selectors.get_business_entity_or_404(entity_id)
        epochs = selectors.list_epochs(entity)
        return Response(OwnershipEpochSerializer(epochs, many=True).data)
