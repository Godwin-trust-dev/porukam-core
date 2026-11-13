"""API apps.payments (tech-spec.md §8.7; ADR-130).

Здесь же живёт УНАСЛЕДОВАННЫЙ `POST /milestones/{id}/confirm-payment`. Он
переехал из `apps.milestones.api` вместе с ответственностью: раз `Payment` —
источник правды о деньгах, а `apps.milestones` не имеет права импортировать
`apps.payments`
(транзитивный контракт import-linter, см. докстринг services.py),
единственный способ провести старый URL через новый домен — отдать сам
эндпоинт платежам. URL, тело и форма ответа при этом НЕ меняются: фронт
(`web/src/features/stageExecution/realApi.ts`,
`RealPaymentsPanel`, `StagePage`) продолжает работать без правок.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts import services as contracts_services
from apps.milestones import selectors as milestones_selectors
from apps.milestones import services as milestones_services
from apps.milestones.api.serializers import MilestoneSerializer
from apps.milestones.models import Milestone
from common.api import idempotency
from common.api.exceptions import DomainAPIError
from common.fsm import InvalidTransitionError

from .. import selectors, services
from ..models import Payment, ProviderWebhookEvent
from ..providers import (
    MalformedWebhookError,
    PaymentProviderNotConfiguredError,
    PaymentProviderUnknownError,
    get_provider,
)
from .serializers import (
    ConfirmSideSerializer,
    PaymentCancelSerializer,
    PaymentConfirmSerializer,
    PaymentListSerializer,
    PaymentSerializer,
    WebhookAckSerializer,
)

_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] = {
    contracts_services.NotAPartyError: (
        status.HTTP_403_FORBIDDEN,
        "permission_denied",
        "Вы не сторона этого договора",
    ),
    services.PaymentSideMismatchError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_confirmation_side",
        "Нельзя подтвердить за контрагента",
    ),
    milestones_services.WrongConfirmationSideError: (
        status.HTTP_403_FORBIDDEN,
        "wrong_confirmation_side",
        "Нельзя подтвердить за контрагента",
    ),
    PaymentProviderNotConfiguredError: (
        status.HTTP_409_CONFLICT,
        "payment_provider_not_configured",
        "Оплата через платформу появится вместе с платёжным модулем",
    ),
    PaymentProviderUnknownError: (
        status.HTTP_404_NOT_FOUND,
        "not_found",
        "Платёжный провайдер не найден",
    ),
    MalformedWebhookError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "webhook_malformed",
        "Вебхук не разобран",
    ),
    services.ContractNotSignedError: (
        status.HTTP_409_CONFLICT,
        "contract_not_signed",
        "Счёт выставляется только по подписанному договору",
    ),
    services.MilestoneNotPayableError: (
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "milestone_not_payable",
        "Оплачивается только денежный лист дерева этапов",
    ),
    idempotency.IdempotencyKeyReusedError: (
        status.HTTP_409_CONFLICT,
        "idempotency_key_reused",
        "Idempotency-Key уже использован с другим телом запроса",
    ),
    InvalidTransitionError: (
        status.HTTP_409_CONFLICT,
        "invalid_payment_transition",
        "Недопустимое действие для текущего статуса платежа",
    ),
    services.PaymentNotCancellableError: (
        status.HTTP_409_CONFLICT,
        "payment_not_cancellable",
        "Оплата до начала этапа не отменяется — она условие начала этапа",
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


def _idempotent_call(
    request: Request,
    *,
    endpoint: str,
    fn: Any,  # noqa: ANN401
    kwargs: dict[str, Any],
    build_body: Any,  # noqa: ANN401
    required: bool = True,
) -> Response:
    """Idempotency-Key на денежных POST (CLAUDE.md) — тот же приём, что
    `apps.contracts.api.views._idempotent_call`.

    `required=False` — только для УНАСЛЕДОВАННЫХ `/milestones/{id}/confirm-*`:
    их контракт существует с Э4.6, и часть клиентов (в т. ч. собственные
    API-тесты apps.milestones) заголовка не шлёт. Сделать его обязательным
    задним числом значило бы сломать работающий фронт ради формальности —
    тем более что сама операция идемпотентна ПО ПОСТРОЕНИЮ (повтор той же
    стороной возвращает текущее состояние, см. services.confirm_by_payer).
    Заголовок, если он всё же пришёл, честно отрабатывается.
    """
    user = cast(User, request.user)
    key: str | None
    try:
        key = idempotency.require_idempotency_key(request)
    except idempotency.IdempotencyKeyRequiredError as exc:
        if required:
            raise DomainAPIError(
                status_code=status.HTTP_400_BAD_REQUEST,
                code="idempotency_key_required",
                title="Заголовок Idempotency-Key обязателен",
                detail=str(exc),
            ) from exc
        key = None

    if key is not None:
        cached = _call_service(
            idempotency.lookup, user=user, endpoint=endpoint, key=key, body=request.data
        )
        if cached is not None:
            return Response(cached.body, status=cached.status_code)

    result = _call_service(fn, **kwargs)
    body = build_body(result)
    if key is not None:
        idempotency.store(
            user=user,
            endpoint=endpoint,
            key=key,
            body=request.data,
            status_code=status.HTTP_200_OK,
            response_body=body,
        )
    return Response(body, status=status.HTTP_200_OK)


def _get_contract_as_party(request: Request, contract_id: UUID) -> Any:  # noqa: ANN401
    contract = contracts_selectors.get_contract_or_404(contract_id)
    if not contracts_services.is_party(contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return contract


def _get_payment_as_party(request: Request, payment_id: UUID) -> Payment:
    payment = selectors.get_payment_or_404(payment_id)
    if not contracts_services.is_party(payment.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return payment


def _get_milestone_as_party(request: Request, milestone_id: UUID) -> Milestone:
    milestone = milestones_selectors.get_milestone_or_404(milestone_id)
    if not contracts_services.is_party(milestone.contract, cast(User, request.user)):
        raise DomainAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="permission_denied",
            title="Вы не сторона этого договора",
        )
    return milestone


class ContractPaymentsView(APIView):
    """`GET /v1/contracts/{id}/payments` — платежи договора."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PaymentListSerializer})
    def get(self, request: Request, contract_id: UUID) -> Response:
        contract = _get_contract_as_party(request, contract_id)
        # «Read-repair»: счета материализуются подписчиком outbox, но реле
        # — фоновый свип (ADR-064), а карточка договора открывается сразу
        # после приёмки. Вызов идемпотентен (UNIQUE (milestone, kind)), см.
        # services.ensure_contract_payments.
        _call_service(services.ensure_contract_payments, contract)
        user = cast(User, request.user)
        items = [
            selectors.payment_view(payment, user=user)
            for payment in selectors.list_for_contract(contract)
        ]
        return Response({"items": PaymentSerializer(items, many=True).data})


