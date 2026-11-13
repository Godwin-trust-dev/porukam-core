"""API apps.disputes (tech-spec.md §8.8). Тонкие вьюхи: разбор запроса,
вызов services.py, маппинг доменных исключений в problem+json (CLAUDE.md).
"""

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
from apps.contracts import services as contracts_services
from common.api.exceptions import DomainAPIError

from .. import selectors, services
from ..models import Dispute
from .serializers import (
    DiscountAgreementSerializer,
    DiscountDeclineSerializer,
    DiscountProposalSerializer,
    DisputeResolveSerializer,
    DisputeRespondSerializer,
    DisputeSerializer,
    DisputeWindowContestSerializer,
    DisputeWindowSerializer,
    FixRequestCreateSerializer,
    FixRequestSerializer,
    FixResubmitSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    services.DisputeAlreadyResolvedError: (
        status.HTTP_409_CONFLICT,
        "dispute_already_resolved",
        "Разногласие уже закрыто",
    ),
    # tech-spec.md §8.8 — код из спеки дословно.
    services.FixRoundsExhaustedError: (
        status.HTTP_409_CONFLICT,
        "fix_rounds_exhausted",
        "Раунды исправления исчерпаны",
    ),
    services.FixRequestAlreadyResubmittedError: (
        status.HTTP_409_CONFLICT,
        "fix_request_already_resubmitted",
        "Исправление по этому раунду уже сдано",
    ),
    services.InvalidDisputeTransitionError: (
        status.HTTP_409_CONFLICT,
        "invalid_dispute_transition",
        "Действие недоступно в текущем состоянии разногласия",
    ),
    services.DiscountAlreadyDecidedError: (
        status.HTTP_409_CONFLICT,
        "discount_already_decided",
        "Решение по скидке уже принято",
    ),
    services.WindowAlreadyClosedError: (
        status.HTTP_409_CONFLICT,
        "dispute_window_closed",
        "Окно оспаривания уже закрыто",
    ),
    services.DiscountNotApplicableError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "discount_not_applicable",
        "Скидку по этому разногласию оформить нельзя",
    ),
    services.EvidenceRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "evidence_required",
        "Нужно доказательство",
    ),
    services.ChecklistItemNotOnMilestoneError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "checklist_item_required",
        "Пункт чек-листа не из этого этапа",
    ),
    services.WarrantyPeriodNotActiveError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "warranty_period_not_active",
        "Гарантийный период не идёт",
    ),
    services.WrongDisputeSideError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_dispute_side",
        "Действие доступно другой стороне",
    ),
    services.NotDisputeCounterpartyError: (
        status.HTTP_403_FORBIDDEN,
        "not_dispute_counterparty",
        "Действие доступно второй стороне",
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


def _get_dispute_as_party(request: Request, dispute_id: UUID) -> Dispute:
    dispute = selectors.get_dispute_or_404(dispute_id)
    if not contracts_services.is_party(dispute.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return dispute


def _dispute_response(dispute: Dispute, request: Request) -> Response:
    dispute.refresh_from_db()
    return Response(DisputeSerializer(dispute, context={"request": request}).data)


class DisputeListView(APIView):
    """GET /disputes (tech-spec.md §8.8) — мои разногласия."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: DisputeSerializer(many=True)})
    def get(self, request: Request) -> Response:
        disputes = selectors.list_for_user(
            cast(User, request.user),
            status=request.query_params.get("status"),
            kind=request.query_params.get("kind"),
        )
        return Response(DisputeSerializer(disputes, many=True, context={"request": request}).data)


class DisputeDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: DisputeSerializer})
    def get(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        return Response(DisputeSerializer(dispute, context={"request": request}).data)


class DisputeRespondView(APIView):
    """POST /disputes/{id}/respond — ответ второй стороны: окно ответа
    закрывается как ОСПОРЕННОЕ (ADR-019), автоматических последствий нет."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DisputeRespondSerializer, responses={200: DisputeSerializer})
    def post(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        serializer = DisputeRespondSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        dispute = _call_service(
            services.respond_to_dispute,
            dispute,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return _dispute_response(dispute, request)


class FixRequestListCreateView(APIView):
    """POST /disputes/{id}/fix-requests (tech-spec.md §8.8) — раунд
    исправления, максимум два (`409 fix_rounds_exhausted`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: FixRequestSerializer(many=True)})
    def get(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        return Response(FixRequestSerializer(dispute.fix_requests.all(), many=True).data)

    @extend_schema(request=FixRequestCreateSerializer, responses={201: FixRequestSerializer})
    def post(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        serializer = FixRequestCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        fix_request = _call_service(
            services.request_fix,
            dispute,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(FixRequestSerializer(fix_request).data, status=status.HTTP_201_CREATED)


class FixRequestResubmitView(APIView):
    """POST /disputes/{id}/fix-requests/{fid}/resubmit — «Исправление сдано ->
    снова under_acceptance» (переход этапа — подписчиком apps.milestones на
    `dispute.fix_resubmitted`, не отсюда)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=FixResubmitSerializer, responses={200: FixRequestSerializer})
    def post(self, request: Request, dispute_id: UUID, fix_request_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        fix_request = selectors.get_fix_request_or_404(dispute, fix_request_id)
        serializer = FixResubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        fix_request = _call_service(
            services.resubmit_fix,
            fix_request,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(FixRequestSerializer(fix_request).data)


class DiscountProposalView(APIView):
    """POST /disputes/{id}/discount-proposal — создаёт ДОПНИК (§8.8: «требует
    подписи, ADR-048»). Принятие = подпись допника общим контуром §8.6;
    ответ несёт `amendment_id`, чтобы фронт увёл на экран подписания."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DiscountProposalSerializer, responses={201: DiscountAgreementSerializer})
    def post(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        serializer = DiscountProposalSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        agreement = _call_service(
            services.propose_discount,
            dispute,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(DiscountAgreementSerializer(agreement).data, status=status.HTTP_201_CREATED)


class DiscountProposalDeclineView(APIView):
    """POST /disputes/{id}/discount-proposals/{did}/decline `{comment?}` —
    вторая сторона не согласна: разногласие возвращается в `open`, допник
    скидки закрывается как отклонённый (дополнение 26.08 к ADR-131)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DiscountDeclineSerializer, responses={200: DiscountAgreementSerializer})
    def post(self, request: Request, dispute_id: UUID, agreement_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        agreement = selectors.get_discount_agreement_or_404(dispute, agreement_id)
        serializer = DiscountDeclineSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        agreement = _call_service(
            services.decline_discount,
            agreement,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(DiscountAgreementSerializer(agreement).data)


class DisputeResolveView(APIView):
    """POST /disputes/{id}/resolve (tech-spec.md §8.8) — закрытие по согласию
    сторон либо передача в суд."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DisputeResolveSerializer, responses={200: DisputeSerializer})
    def post(self, request: Request, dispute_id: UUID) -> Response:
        dispute = _get_dispute_as_party(request, dispute_id)
        serializer = DisputeResolveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        dispute = _call_service(
            services.resolve_dispute,
            dispute,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return _dispute_response(dispute, request)


class DisputeWindowListView(APIView):
    """GET /dispute-windows (tech-spec.md §8.8) — «активные окна оспаривания
    текущего профиля (для дашборда)»."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: DisputeWindowSerializer(many=True)})
    def get(self, request: Request) -> Response:
        active_only = request.query_params.get("active", "true").lower() != "false"
        windows = [
            services.sync_window_deadline(window)
            for window in selectors.list_windows_for_user(
                cast(User, request.user), active_only=active_only
            )
        ]
        return Response(DisputeWindowSerializer(windows, many=True).data)


class DisputeWindowContestView(APIView):
    """POST /dispute-windows/{id}/contest (ADR-019/ADR-028) — возразить в
    срок. Для окна ответа по спору тем же занимается `/disputes/{id}/respond`
    (там возражение — часть реплики); здесь — окно оспаривания РАСТОРЖЕНИЯ
    исполнителем, у которого своей реплики нет."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=DisputeWindowContestSerializer, responses={200: DisputeWindowSerializer})
    def post(self, request: Request, window_id: UUID) -> Response:
        window = selectors.get_window_or_404(window_id)
        serializer = DisputeWindowContestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        window = _call_service(
            services.contest_window,
            window,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(DisputeWindowSerializer(window).data)
