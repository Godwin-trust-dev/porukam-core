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
from apps.authority import services as authority_services
from apps.catalog import services as catalog_services
from apps.catalog.models import ContractTypeCatalogItem
from apps.milestones import services as milestones_services
from common.api import idempotency
from common.api.exceptions import DomainAPIError
from common.fsm import InvalidTransitionError
from common.i18n import resolve_request_locale
from common.money import CurrencyMismatchError

from .. import disclaimer_texts, forms, selectors, services
from ..models import (
    Amendment,
    ContractParty,
    PreapprovedAlternative,
    RevisionProposal,
    Signature,
    SignatureRequest,
)
from .serializers import (
    AcceptAllRevisionsSerializer,
    AmendmentCloseSerializer,
    AmendmentCreateSerializer,
    AmendmentSerializer,
    AmendmentUpdateSerializer,
    ContractCreateSerializer,
    ContractPatchSerializer,
    ContractSerializer,
    ContractTerminateSerializer,
    ContractVersionSerializer,
    DeclineForRevisionSerializer,
    ForwardSignatureRequestSerializer,
    MaterialsSeenSerializer,
    MaterialsSeenStateSerializer,
    PreapprovedAlternativeCreateSerializer,
    PreapprovedAlternativeSerializer,
    ReturnForRevisionSerializer,
    RevisionProposalCounterSerializer,
    RevisionProposalCreateSerializer,
    RevisionProposalSerializer,
    SignatoryOptionSerializer,
    SignatureRequestCreateSerializer,
    SignatureRequestSerializer,
    SignatureSerializer,
    SignRequestSerializer,
    TimelineEventSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    services.ClientOptionRequiresExplicitCodeError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "client_option_requires_code",
        "Для этой опции нужен явный тип договора",
    ),
    services.CounterpartyNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "counterparty_not_found",
        "Контрагент не найден",
    ),
    services.CounterpartyIsGroupError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "counterparty_is_group",
        "Группа не может быть стороной договора",
    ),
    services.SelfDealingError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "self_dealing",
        "Нельзя заключить договор с самим собой",
    ),
    services.EntityNotControlledError: (
        status.HTTP_403_FORBIDDEN,
        "entity_not_controlled",
        "Контроль над юрлицом не подтверждён",
    ),
    services.SourceContractNotAccessibleError: (
        status.HTTP_404_NOT_FOUND,
        "source_contract_not_accessible",
        "Исходный договор недоступен",
    ),
    services.DraftNotEditableError: (
        status.HTTP_409_CONFLICT,
        "draft_not_editable",
        "Договор больше не черновик — правки только через протокол разногласий",
    ),
    services.LanguageNotEligibleError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "language_not_eligible",
        "Этот язык пока недоступен как официальный язык договора",
    ),
    services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
    services.PaymentMethodRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "payment_method_required",
        "Выберите способ оплаты, прежде чем отправлять договор",
    ),
    services.PaymentOrderRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "payment_order_required",
        "Выберите порядок оплаты, прежде чем отправлять договор",
    ),
    services.PaymentOrderNotApplicableError: (
        status.HTTP_400_BAD_REQUEST,
        "payment_order_not_applicable",
        "Порядок оплаты неприменим к этому типу договора",
    ),
    services.NotInitiatorError: (
        status.HTTP_403_FORBIDDEN,
        "not_initiator",
        "Отозвать договор может только инициатор",
    ),
    services.NotCounterpartyError: (
        status.HTTP_403_FORBIDDEN,
        "not_counterparty",
        "Отклонить договор может только контрагент, не инициатор",
    ),
    services.OwnProposalDecisionError: (
        status.HTTP_403_FORBIDDEN,
        "own_proposal_decision",
        "Нельзя принять/отклонить/встречно отредактировать собственное предложение",
    ),
    services.RevisionProposalNotOpenError: (
        status.HTTP_409_CONFLICT,
        "revision_not_open",
        "Предложение уже не открыто",
    ),
    # ADR-123: `item_ref` = form.<key> с ключом вне схемы формы типа договора.
    services.RevisionItemUnknownError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "revision_item_unknown",
        "Такого поля нет в форме этого типа договора",
    ),
    InvalidTransitionError: (
        status.HTTP_409_CONFLICT,
        "invalid_negotiation_transition",
        "Недопустимое действие для текущего статуса согласования",
    ),
    catalog_services.ContractTypeExcludedError: (
        status.HTTP_403_FORBIDDEN,
        "contract_type_excluded",
        "Платформа такой тип сделки не готовит",
    ),
    catalog_services.ContractTypeNotYetSupportedError: (
        status.HTTP_409_CONFLICT,
        "not_yet_supported",
        "Этот тип сделки скоро",
    ),
    # --- Э4.4: заморозка и подписание ---------------------------------------
    services.OpenRevisionsError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "open_revisions",
        "У договора есть открытые правки",
    ),
    services.EmptyMilestoneTreeError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "leaf_sum_mismatch",
        "Дерево этапов пусто — нечего замораживать",
    ),
    services.RequisitesMissingError: (
        status.HTTP_409_CONFLICT,
        "requisites_missing",
        "Реквизиты выплат исполнителя не заполнены",
    ),
    services.StaleVersionError: (
        status.HTTP_409_CONFLICT,
        "version_stale",
        "Версия договора устарела",
    ),
    services.SignatureRequestAlreadyPendingError: (
        status.HTTP_409_CONFLICT,
        "signature_request_already_pending",
        "У этой стороны уже есть незакрытый запрос подписи",
    ),
    services.SignatoryNotEligibleError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "signatory_not_eligible",
        "Указанный подписант недоступен для этой стороны",
    ),
    services.NotThisSidePartyError: (
        status.HTTP_403_FORBIDDEN,
        "not_this_side_party",
        "Маршрутизировать подпись может только сама эта сторона",
    ),
    services.NotTheSignatoryError: (
        status.HTTP_403_FORBIDDEN,
        "not_the_signatory",
        "Вы не адресат этого запроса подписи",
    ),
    services.SignatureRequestNotPendingError: (
        status.HTTP_409_CONFLICT,
        "signature_request_not_pending",
        "Запрос подписи уже разрешён",
    ),
    # ADR-096: право подписи невалидно К МОМЕНТУ подписи (МЧД отозвана,
    # право истекло/отозвано, сумма вышла за лимит).
    authority_services.SigningAuthorityNoLongerValidError: (
        status.HTTP_409_CONFLICT,
        "signing_authority_invalid",
        "Право подписи недействительно на момент подписания",
    ),
    idempotency.IdempotencyKeyReusedError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "idempotency_key_reused",
        "Idempotency-Key уже использован с другим телом запроса",
    ),
    # --- Э4.5: допники -------------------------------------------------------
    services.ContractNotSignedError: (
        status.HTTP_409_CONFLICT,
        "contract_not_signed",
        "Допник можно завести только к подписанному договору",
    ),
    services.AmendmentRemoveTargetNotLeafError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "amendment_remove_target_not_leaf",
        "Убрать допником можно только лист дерева",
    ),
    services.AmendmentTargetsAcceptedMilestoneError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "amendment_targets_accepted",
        "Нельзя удешевить или убрать уже принятый этап",
    ),
    services.AmendmentTargetsReceivedMaterialError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "amendment_targets_received_material",
        "Нельзя убрать уже полученный материал",
    ),
    services.AmendmentChangeTargetNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "amendment_change_target_not_found",
        "Цель изменения не найдена в этом договоре",
    ),
    services.AmendmentNotDraftError: (
        status.HTTP_409_CONFLICT,
        "amendment_not_draft",
        "Допсоглашение уже отправлено — править и удалять можно только черновик",
    ),
    CurrencyMismatchError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "currency_mismatch",
        "Изменения допника смешивают валюты",
    ),
    # Исключения apps.milestones.services, реально достижимые через payload
    # изменений допника (apply_amendment_*/_create_amendment_change) — тот же
    # набор кодов, что milestones/api/views.py маппит для своих собственных
    # эндпоинтов, здесь не копируется логика, только реестр HTTP-кодов.
    milestones_services.CurrencyNotActiveError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "currency_not_active",
        "Валюта не активна в справочнике",
    ),
    milestones_services.MoneyPairRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "money_pair_required",
        "amount и currency указываются только вместе",
    ),
    milestones_services.MaterialCatalogItemNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "material_catalog_item_not_found",
        "Позиция каталога материалов не найдена",
    ),
    milestones_services.SphereNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "sphere_not_found",
        "Сфера не найдена",
    ),
    milestones_services.MaterialPriceRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "material_price_required",
        "Исполнитель не может поставлять материал по нулевой цене",
    ),
    milestones_services.MilestoneWrongContractError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_wrong_contract",
        "Этап принадлежит другому договору",
    ),
    milestones_services.MilestoneDepthExceededError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_depth_exceeded",
        "Превышена максимальная глубина дерева этапов",
    ),
    milestones_services.MilestoneAmountGuardError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_amount_guard",
        "Сумма недопустима для этого узла дерева",
    ),
    milestones_services.MilestoneHasLeafContentError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_has_leaf_content",
        "У этапа уже есть чек-лист/материалы — он лист, не ветка",
    ),
    milestones_services.MilestoneNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "milestone_not_found",
        "Этап не найден",
    ),
    milestones_services.ContractMaterialNotFoundError: (
        status.HTTP_404_NOT_FOUND,
        "contract_material_not_found",
        "Материал не найден",
    ),
    # --- Э4.6: исполнение договора, заглушки расторжения ---------------------
    services.InvalidExecutionTransitionError: (
        status.HTTP_409_CONFLICT,
        "invalid_execution_transition",
        "Недопустимое действие для текущего статуса исполнения",
    ),
    services.TerminationReasonRequiredError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "termination_reason_required",
        "Расторжение исполнителем требует основания",
    ),
}


