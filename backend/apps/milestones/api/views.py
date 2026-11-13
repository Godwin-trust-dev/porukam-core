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
from apps.contracts.api.serializers import TimelineEventSerializer
from common.api.exceptions import DomainAPIError
from common.fsm import InvalidTransitionError
from common.i18n import resolve_request_locale

from .. import selectors, services
from ..models import ChecklistItem, ContractMaterial, Milestone
from .serializers import (
    ChecklistItemCreateSerializer,
    ChecklistItemPatchSerializer,
    ChecklistItemSerializer,
    ChecklistRecommendationSerializer,
    ContractMaterialCreateSerializer,
    ContractMaterialPatchSerializer,
    ContractMaterialSerializer,
    LoanScheduleMaterializeSerializer,
    MaterialProblemNoticeSerializer,
    MilestoneCreateSerializer,
    MilestonePatchSerializer,
    MilestoneRejectSerializer,
    MilestoneSerializer,
    MilestoneSubmitSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    contracts_services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
    services.StructureNotEditableError: (
        status.HTTP_409_CONFLICT,
        "contract_immutable",
        "Структура этапов редактируется только до подписания",
    ),
    services.MilestoneWrongContractError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_wrong_contract",
        "Родительский этап принадлежит другому договору",
    ),
    services.MilestoneDepthExceededError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_depth_exceeded",
        "Превышена максимальная глубина дерева этапов",
    ),
    services.MilestoneAmountGuardError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_amount_guard",
        "Сумма допустима только у листа дерева этапов",
    ),
    services.MilestoneHasLeafContentError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_has_leaf_content",
        "У этапа уже есть чек-лист или материалы — это лист, не ветка",
    ),
    services.MilestoneNotLeafError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_not_leaf",
        "Чек-лист и материалы допустимы только на листе дерева",
    ),
    services.MaterialCatalogItemNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "not_found",
        "Позиция каталога материалов не найдена",
    ),
    services.SphereNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "not_found",
        "Сфера не найдена",
    ),
    services.CurrencyNotActiveError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "currency_not_active",
        "Валюта не активна в справочнике",
    ),
    services.MaterialPriceRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "material_price_required",
        "Исполнитель не может поставлять материал по нулевой цене",
    ),
    services.MoneyPairRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "amount_currency_required",
        "amount и currency указываются только вместе",
    ),
    services.LoanScheduleNotApplicableError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "loan_schedule_not_applicable",
        "График возврата недоступен для материализации",
    ),
    # --- Э4.6: гейт, сдача, приёмка ------------------------------------------
    services.GateNotOnLeafError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "gate_not_on_leaf",
        "Гейт/сдача/приёмка — операции листа, не ветки",
    ),
    services.GateNotSignedError: (
        status.HTTP_409_CONFLICT,
        "gate_not_signed",
        "Договор ещё не подписан",
    ),
    services.GateMaterialsNotReadyError: (
        status.HTTP_409_CONFLICT,
        "gate_materials_not_ready",
        "Не все материалы заказчика получены",
    ),
    services.GateFinancialConditionNotMetError: (
        status.HTTP_409_CONFLICT,
        "gate_financial_condition_not_met",
        "Финансовое условие гейта не выполнено",
    ),
    services.MaterialProblemNotOnCustomerSourceError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "material_problem_not_on_customer_source",
        "Уведомление о проблеме — только для материалов заказчика",
    ),
    # ADR-155: двустороннее подтверждение материалов.
    services.MaterialHandoverWrongSideError: (
        status.HTTP_403_FORBIDDEN,
        "material_handover_wrong_side",
        "Передачу отмечает поставляющая сторона, получение — принимающая",
    ),
    # ADR-164: код `required_evidence_not_covered` (422) снят вместе с гейтом
    # сдачи — непокрытые пункты чек-листа стали подсказкой
    # (`uncovered_required_evidence` в карточке этапа), а не отказом.
    services.ChecklistItemRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "checklist_item_required",
        "Отклонение требует checklist_item_id (ADR-017)",
    ),
    services.ChecklistItemNotOnMilestoneError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "checklist_item_wrong_milestone",
        "Пункт чек-листа принадлежит другому этапу",
    ),
    services.EvidenceRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "evidence_required",
        "Отклонение требует хотя бы одно доказательство",
    ),
    # ADR-130: WrongConfirmationSideError/AdvanceConfirmationNotApplicableError
    # маппятся теперь в apps.payments.api.views — денежные подтверждения
    # обслуживает платёжный контур, здесь их эндпоинтов больше нет.
    # MILESTONE_FSM.assert_transition (confirm_payment на не-accepted этапе,
    # «для читаемой 409-ошибки» — services.confirm_payment) — без этого
    # маппинга исключение уходило мимо problem+json в 500 (тот же приём,
    # что invalid_negotiation_transition в apps/contracts/api/views.py).
    InvalidTransitionError: (
        status.HTTP_409_CONFLICT,
        "invalid_milestone_transition",
        "Недопустимое действие для текущего статуса этапа",
    ),
}


