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
from apps.entities import selectors as entities_selectors
from apps.entities import services as entities_services
from common.api.exceptions import DomainAPIError
from common.money import Money

from .. import selectors, services
from .serializers import (
    RepresentativeGrantSerializer,
    RepresentativeSerializer,
    RepresentativeUpdateSerializer,
    SigningAuthorityGrantSerializer,
    SigningAuthoritySerializer,
)


def _entity_not_operable_error(exc: Exception) -> DomainAPIError:
    return DomainAPIError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="entity_not_operable",
        title="Контроль над юрлицом не подтверждён",
        detail=str(exc),
    )


class RepresentativeListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: RepresentativeSerializer(many=True)})
    def get(self, request: Request, entity_id: UUID) -> Response:
        return Response(
            RepresentativeSerializer(selectors.list_representatives(entity_id), many=True).data
        )

    @extend_schema(request=RepresentativeGrantSerializer, responses={201: RepresentativeSerializer})
    def post(self, request: Request, entity_id: UUID) -> Response:
        entity = entities_selectors.get_business_entity_or_404(entity_id)
        serializer = RepresentativeGrantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target_user = _get_user_or_404(serializer.validated_data["user_id"])
        try:
            representative = services.grant_representative(
                entity,
                cast(User, request.user),
                target_user,
                role=serializer.validated_data["role"],
                permissions=serializer.validated_data.get("permissions"),
            )
        except entities_services.EntityNotOperableError as exc:
            raise _entity_not_operable_error(exc) from exc
        except services.RepresentativePermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужен permission manage_representatives",
                detail=str(exc),
            ) from exc
        return Response(
            RepresentativeSerializer(representative).data, status=status.HTTP_201_CREATED
        )


class RepresentativeDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=RepresentativeUpdateSerializer, responses={200: RepresentativeSerializer}
    )
    def patch(self, request: Request, entity_id: UUID, representative_id: UUID) -> Response:
        representative = selectors.get_representative_or_404(entity_id, representative_id)
        serializer = RepresentativeUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            representative = services.update_representative(
                representative, cast(User, request.user), **serializer.validated_data
            )
        except services.RepresentativePermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужен permission manage_representatives",
                detail=str(exc),
            ) from exc
        return Response(RepresentativeSerializer(representative).data)

    def delete(self, request: Request, entity_id: UUID, representative_id: UUID) -> Response:
        representative = selectors.get_representative_or_404(entity_id, representative_id)
        try:
            services.update_representative(
                representative, cast(User, request.user), is_active=False
            )
        except services.RepresentativePermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужен permission manage_representatives",
                detail=str(exc),
            ) from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class SigningAuthorityListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SigningAuthoritySerializer(many=True)})
    def get(self, request: Request, entity_id: UUID) -> Response:
        return Response(
            SigningAuthoritySerializer(
                selectors.list_signing_authorities(entity_id), many=True
            ).data
        )

    @extend_schema(
        request=SigningAuthorityGrantSerializer, responses={201: SigningAuthoritySerializer}
    )
    def post(self, request: Request, entity_id: UUID) -> Response:
        entity = entities_selectors.get_business_entity_or_404(entity_id)
        serializer = SigningAuthorityGrantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target_user = _get_user_or_404(serializer.validated_data["user_id"])
        max_amount_data = serializer.validated_data.get("max_amount")
        max_amount = (
            Money(max_amount_data["amount"], max_amount_data["currency"])
            if max_amount_data
            else None
        )
        try:
            authority = services.grant_signing_authority(
                entity,
                cast(User, request.user),
                target_user,
                basis=serializer.validated_data["basis"],
                max_amount=max_amount,
                proof=serializer.validated_data.get("proof"),
            )
        except entities_services.EntityNotOperableError as exc:
            raise _entity_not_operable_error(exc) from exc
        except services.RepresentativePermissionDeniedError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Нужен permission manage_representatives",
                detail=str(exc),
            ) from exc
        except services.ManualReviewNotAllowedForSeparatedOwnershipError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="manual_review_not_allowed",
                title="Ручная экспертиза недоступна для этой формы собственности",
                detail=str(exc),
            ) from exc
        except services.DirectorMismatchError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="director_mismatch",
                title="ФИО не совпадает с директором по реестру",
                detail=str(exc),
            ) from exc
        return Response(SigningAuthoritySerializer(authority).data, status=status.HTTP_201_CREATED)


class SigningAuthorityDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request: Request, entity_id: UUID, authority_id: UUID) -> Response:
        authority = selectors.get_signing_authority_or_404(entity_id, authority_id)
        services.revoke_signing_authority(authority, cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


def _get_user_or_404(user_id: UUID) -> User:
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        raise DomainAPIError(
            status_code=status.HTTP_404_NOT_FOUND, code="not_found", title="Пользователь не найден"
        )
    return user