def _call_service(fn: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
    try:
        return fn(*args, **kwargs)
    except forms.FormValidationError as exc:
        # П-16 (etap-4-delta-p16.md п.3): жёсткие нарушения схемы формы —
        # список ошибок по полям в context, не строкой в detail.
        raise DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="form_data_invalid",
            title="form_data не соответствует схеме",
            context={"errors": exc.errors},
        ) from exc
    except services.AdditionalTermsInvalidError as exc:
        # ADR-167: ручной ввод дополнительных условий в мастере — тот же
        # формат ошибок по полям (`additional_terms.<i>`), что у form_data.
        raise DomainAPIError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="additional_terms_invalid",
            title="Дополнительные условия не проходят проверку",
            context={"errors": exc.errors},
        ) from exc
    except services.RevisionValueInvalidError as exc:
        # ADR-123: значение правки не прошло схему при применении — тот же
        # формат ошибок по полям, предложение остаётся open.
        raise DomainAPIError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="revision_value_invalid",
            title="Значение правки не проходит проверку",
            context={"errors": exc.errors},
        ) from exc
    except tuple(_SERVICE_ERROR_STATUS) as exc:
        status_code, code, title = _SERVICE_ERROR_STATUS[type(exc)]
        raise DomainAPIError(
            status_code=status_code, code=code, title=title, detail=str(exc)
        ) from exc