class PaymentDetailView(APIView):
    """`GET /v1/payments/{id}` (tech-spec.md §8.7)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PaymentSerializer})
    def get(self, request: Request, payment_id: UUID) -> Response:
        payment = _get_payment_as_party(request, payment_id)
        view = selectors.payment_view(payment, user=cast(User, request.user))
        return Response(PaymentSerializer(view).data)


class PaymentConfirmView(APIView):
    """`POST /v1/payments/{id}/confirm` (tech-spec.md §8.7)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=PaymentConfirmSerializer, responses={200: PaymentSerializer})
    def post(self, request: Request, payment_id: UUID) -> Response:
        payment = _get_payment_as_party(request, payment_id)
        serializer = PaymentConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        return _idempotent_call(
            request,
            endpoint="payments.confirm",
            fn=services.confirm,
            kwargs={
                "payment": payment,
                "user": user,
                "side": serializer.validated_data.get("side"),
            },
            build_body=lambda result: (
                PaymentSerializer(selectors.payment_view(result, user=user)).data
            ),
        )


class PaymentCancelView(APIView):
    """`POST /v1/payments/{id}/cancel` — отзыв ошибочно выставленного счёта."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=PaymentCancelSerializer, responses={200: PaymentSerializer})
    def post(self, request: Request, payment_id: UUID) -> Response:
        payment = _get_payment_as_party(request, payment_id)
        serializer = PaymentCancelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = cast(User, request.user)
        return _idempotent_call(
            request,
            endpoint="payments.cancel",
            fn=services.cancel_payment,
            kwargs={
                "payment": payment,
                "user": user,
                "reason": serializer.validated_data.get("reason", ""),
            },
            build_body=lambda result: (
                PaymentSerializer(selectors.payment_view(result, user=user)).data
            ),
        )


class PaymentWebhookView(APIView):
    """`POST /v1/payments/webhooks/{provider}` — адаптер входящих
    уведомлений партнёра (tech-spec.md §8.7 «вебхуки с проверкой подписи»).

    Без аутентификации сессией: зовёт партнёр, не пользователь. Проверка
    подписи — обязанность конкретного провайдера (`parse_webhook`); у
    `manual` подписывать нечего, партнёра нет.

    ИДЕМПОТЕНТНОСТЬ (CLAUDE.md) — на `UNIQUE (provider, event_id)`, а не на
    «мы уже отвечали 200»: партнёр переотправляет доставку и после
    успешного ответа, если оборвалась сеть. Повтор возвращает 200 со
    `status="duplicate"` и НЕ применяет эффект повторно.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []

    @extend_schema(request=None, responses={200: WebhookAckSerializer})
    def post(self, request: Request, provider: str) -> Response:
        adapter = _call_service(get_provider, provider)
        body = request.data if isinstance(request.data, dict) else {}
        event = _call_service(adapter.parse_webhook, body=body, headers=dict(request.headers))
        existing = ProviderWebhookEvent.objects.filter(
            provider=provider, event_id=event.event_id
        ).first()
        if existing is not None:
            return Response(
                WebhookAckSerializer({"status": "duplicate", "outcome": existing.outcome}).data
            )
        outcome = adapter.apply_webhook(event)
        ProviderWebhookEvent.objects.create(
            provider=provider, event_id=event.event_id, payload=event.raw, outcome=outcome
        )
        return Response(WebhookAckSerializer({"status": "accepted", "outcome": outcome}).data)