def _call_service(fn: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    try:
        return fn(*args, **kwargs)
    except tuple(_SERVICE_ERROR_STATUS) as exc:
        status_code, code, title = _SERVICE_ERROR_STATUS[type(exc)]
        # ADR-155: причина финансового отказа — машиночитаемо, в `context`
        # (`payment_not_confirmed` у `before_start`, `awaiting_payment`,
        # `payment_method_not_set`), а не только словами
        # в `detail`. Код ошибки при этом ОДИН — фронт уже на него завязан,
        # а reason тот же, что отдаёт `GET /milestones/{id}/gate`.
        context = (
            {"reason": exc.reason}
            if isinstance(exc, services.GateFinancialConditionNotMetError)
            else None
        )
        raise DomainAPIError(
            status_code=status_code, code=code, title=title, detail=str(exc), context=context
        ) from exc


def _get_contract_as_party(request: Request, contract_id: UUID) -> Any:  # noqa: ANN401
    contract = contracts_selectors.get_contract_or_404(contract_id)
    if not contracts_services.is_party(contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return contract


def _get_milestone_as_party(request: Request, milestone_id: UUID) -> Milestone:
    milestone = selectors.get_milestone_or_404(milestone_id)
    if not contracts_services.is_party(milestone.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return milestone


class MilestoneListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: dict})
    def get(self, request: Request, contract_id: UUID) -> Response:
        """GET /contracts/{id}/milestones?view=tree (tech-spec.md §8.5) —
        дерево этапов с вычисленными суммами; единственный поддерживаемый
        `view` этой ветки — `tree` (значение по умолчанию)."""
        contract = _get_contract_as_party(request, contract_id)
        return Response(selectors.build_tree(contract))

    @extend_schema(request=MilestoneCreateSerializer, responses={201: MilestoneSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = MilestoneCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        parent_id = data.pop("parent_id")
        depends_on_id = data.pop("depends_on_id")
        parent = selectors.get_milestone_or_404(parent_id) if parent_id else None
        depends_on = selectors.get_milestone_or_404(depends_on_id) if depends_on_id else None
        milestone = _call_service(
            services.create_milestone,
            contract,
            user=cast(User, request.user),
            parent=parent,
            depends_on=depends_on,
            **data,
        )
        return Response(MilestoneSerializer(milestone).data, status=status.HTTP_201_CREATED)


class MilestoneDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: MilestoneSerializer})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        return Response(MilestoneSerializer(milestone).data)

    @extend_schema(request=MilestonePatchSerializer, responses={200: MilestoneSerializer})
    def patch(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = MilestonePatchSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        milestone = _call_service(
            services.patch_milestone,
            milestone,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(MilestoneSerializer(milestone).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request, milestone_id: UUID) -> Response:
        """DELETE /milestones/{id} (ADR-101) — только до подписания, иначе
        409 `contract_immutable` (как у POST/PATCH структуры)."""
        milestone = _get_milestone_as_party(request, milestone_id)
        _call_service(services.delete_milestone, milestone, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


class MilestoneLoanScheduleView(APIView):
    """POST /contracts/{id}/milestones/loan-schedule — вне таблицы
    tech-spec.md §8.5 (появилась только с этой веткой, etap-4.md Э4.3
    приёмка: «для Займа график возврата создаётся как этапы-листья»)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=LoanScheduleMaterializeSerializer, responses={201: MilestoneSerializer(many=True)}
    )
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = LoanScheduleMaterializeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        milestones = _call_service(
            services.materialize_loan_schedule,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(
            MilestoneSerializer(milestones, many=True).data, status=status.HTTP_201_CREATED
        )


class ChecklistItemListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ChecklistItemSerializer(many=True)})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        items = selectors.list_checklist_items(milestone)
        return Response(ChecklistItemSerializer(items, many=True).data)

    @extend_schema(request=ChecklistItemCreateSerializer, responses={201: ChecklistItemSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = ChecklistItemCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        item = _call_service(
            services.create_checklist_item,
            milestone,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ChecklistItemSerializer(item).data, status=status.HTTP_201_CREATED)


def _get_checklist_item_as_party(request: Request, item_id: UUID) -> ChecklistItem:
    item = selectors.get_checklist_item_or_404(item_id)
    if not contracts_services.is_party(item.milestone.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return item


class ChecklistItemDetailView(APIView):
    """PATCH/DELETE /checklist-items/{id} — правка и удаление пункта чек-листа
    до подписания (409 `contract_immutable` после, как у структуры этапов).
    Плоский путь, как `/milestones/{id}` — пункт адресуется своим id."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ChecklistItemPatchSerializer, responses={200: ChecklistItemSerializer})
    def patch(self, request: Request, item_id: UUID) -> Response:
        item = _get_checklist_item_as_party(request, item_id)
        serializer = ChecklistItemPatchSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        item = _call_service(
            services.patch_checklist_item,
            item,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ChecklistItemSerializer(item).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request, item_id: UUID) -> Response:
        item = _get_checklist_item_as_party(request, item_id)
        _call_service(services.delete_checklist_item, item, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChecklistRecommendationsView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ChecklistRecommendationSerializer(many=True)})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        recommendations = services.recommend_checklist_items(milestone)
        return Response(ChecklistRecommendationSerializer(recommendations, many=True).data)


class ContractMaterialListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ContractMaterialSerializer(many=True)})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        materials = selectors.list_materials(milestone)
        return Response(ContractMaterialSerializer(materials, many=True).data)

    @extend_schema(
        request=ContractMaterialCreateSerializer, responses={201: ContractMaterialSerializer}
    )
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = ContractMaterialCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        material = _call_service(
            services.create_material,
            milestone,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractMaterialSerializer(material).data, status=status.HTTP_201_CREATED)


# --- Э4.6: гейт, сдача, приёмка (docs/tasks/etap-4.md) ----------------------


def _get_material_as_party(request: Request, material_id: UUID) -> ContractMaterial:
    material = selectors.get_material_or_404(material_id)
    if not contracts_services.is_party(material.milestone.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return material


class MilestoneGateStatusView(APIView):
    """GET /milestones/{id}/gate — вне таблицы tech-spec.md §8.5 (§6.3
    описывает гейт как предикат `can_start()`, не готовый эндпоинт; здесь —
    видимость причины блокировки ДО попытки `POST .../start`, тот же приём,
    что `POST .../milestones/loan-schedule` в Э4.3)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: dict})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        return Response(services.gate_status(milestone))


class MilestoneStartView(APIView):
    """POST /milestones/{id}/start — вне таблицы tech-spec.md §8.5 (см.
    докстринг `services.start_milestone`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: MilestoneSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        milestone = _call_service(
            services.start_milestone, milestone, user=cast(User, request.user)
        )
        return Response(MilestoneSerializer(milestone).data)


class MilestoneTimelineView(APIView):
    """GET /milestones/{id}/timeline — вне таблицы tech-spec.md §8.5 (см.
    докстринг `selectors.get_timeline`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: TimelineEventSerializer(many=True)})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        events = selectors.get_timeline(milestone, locale=resolve_request_locale(request))
        return Response(TimelineEventSerializer(events, many=True).data)


class MilestoneAcceptanceStatusView(APIView):
    """GET /milestones/{id}/acceptance (tech-spec.md §8.5)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: dict})
    def get(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        return Response(selectors.acceptance_window_status(milestone))


class MilestoneSubmitView(APIView):
    """POST /milestones/{id}/submit (tech-spec.md §8.5)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=MilestoneSubmitSerializer, responses={200: MilestoneSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = MilestoneSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        milestone = _call_service(
            services.submit_milestone,
            milestone,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(MilestoneSerializer(milestone).data)


class MilestoneAcceptView(APIView):
    """POST /milestones/{id}/accept (tech-spec.md §8.5)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: MilestoneSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        milestone = _call_service(
            services.accept_milestone, milestone, user=cast(User, request.user)
        )
        return Response(MilestoneSerializer(milestone).data)


class MilestoneRejectView(APIView):
    """POST /milestones/{id}/reject (tech-spec.md §8.5, ADR-017)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=MilestoneRejectSerializer, responses={200: MilestoneSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = MilestoneRejectSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        milestone = _call_service(
            services.reject_milestone,
            milestone,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(MilestoneSerializer(milestone).data)


class MaterialProblemNoticeView(APIView):
    """POST /materials/{id}/problem-notice (tech-spec.md §8.5, ADR-019)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=MaterialProblemNoticeSerializer, responses={200: MilestoneSerializer})
    def post(self, request: Request, material_id: UUID) -> Response:
        material = _get_material_as_party(request, material_id)
        serializer = MaterialProblemNoticeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        milestone = _call_service(
            services.raise_material_problem,
            material,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(MilestoneSerializer(milestone).data)


class MaterialHandedOverView(APIView):
    """POST /materials/{id}/handed-over (ADR-155) — сторона-источник
    отмечает, что передала. Необязательный сигнал: гейт этапа его не ждёт."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractMaterialSerializer})
    def post(self, request: Request, material_id: UUID) -> Response:
        material = _get_material_as_party(request, material_id)
        material = _call_service(
            services.confirm_material_handed_over, material, user=cast(User, request.user)
        )
        return Response(ContractMaterialSerializer(material).data)


class MaterialReceivedView(APIView):
    """POST /materials/{id}/received (tech-spec.md §8.5) — отметка получения
    (ADR-155): только принимающая сторона; предварительное «передано» не
    требуется (владелец 03.09 — получение можно отметить односторонне)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractMaterialSerializer})
    def post(self, request: Request, material_id: UUID) -> Response:
        material = _get_material_as_party(request, material_id)
        material = _call_service(
            services.confirm_material_received, material, user=cast(User, request.user)
        )
        return Response(ContractMaterialSerializer(material).data)


class ContractMaterialDetailView(APIView):
    """PATCH/DELETE /materials/{id} (ADR-155) — правка и удаление материала
    до подписания (409 `contract_immutable` после), по образцу
    `ChecklistItemDetailView`: плоский путь, материал адресуется своим id."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=ContractMaterialPatchSerializer, responses={200: ContractMaterialSerializer}
    )
    def patch(self, request: Request, material_id: UUID) -> Response:
        material = _get_material_as_party(request, material_id)
        serializer = ContractMaterialPatchSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        material = _call_service(
            services.patch_material,
            material,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractMaterialSerializer(material).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request, material_id: UUID) -> Response:
        material = _get_material_as_party(request, material_id)
        _call_service(services.delete_material, material, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)