def _get_contract_as_party(request: Request, contract_id: UUID) -> Any:  # noqa: ANN401
    contract = selectors.get_contract_or_404(contract_id)
    if not services.is_party(contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return contract


def _get_revision_proposal_as_party(
    request: Request, revision_proposal_id: UUID
) -> RevisionProposal:
    proposal = selectors.get_revision_proposal_or_404(revision_proposal_id)
    if not services.is_party(proposal.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return proposal


def _idempotent_call(
    request: Request,
    *,
    endpoint: str,
    fn: Any,  # noqa: ANN401
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    build_body: Any,  # noqa: ANN401
    success_status: int,
) -> Response:
    """Idempotency-Key на денежных/подписных POST (CLAUDE.md, etap-4.md
    Э4.4, common/api/idempotency.py): повторный вызов с тем же ключом и тем
    же телом возвращает СОХРАНЁННЫЙ ответ первого вызова вместо повторного
    прогона сервиса. `build_body(result) -> dict` — сериализация результата
    сервиса в тело ответа (тот же словарь и сохраняется, и отдаётся)."""
    try:
        key = idempotency.require_idempotency_key(request)
    except idempotency.IdempotencyKeyRequiredError as exc:
        raise DomainAPIError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="idempotency_key_required",
            title="Заголовок Idempotency-Key обязателен",
            detail=str(exc),
        ) from exc

    user = cast(User, request.user)
    cached = _call_service(
        idempotency.lookup, user=user, endpoint=endpoint, key=key, body=request.data
    )
    if cached is not None:
        return Response(cached.body, status=cached.status_code)

    result = _call_service(fn, *args, **kwargs)
    body = build_body(result)
    idempotency.store(
        user=user,
        endpoint=endpoint,
        key=key,
        body=request.data,
        status_code=success_status,
        response_body=body,
    )
    return Response(body, status=success_status)


def _get_preapproved_alternative_as_party(
    request: Request, alternative_id: UUID
) -> PreapprovedAlternative:
    alternative = selectors.get_preapproved_alternative_or_404(alternative_id)
    if not services.is_party(alternative.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return alternative


class ContractListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ContractSerializer(many=True)})
    def get(self, request: Request) -> Response:
        contracts = selectors.list_my_contracts(
            cast(User, request.user),
            role=request.query_params.get("role"),
            negotiation_status=request.query_params.get("negotiation_status"),
            segment=request.query_params.get("segment"),
        )
        return Response(ContractSerializer(contracts, many=True, context={"request": request}).data)

    @extend_schema(request=ContractCreateSerializer, responses={201: ContractSerializer})
    def post(self, request: Request) -> Response:
        serializer = ContractCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        contract = _call_service(
            services.create_draft, user=cast(User, request.user), **serializer.validated_data
        )
        return Response(
            ContractSerializer(contract, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ContractDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ContractSerializer})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        return Response(ContractSerializer(contract, context={"request": request}).data)

    @extend_schema(request=ContractPatchSerializer, responses={200: ContractSerializer})
    def patch(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = ContractPatchSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        contract = _call_service(
            services.patch_draft,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)

    @extend_schema(responses={204: None})
    def delete(self, request: Request, contract_id: UUID) -> Response:
        """DELETE /contracts/{id} — только черновик (иначе 409 `draft_not_editable`),
        любой из сторон."""
        contract = _get_contract_as_party(request, contract_id)
        _call_service(services.delete_draft, contract, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContractMaterialsSeenView(APIView):
    """POST /contracts/{id}/materials-seen (ADR-158) — сторона отметила
    материалы этапов просмотренными. Только участник договора (403 чужому —
    общий `_get_contract_as_party`), идемпотентно: отметка монотонна, повтор
    с тем же моментом не меняет состояние."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=MaterialsSeenSerializer, responses={200: MaterialsSeenStateSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = MaterialsSeenSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        party = _call_service(
            services.mark_materials_seen,
            contract,
            user=cast(User, request.user),
            seen_at=serializer.validated_data["seen_at"],
        )
        return Response(
            MaterialsSeenStateSerializer({"materials_seen_at": party.materials_seen_at}).data
        )


# --- Э4.2: FSM согласования, протокол разногласий, timeline -----------------


class ContractSendView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        contract = _call_service(services.send_for_review, contract, user=cast(User, request.user))
        return Response(ContractSerializer(contract, context={"request": request}).data)


class ContractWithdrawView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        contract = _call_service(
            services.withdraw_negotiation, contract, user=cast(User, request.user)
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


class ContractRejectView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        contract = _call_service(
            services.reject_negotiation, contract, user=cast(User, request.user)
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


class ContractReturnForRevisionView(APIView):
    """POST /contracts/{id}/return-for-revision (ADR-124): возврат договора
    с этапа подписания на согласование любой стороной, комментарий
    обязателен. Замороженные состояния только — иначе 409 (общий маппинг
    `InvalidTransitionError`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ReturnForRevisionSerializer, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = ReturnForRevisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        contract = _call_service(
            services.return_for_revision,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


# --- Э4.6: расторжение (заглушки эндпоинтов, полный контур — этап 7) -------


class ContractTerminateByCustomerView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ContractTerminateSerializer, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = ContractTerminateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        contract = _call_service(
            services.terminate_by_customer,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


class ContractTerminateByContractorView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=ContractTerminateSerializer, responses={200: ContractSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = ContractTerminateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        contract = _call_service(
            services.terminate_by_contractor,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


class ContractTimelineView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: TimelineEventSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        events = selectors.get_timeline(contract, locale=resolve_request_locale(request))
        return Response(TimelineEventSerializer(events, many=True).data)


class RevisionProposalListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: RevisionProposalSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        proposals = selectors.list_revision_proposals(
            contract, status=request.query_params.get("status")
        )
        return Response(RevisionProposalSerializer(proposals, many=True).data)

    @extend_schema(
        request=RevisionProposalCreateSerializer, responses={201: RevisionProposalSerializer}
    )
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = RevisionProposalCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        proposal = _call_service(
            services.propose_revision,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(RevisionProposalSerializer(proposal).data, status=status.HTTP_201_CREATED)


class RevisionProposalsAcceptAllView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=AcceptAllRevisionsSerializer, responses={200: RevisionProposalSerializer(many=True)}
    )
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = AcceptAllRevisionsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            proposals = _call_service(
                services.accept_all_revisions,
                contract,
                user=cast(User, request.user),
                **serializer.validated_data,
            )
        except services.ConfirmSummaryRequiredError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                code="confirm_summary_required",
                title="Финансово значимые правки требуют подтверждения",
                detail=str(exc),
                context={"summary": exc.summary},
            ) from exc
        return Response(RevisionProposalSerializer(proposals, many=True).data)


class RevisionProposalAcceptView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: RevisionProposalSerializer})
    def post(self, request: Request, revision_proposal_id: UUID) -> Response:
        proposal = _get_revision_proposal_as_party(request, revision_proposal_id)
        proposal = _call_service(services.accept_revision, proposal, user=cast(User, request.user))
        return Response(RevisionProposalSerializer(proposal).data)


class RevisionProposalRejectView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: RevisionProposalSerializer})
    def post(self, request: Request, revision_proposal_id: UUID) -> Response:
        proposal = _get_revision_proposal_as_party(request, revision_proposal_id)
        proposal = _call_service(services.reject_revision, proposal, user=cast(User, request.user))
        return Response(RevisionProposalSerializer(proposal).data)


class RevisionProposalCounterView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=RevisionProposalCounterSerializer, responses={200: RevisionProposalSerializer}
    )
    def post(self, request: Request, revision_proposal_id: UUID) -> Response:
        proposal = _get_revision_proposal_as_party(request, revision_proposal_id)
        serializer = RevisionProposalCounterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        proposal = _call_service(
            services.counter_revision,
            proposal,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(RevisionProposalSerializer(proposal).data)


class PreapprovedAlternativeListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PreapprovedAlternativeSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        alternatives = selectors.list_preapproved_alternatives(contract)
        return Response(PreapprovedAlternativeSerializer(alternatives, many=True).data)

    @extend_schema(
        request=PreapprovedAlternativeCreateSerializer,
        responses={201: PreapprovedAlternativeSerializer},
    )
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = PreapprovedAlternativeCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        alternative = _call_service(
            services.create_preapproved_alternative,
            contract,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(
            PreapprovedAlternativeSerializer(alternative).data, status=status.HTTP_201_CREATED
        )


# --- П-16: схема формы по типу договора (etap-4-delta-p16.md п.4) -----------


def _get_form_schema_or_error(code: str) -> forms.FormSchema:
    try:
        return forms.get_form_schema(code)
    except forms.FormSchemaNotFoundError:
        pass
    # Код не входит в семёрку Р1 этой дельты — тот же 403/409, что при
    # создании договора этого типа (§6.6), иначе 404: тип либо не
    # существует, либо скрыт/спец/excluded в каталоге, схемы для него нет.
    try:
        ContractTypeCatalogItem.objects.get(code=code)
    except ContractTypeCatalogItem.DoesNotExist as exc:
        raise DomainAPIError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="not_found",
            title="Тип договора не найден",
        ) from exc
    try:
        catalog_services.compute_segment(code)
    except catalog_services.ContractTypeExcludedError as exc:
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="contract_type_excluded",
            title="Платформа такой тип сделки не готовит",
            detail=str(exc),
        ) from exc
    except catalog_services.ContractTypeNotYetSupportedError as exc:
        raise DomainAPIError(
            status_code=status.HTTP_409_CONFLICT,
            code="not_yet_supported",
            title="Этот тип сделки скоро",
            detail=str(exc),
        ) from exc
    raise DomainAPIError(
        status_code=status.HTTP_404_NOT_FOUND,
        code="not_found",
        title="Схема формы для этого типа договора ещё не готова",
    )


class ContractTypeFormSchemaView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: dict})
    def get(self, request: Request, code: str) -> Response:
        schema = _get_form_schema_or_error(code)
        return Response(forms.serialize_schema(schema))