# --- Унаследованные эндпоинты контура этапа (URL не менялся) --------------


def _legacy_confirm(request: Request, milestone: Milestone, *, kind: str, side: str) -> Response:
    """Тело унаследованного `POST /milestones/{id}/confirm-payment`.

    Порядок шагов важен: сначала ДОМЕННЫЕ гейты прежнего контура (иначе
    ошибочный вызов оставил бы за собой висящий счёт `pending`, которого
    никто не выставлял), потом материализация `Payment`, потом
    подтверждение. `side` из тела сверяется с ролью вызывающего — как и до
    ADR-130 («нельзя подтвердить за контрагента», 403).

    Коды ошибок сохранены от Э4.6 (`invalid_milestone_transition`, а не
    платёжный `invalid_payment_transition`): у этих URL уже есть клиенты,
    и переименовывать их коды ради внутренней реорганизации нельзя.
    """
    contract = milestone.contract
    if services.payment_before_start(contract):
        # ADR-155: платят ДО старта — лист ещё `pending`, гейт «этап принят»
        # здесь неприменим (`apps.milestones.services.confirm_payment`
        # снимает его тем же условием).
        pass
    elif milestone.status != Milestone.Status.ACCEPTED:
        # Тот же гейт, что `apps.milestones.services.confirm_payment`
        # держал «для читаемой 409-ошибки», только ДО создания платежа.
        try:
            milestones_services.MILESTONE_FSM.assert_transition("pay", milestone.status)
        except InvalidTransitionError as exc:
            raise DomainAPIError(
                status_code=status.HTTP_409_CONFLICT,
                code="invalid_milestone_transition",
                title="Недопустимое действие для текущего статуса этапа",
                detail=str(exc),
            ) from exc

    payment: Payment
    payment, _created = _call_service(services.create_payment, milestone, kind=kind)
    user = cast(User, request.user)
    requested_side = services.side_of(side)

    def _confirm(**_: Any) -> Milestone:
        services.confirm(payment, user=user, side=requested_side)
        payment.milestone.refresh_from_db()
        return payment.milestone

    return _idempotent_call(
        request,
        endpoint=f"payments.legacy_confirm.{kind}",
        fn=_confirm,
        kwargs={},
        build_body=lambda result: MilestoneSerializer(result).data,
        required=False,
    )


class MilestoneConfirmPaymentView(APIView):
    """`POST /v1/milestones/{id}/confirm-payment` — двустороннее
    подтверждение оплаты листа. При `payment_order=after_acceptance` это
    `accepted -> paid`; при `before_start` (ADR-155) тот же URL обслуживает
    оплату ДО старта, а лист закрывается `paid` в момент приёмки. URL и
    контракт унаследованы от Э4.6; теперь за ним стоит `Payment`."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ConfirmSideSerializer, responses={200: MilestoneSerializer})
    def post(self, request: Request, milestone_id: UUID) -> Response:
        milestone = _get_milestone_as_party(request, milestone_id)
        serializer = ConfirmSideSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return _legacy_confirm(
            request,
            milestone,
            kind=Payment.Kind.POSTPAYMENT,
            side=serializer.validated_data["side"],
        )
