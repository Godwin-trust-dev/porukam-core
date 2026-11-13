"""API apps.warranty (tech-spec.md §8.8 `GET/POST /contracts/{id}/
warranty-claims` — «Гарантийные заявки (отдельная метрика, рейтинг не
пересчитывается)»)."""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.disputes import services as disputes_services
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from .serializers import (
    WarrantyClaimContestSerializer,
    WarrantyClaimCreateSerializer,
    WarrantyClaimDeclineSerializer,
    WarrantyClaimSatisfySerializer,
    WarrantyClaimSerializer,
    WarrantyFixSubmitSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    disputes_services.WarrantyPeriodNotActiveError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "warranty_period_not_active",
        "Гарантийный период не идёт",
    ),
    disputes_services.EvidenceRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "evidence_required",
        "Нужно доказательство",
    ),
    services.NotCustomerError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_dispute_side",
        "Гарантийную претензию подаёт заказчик",
    ),
    services.NotContractorError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_dispute_side",
        "Это действие по гарантийной претензии доступно исполнителю",
    ),
    disputes_services.WrongDisputeSideError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_dispute_side",
        "Это действие по гарантийной претензии доступно другой стороне",
    ),
    services.ClaimAlreadyResolvedError: (
        status.HTTP_409_CONFLICT,
        "warranty_claim_already_resolved",
        "Гарантийная претензия уже закрыта",
    ),
    services.ClaimNotAwaitingConfirmationError: (
        status.HTTP_409_CONFLICT,
        "warranty_claim_not_awaiting_confirmation",
        "Претензия не ждёт подтверждения — исполнитель ещё не сообщил об устранении",
    ),
    services.ClaimAlreadyAwaitingConfirmationError: (
        status.HTTP_409_CONFLICT,
        "warranty_claim_awaiting_confirmation",
        "Претензия уже ждёт подтверждения заказчика",
    ),
    services.FixRoundsExhaustedError: (
        status.HTTP_409_CONFLICT,
        "fix_rounds_exhausted",
        "Возражения «не устранено» исчерпаны",
    ),
    disputes_services.DisputeAlreadyResolvedError: (
        status.HTTP_409_CONFLICT,
        "dispute_already_resolved",
        "Спор уже закрыт",
    ),
    services.ClaimDisputeMissingError: (
        status.HTTP_409_CONFLICT,
        "warranty_claim_dispute_missing",
        "У претензии нет диалога",
    ),
    contracts_services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
}


def _call_service(fn: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    try:
        return fn(*args, **kwargs)
    except tuple(_SERVICE_ERROR_STATUS) as exc:
        status_code, code, title = _SERVICE_ERROR_STATUS[type(exc)]
        raise DomainAPIError(
            status_code=status_code, code=code, title=title, detail=str(exc)
        ) from exc


class ContractWarrantyClaimListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def _contract(self, request: Request, contract_id: UUID) -> Any:  # noqa: ANN401
        contract = contracts_selectors.get_contract_or_404(contract_id)
        if not contracts_services.is_party(contract, cast(User, request.user)):
            raise DomainAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="permission_denied",
                title="Вы не сторона этого договора",
            )
        return contract

    @extend_schema(responses={200: WarrantyClaimSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = self._contract(request, contract_id)
        claims = selectors.list_for_contract(contract)
        return Response(WarrantyClaimSerializer(claims, many=True).data)

    @extend_schema(request=WarrantyClaimCreateSerializer, responses={201: WarrantyClaimSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = self._contract(request, contract_id)
        serializer = WarrantyClaimCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        claim = _call_service(
            services.submit_warranty_claim,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(WarrantyClaimSerializer(claim).data, status=status.HTTP_201_CREATED)


class WarrantyClaimListView(APIView):
    """GET /warranty-claims — мои гарантийные заявки (для раздела ЛК)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: WarrantyClaimSerializer(many=True)})
    def get(self, request: Request) -> Response:
        claims = selectors.list_for_user(cast(User, request.user))
        return Response(WarrantyClaimSerializer(claims, many=True).data)


def _get_claim_as_party(request: Request, claim_id: UUID) -> Any:  # noqa: ANN401
    claim = selectors.get_claim_or_404(claim_id)
    if not contracts_services.is_party(claim.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return claim


class _ClaimActionView(APIView):
    """Общий каркас `POST /warranty-claims/{id}/<действие>`: сторона договора,
    тело по `serializer_class`, use case из `service`, ответ — карточка
    претензии. Роль/состояние проверяет сервис (403/409 через
    `_SERVICE_ERROR_STATUS`)."""

    permission_classes = [IsAuthenticated]
    serializer_class: type[Any]
    service: Any

    def post(self, request: Request, claim_id: UUID) -> Response:
        claim = _get_claim_as_party(request, claim_id)
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        _call_service(
            self.service, claim, user=cast(User, request.user), **serializer.validated_data
        )
        claim.refresh_from_db()
        return Response(WarrantyClaimSerializer(claim).data)


class WarrantyClaimDeclineView(_ClaimActionView):
    """POST /warranty-claims/{id}/decline — исполнитель отказывает по
    претензии (`resolution_type=warranty_declined`). Спор закрывается тем же
    исходом в той же транзакции (services.decline_warranty_claim)."""

    serializer_class = WarrantyClaimDeclineSerializer
    service = staticmethod(services.decline_warranty_claim)

    @extend_schema(request=WarrantyClaimDeclineSerializer, responses={200: WarrantyClaimSerializer})
    def post(self, request: Request, claim_id: UUID) -> Response:
        return super().post(request, claim_id)


class WarrantyFixSubmittedView(_ClaimActionView):
    """POST /warranty-claims/{id}/fix-submitted (ADR-133) — исполнитель:
    «устранил». Претензия -> `awaiting_confirmation`, открывается окно
    подтверждения заказчика (дедлайн `warranty_claim_acceptance`)."""

    serializer_class = WarrantyFixSubmitSerializer
    service = staticmethod(services.submit_warranty_fix)

    @extend_schema(request=WarrantyFixSubmitSerializer, responses={200: WarrantyClaimSerializer})
    def post(self, request: Request, claim_id: UUID) -> Response:
        return super().post(request, claim_id)


class WarrantyClaimSatisfyView(_ClaimActionView):
    """POST /warranty-claims/{id}/satisfy (ADR-133) — заказчик подтверждает
    устранение (`resolution_type=warranty_satisfied`), симметрично отказу."""

    serializer_class = WarrantyClaimSatisfySerializer
    service = staticmethod(services.satisfy_warranty_claim)

    @extend_schema(request=WarrantyClaimSatisfySerializer, responses={200: WarrantyClaimSerializer})
    def post(self, request: Request, claim_id: UUID) -> Response:
        return super().post(request, claim_id)


class WarrantyClaimContestView(_ClaimActionView):
    """POST /warranty-claims/{id}/contest (ADR-133) — заказчик: «не
    устранено»; раунд возражения, окно снимается, претензия снова у
    исполнителя. Третье возражение — 409 `fix_rounds_exhausted`."""

    serializer_class = WarrantyClaimContestSerializer
    service = staticmethod(services.contest_warranty_claim)

    @extend_schema(request=WarrantyClaimContestSerializer, responses={200: WarrantyClaimSerializer})
    def post(self, request: Request, claim_id: UUID) -> Response:
        return super().post(request, claim_id)