class PreapprovedAlternativeApplyView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: RevisionProposalSerializer})
    def post(self, request: Request, alternative_id: UUID) -> Response:
        alternative = _get_preapproved_alternative_as_party(request, alternative_id)
        proposal = _call_service(
            services.apply_preapproved_alternative, alternative, user=cast(User, request.user)
        )
        return Response(RevisionProposalSerializer(proposal).data)


# --- Э4.4: заморозка и подписание --------------------------------------------


def _get_signature_request_as_party(
    request: Request, signature_request_id: UUID
) -> SignatureRequest:
    sig_request = selectors.get_signature_request_or_404(signature_request_id)
    if not services.is_party(sig_request.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return sig_request


class ContractFreezeView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractVersionSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        return _idempotent_call(
            request,
            endpoint="contracts.freeze",
            fn=services.freeze_contract,
            args=(contract,),
            kwargs={"user": cast(User, request.user)},
            build_body=lambda version: ContractVersionSerializer(version).data,
            success_status=status.HTTP_200_OK,
        )


class ContractVersionDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: ContractVersionSerializer})
    def get(self, request: Request, contract_id: UUID, version_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        version = selectors.get_contract_version_or_404(contract, version_id)
        # ETag/If-Match (CLAUDE.md: "редактируемые ресурсы — ETag/If-Match")
        # — ContractVersion неизменяема, `integrity_hash` сам по себе строгий
        # ETag (etap-4.md Э4.4: подпись адресуется именно ему).
        response = Response(ContractVersionSerializer(version).data)
        response["ETag"] = f'"{version.integrity_hash}"'
        return response


class ContractSignatoriesView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SignatoryOptionSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        side = request.query_params.get("side")
        if side not in (ContractParty.Role.CUSTOMER, ContractParty.Role.CONTRACTOR):
            raise DomainAPIError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="invalid_request",
                title="Параметр side обязателен: customer или contractor",
            )
        signatories = services.list_signatories(contract, side=side)
        return Response(SignatoryOptionSerializer(signatories, many=True).data)


class SignatureRequestListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SignatureRequestSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        return Response(
            SignatureRequestSerializer(selectors.list_signature_requests(contract), many=True).data
        )

    @extend_schema(
        request=SignatureRequestCreateSerializer, responses={201: SignatureRequestSerializer}
    )
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = SignatureRequestCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return _idempotent_call(
            request,
            endpoint="contracts.signature_requests.create",
            fn=services.route_signatory,
            args=(contract,),
            kwargs={"user": cast(User, request.user), **serializer.validated_data},
            build_body=lambda sig_request: SignatureRequestSerializer(sig_request).data,
            success_status=status.HTTP_201_CREATED,
        )


class SignatureRequestDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SignatureRequestSerializer})
    def get(self, request: Request, signature_request_id: UUID) -> Response:
        sig_request = _get_signature_request_as_party(request, signature_request_id)
        return Response(SignatureRequestSerializer(sig_request).data)


class SignatureRequestSignView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=SignRequestSerializer, responses={200: SignatureSerializer})
    def post(self, request: Request, signature_request_id: UUID) -> Response:
        sig_request = _get_signature_request_as_party(request, signature_request_id)
        serializer = SignRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Дуальная развилка (Э4.5): один эндпоинт для подписи и договора, и
        # допника — по наличию sig_request.amendment_id. services.sign/
        # sign_amendment одинаково принимают (request, *, user, version_hash),
        # переключение — единственная строка, вьюха не дублируется.
        sign_fn = services.sign_amendment if sig_request.amendment_id else services.sign

        def build_body(signature: Signature) -> dict[str, Any]:
            # Л.1 (docs/tasks/l10n-wave.md, п.3) — дисклеймер, ТОЛЬКО если
            # подписанту реально показан не-официальный рендер (services.sign
            # проставляет sig_request.locale на том же объекте — тот же приём,
            # что contract.negotiation_status выше по файлу; sign_amendment
            # locale не трогает, амендменты вне скоупа Л.1, disclaimer там не
            # появится, т.к. locale остаётся ""). Официальный рендер целиком —
            # по запросу через GET версии (ContractVersionDetailView,
            # `official_language`/`renders` в ContractVersionSerializer),
            # ссылку на версию клиент уже знает из `version_hash` ответа.
            data: dict[str, Any] = SignatureSerializer(signature).data
            shown_locale = sig_request.locale
            if shown_locale and shown_locale != sig_request.version.canonical_language:
                data["disclaimer"] = {
                    "locale": shown_locale,
                    "text": disclaimer_texts.get_disclaimer_text(
                        shown_locale=shown_locale,
                        official_language=sig_request.version.canonical_language,
                    ),
                }
            return data

        return _idempotent_call(
            request,
            endpoint="contracts.signature_requests.sign",
            fn=sign_fn,
            args=(sig_request,),
            kwargs={
                "user": cast(User, request.user),
                "version_hash": serializer.validated_data["version_hash"],
            },
            build_body=build_body,
            success_status=status.HTTP_200_OK,
        )


class SignatureRequestForwardView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=ForwardSignatureRequestSerializer, responses={200: SignatureRequestSerializer}
    )
    def post(self, request: Request, signature_request_id: UUID) -> Response:
        sig_request = _get_signature_request_as_party(request, signature_request_id)
        serializer = ForwardSignatureRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        forward_fn = (
            services.forward_amendment_signature_request
            if sig_request.amendment_id
            else services.forward_signature_request
        )
        sig_request = _call_service(
            forward_fn,
            sig_request,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(SignatureRequestSerializer(sig_request).data)


class SignatureRequestDeclineView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=DeclineForRevisionSerializer,
        responses={200: ContractSerializer},  # либо AmendmentSerializer — см. тело
    )
    def post(self, request: Request, signature_request_id: UUID) -> Response:
        sig_request = _get_signature_request_as_party(request, signature_request_id)
        serializer = DeclineForRevisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if sig_request.amendment_id:
            amendment = _call_service(
                services.decline_amendment_for_revision,
                sig_request,
                user=cast(User, request.user),
                **serializer.validated_data,
            )
            return Response(AmendmentSerializer(amendment).data)
        contract = _call_service(
            services.decline_for_revision,
            sig_request,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(ContractSerializer(contract, context={"request": request}).data)


# --- Э4.5: допники --------------------------------------------------------


def _get_amendment_as_party(request: Request, amendment_id: UUID) -> Amendment:
    amendment = selectors.get_amendment_or_404(amendment_id)
    user = cast(User, request.user)
    if not services.is_party(amendment.contract, user):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    # ADR-161: чужой ЧЕРНОВИК для второй стороны не существует — 404, а не
    # 403: 403 подтвердил бы, что заготовка заведена.
    if not selectors.is_amendment_visible_to(amendment, user):
        raise DomainAPIError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="not_found",
            title="Допсоглашение не найдено",
        )
    return amendment


class AmendmentListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: AmendmentSerializer(many=True)})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        # viewer (ADR-161): чужие черновики в список не попадают.
        amendments = selectors.list_amendments(contract, viewer=cast(User, request.user))
        return Response(AmendmentSerializer(amendments, many=True).data)

    @extend_schema(request=AmendmentCreateSerializer, responses={201: AmendmentSerializer})
    def post(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        serializer = AmendmentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return _idempotent_call(
            request,
            endpoint="contracts.amendments.create",
            fn=services.create_amendment,
            args=(contract,),
            kwargs={"user": cast(User, request.user), **serializer.validated_data},
            build_body=lambda amendment: AmendmentSerializer(amendment).data,
            success_status=status.HTTP_201_CREATED,
        )


class AmendmentDetailView(APIView):
    """GET / PATCH / DELETE /amendments/{id}. PATCH и DELETE (ADR-161) —
    только ЧЕРНОВИК и только его инициатор: не инициатор -> 403
    `not_initiator`, уже отправленный -> 409 `amendment_not_draft`.
    Idempotency-Key не требуется: правка заготовки — не денежная и не
    подписная операция (CLAUDE.md), повтор PATCH даёт то же состояние,
    повтор DELETE — 404."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: AmendmentSerializer})
    def get(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        return Response(AmendmentSerializer(amendment).data)

    @extend_schema(request=AmendmentUpdateSerializer, responses={200: AmendmentSerializer})
    def patch(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        serializer = AmendmentUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        amendment = _call_service(
            services.update_draft_amendment,
            amendment,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(AmendmentSerializer(amendment).data)

    @extend_schema(request=None, responses={204: None})
    def delete(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        _call_service(services.delete_draft_amendment, amendment, user=cast(User, request.user))
        return Response(status=status.HTTP_204_NO_CONTENT)


class AmendmentSendView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: AmendmentSerializer})
    def post(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        amendment = _call_service(
            services.send_amendment_for_review, amendment, user=cast(User, request.user)
        )
        return Response(AmendmentSerializer(amendment).data)


class AmendmentWithdrawView(APIView):
    """POST /amendments/{id}/withdraw (26.08, ADR-075): инициатор допника
    отзывает его из under_review / pending_signature / awaiting_signatures;
    раунд подписания допника аннулируется. Не инициатор -> 403
    `not_initiator`; подписанный/уже закрытый -> 409 (общий маппинг
    `InvalidTransitionError`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=AmendmentCloseSerializer, responses={200: AmendmentSerializer})
    def post(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        serializer = AmendmentCloseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        amendment = _call_service(
            services.withdraw_amendment,
            amendment,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(AmendmentSerializer(amendment).data)


class AmendmentRejectView(APIView):
    """POST /amendments/{id}/reject (26.08, ADR-075): вторая сторона
    отклоняет допник; инициатор -> 403 `not_counterparty`."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=AmendmentCloseSerializer, responses={200: AmendmentSerializer})
    def post(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        serializer = AmendmentCloseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        amendment = _call_service(
            services.reject_amendment,
            amendment,
            user=cast(User, request.user),
            **serializer.validated_data,
        )
        return Response(AmendmentSerializer(amendment).data)


class AmendmentFreezeView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={200: ContractVersionSerializer})
    def post(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        return _idempotent_call(
            request,
            endpoint="contracts.amendments.freeze",
            fn=services.freeze_amendment,
            args=(amendment,),
            kwargs={"user": cast(User, request.user)},
            build_body=lambda version: ContractVersionSerializer(version).data,
            success_status=status.HTTP_200_OK,
        )


class AmendmentSignatoriesView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SignatoryOptionSerializer(many=True)})
    def get(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        side = request.query_params.get("side")
        if side not in (ContractParty.Role.CUSTOMER, ContractParty.Role.CONTRACTOR):
            raise DomainAPIError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="invalid_request",
                title="Параметр side обязателен: customer или contractor",
            )
        signatories = services.list_signatories(amendment.contract, side=side)
        return Response(SignatoryOptionSerializer(signatories, many=True).data)


class AmendmentSignatureRequestListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: SignatureRequestSerializer(many=True)})
    def get(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        return Response(
            SignatureRequestSerializer(
                selectors.list_amendment_signature_requests(amendment), many=True
            ).data
        )

    @extend_schema(
        request=SignatureRequestCreateSerializer, responses={201: SignatureRequestSerializer}
    )
    def post(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        serializer = SignatureRequestCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return _idempotent_call(
            request,
            endpoint="contracts.amendments.signature_requests.create",
            fn=services.route_amendment_signatory,
            args=(amendment,),
            kwargs={"user": cast(User, request.user), **serializer.validated_data},
            build_body=lambda sig_request: SignatureRequestSerializer(sig_request).data,
            success_status=status.HTTP_201_CREATED,
        )


class AmendmentTimelineView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: TimelineEventSerializer(many=True)})
    def get(self, request: Request, amendment_id: UUID) -> Response:
        amendment = _get_amendment_as_party(request, amendment_id)
        events = selectors.get_amendment_timeline(amendment, locale=resolve_request_locale(request))
        return Response(TimelineEventSerializer(events, many=True).data)


class ContractEffectiveTermsView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: dict})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        return Response(services.effective_terms(contract))
