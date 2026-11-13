"""apps.payments.api — Э5 волна 1 (tech-spec.md §8.7; ADR-130).

Проверяются три разных вещи, которые легко перепутать:
1. новый контракт `/v1/payments/*` (включая Idempotency-Key на денежных POST);
2. СОВМЕСТИМОСТЬ унаследованных `/v1/milestones/{id}/confirm-*` — URL, тело и
   форма ответа обязаны остаться прежними, иначе переезд контура в
   apps.payments сломает работающий фронт;
3. что за унаследованным URL теперь действительно стоит `Payment`.
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.contracts.models import Contract
from apps.milestones.models import Milestone
from apps.payments import services
from apps.payments.models import Payment

from ._helpers import accept_leaf, make_signed_contract_with_leaf, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_METHOD = Contract.PaymentMethod
_KIND = Payment.Kind


@pytest.fixture
def customer():
    return make_user("api-cst")


@pytest.fixture
def contractor():
    return make_user("api-ctr")


@pytest.fixture
def outsider():
    return make_user("api-out")


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def accepted(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    accept_leaf(contract, milestone, customer=customer, contractor=contractor)
    return contract, milestone


# --- GET /contracts/{id}/payments -----------------------------------------


def test_contract_payments_materializes_and_lists(accepted, customer):
    """«Read-repair»: реле ещё не дошло, но карточка договора уже открыта —
    счёт обязан быть виден сразу (ADR-130)."""
    contract, milestone = accepted
    assert not Payment.objects.exists()
    resp = _client(customer).get(f"/v1/contracts/{contract.id}/payments")
    assert resp.status_code == 200, resp.content
    items = resp.data["items"]
    assert len(items) == 1
    item = items[0]
    assert item["milestone_id"] == str(milestone.id)
    assert item["kind"] == _KIND.POSTPAYMENT
    assert item["status"] == Payment.Status.PENDING
    # Деньги в API — строкой (CLAUDE.md).
    assert item["amount"] == str(milestone.amount)
    assert isinstance(item["amount"], str)
    assert item["currency"] == milestone.amount_currency
    assert item["my_side"] == "payer"
    assert item["confirmed_by_me"] is False


def test_contract_payments_is_idempotent_across_calls(accepted, customer):
    contract, _ = accepted
    client = _client(customer)
    client.get(f"/v1/contracts/{contract.id}/payments")
    client.get(f"/v1/contracts/{contract.id}/payments")
    assert Payment.objects.count() == 1


def test_contract_payments_forbidden_for_outsider(accepted, outsider):
    contract, _ = accepted
    resp = _client(outsider).get(f"/v1/contracts/{contract.id}/payments")
    assert resp.status_code == 403


def test_contractor_sees_itself_as_payee(accepted, contractor):
    contract, _ = accepted
    resp = _client(contractor).get(f"/v1/contracts/{contract.id}/payments")
    assert resp.data["items"][0]["my_side"] == "payee"


# --- GET /payments/{id} ----------------------------------------------------


def test_payment_detail(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(customer).get(f"/v1/payments/{payment.id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["id"] == str(payment.id)
    assert resp.data["provider"] == Payment.PROVIDER_MANUAL


def test_payment_detail_forbidden_for_outsider(accepted, outsider):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(outsider).get(f"/v1/payments/{payment.id}")
    assert resp.status_code == 403


# --- POST /payments/{id}/confirm -------------------------------------------


def test_confirm_requires_idempotency_key(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(customer).post(f"/v1/payments/{payment.id}/confirm", {}, format="json")
    assert resp.status_code == 400
    assert resp.data["code"] == "idempotency_key_required"


def test_confirm_both_sides_pays_the_leaf(accepted, customer, contractor):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)

    resp = _client(customer).post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="k-1"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == Payment.Status.PAYER_CONFIRMED
    assert resp.data["confirmed_by_payer"] is True

    resp = _client(contractor).post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="k-2"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == Payment.Status.CONFIRMED
    milestone.refresh_from_db()
    assert milestone.status == "paid"


def test_confirm_replays_cached_response_for_the_same_key(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    client = _client(customer)
    first = client.post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="same"
    )
    second = client.post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="same"
    )
    assert first.data == second.data


def test_confirm_same_key_different_body_is_409(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    client = _client(customer)
    client.post(
        f"/v1/payments/{payment.id}/confirm",
        {"side": "payer"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="reused",
    )
    resp = client.post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="reused"
    )
    assert resp.status_code == 409
    assert resp.data["code"] == "idempotency_key_reused"


def test_confirm_with_wrong_side_is_403(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(customer).post(
        f"/v1/payments/{payment.id}/confirm",
        {"side": "payee"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="k",
    )
    assert resp.status_code == 403
    assert resp.data["code"] == "wrong_confirmation_side"


def test_confirm_cancelled_payment_is_409(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    services.cancel_payment(payment, user=customer)
    resp = _client(customer).post(
        f"/v1/payments/{payment.id}/confirm", {}, format="json", HTTP_IDEMPOTENCY_KEY="k"
    )
    assert resp.status_code == 409
    assert resp.data["code"] == "invalid_payment_transition"


# --- POST /payments/{id}/cancel --------------------------------------------


def test_cancel(accepted, contractor):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(contractor).post(
        f"/v1/payments/{payment.id}/cancel",
        {"reason": "выставлено по ошибке"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="c-1",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == Payment.Status.CANCELLED
    assert resp.data["cancel_reason"] == "выставлено по ошибке"


def test_cancel_before_start_invoice_is_409(customer, contractor):
    """ADR-132 + ADR-155: `409 payment_not_cancellable` — свой код, не
    `invalid_payment_transition` (счёт в `pending`, переход FSM формально
    есть). До ADR-155 то же правило жило на виде платежа `advance`."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(customer).post(
        f"/v1/payments/{payment.id}/cancel",
        {"reason": "передумал"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="c-adv-1",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "payment_not_cancellable"
    payment.refresh_from_db()
    assert payment.status == Payment.Status.PENDING


def test_cancel_requires_idempotency_key(accepted, customer):
    contract, milestone = accepted
    payment, _ = services.create_payment(milestone, kind=_KIND.POSTPAYMENT)
    resp = _client(customer).post(f"/v1/payments/{payment.id}/cancel", {}, format="json")
    assert resp.status_code == 400


# --- Унаследованные /milestones/{id}/confirm-* ------------------------------


def test_legacy_confirm_payment_keeps_contract_and_now_creates_payment(
    accepted, customer, contractor
):
    contract, milestone = accepted
    client = _client(customer)
    resp = client.post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    # Форма ответа прежняя — это ЭТАП, не платёж.
    assert resp.data["id"] == str(milestone.id)
    assert resp.data["status"] == "accepted"

    payment = Payment.objects.get(milestone=milestone, kind=_KIND.POSTPAYMENT)
    assert payment.status == Payment.Status.PAYER_CONFIRMED

    resp = _client(contractor).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "contractor"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "paid"
    payment.refresh_from_db()
    assert payment.status == Payment.Status.CONFIRMED


def test_legacy_confirm_payment_honours_idempotency_key_when_sent(accepted, customer):
    contract, milestone = accepted
    client = _client(customer)
    first = client.post(
        f"/v1/milestones/{milestone.id}/confirm-payment",
        {"side": "customer"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="legacy-1",
    )
    second = client.post(
        f"/v1/milestones/{milestone.id}/confirm-payment",
        {"side": "customer"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="legacy-1",
    )
    assert first.status_code == second.status_code == 200
    # Сравниваем ОТРЕНДЕРЕННЫЙ ответ: сохранённое тело прогоняется через
    # JSONRenderer (common/api/idempotency._json_safe), поэтому в `.data`
    # повтора UUID/Decimal уже строки — по HTTP это тот же самый ответ.
    assert first.json() == second.json()


def test_legacy_confirm_payment_wrong_side_is_403(accepted, customer):
    contract, milestone = accepted
    resp = _client(customer).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "contractor"}, format="json"
    )
    assert resp.status_code == 403
    assert resp.data["code"] == "wrong_confirmation_side"


def test_legacy_confirm_payment_on_not_accepted_leaf_is_409_and_creates_nothing(
    customer, contractor
):
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    resp = _client(customer).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 409
    assert resp.data["code"] == "invalid_milestone_transition"
    assert not Payment.objects.exists()


def test_legacy_confirm_payment_drives_the_gate_at_before_start(customer, contractor):
    """ADR-155: тот же унаследованный URL обслуживает оплату ДО старта —
    лист ещё `pending`, гейт «этап принят» к нему неприменим. До ADR-155
    этот сценарий жил на отдельном `/confirm-advance`, которого больше нет
    (способ `prepayment` упразднён)."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer,
        contractor=contractor,
        payment_method=_METHOD.CASH,
        payment_order=Contract.PaymentOrder.BEFORE_START,
    )
    _client(customer).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "customer"}, format="json"
    )
    resp = _client(contractor).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "contractor"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    payment = Payment.objects.get(milestone=milestone, kind=_KIND.POSTPAYMENT)
    assert payment.status == Payment.Status.CONFIRMED

    gate = _client(customer).get(f"/v1/milestones/{milestone.id}/gate")
    assert gate.data["financial_condition_met"] is True
    milestone.refresh_from_db()
    # ADR-162: оплата была ПОСЛЕДНИМ незакрытым условием гейта (материалов
    # заказчика у листа нет) — лист входит в работу сам, без кнопки «Начать
    # этап». `paid` он при этом не становится: оплата ≠ выполнение работы.
    assert milestone.status == Milestone.Status.IN_PROGRESS
    assert milestone.started_at is not None


def test_confirm_advance_endpoint_is_gone(customer, contractor):
    """URL `/confirm-advance` снят вместе со способом `prepayment`
    (ADR-155) — 404, а не «молча работает по-старому»."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.CASH
    )
    resp = _client(customer).post(
        f"/v1/milestones/{milestone.id}/confirm-advance", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 404
    assert not Payment.objects.exists()


def test_legacy_confirm_forbidden_for_outsider(accepted, outsider):
    contract, milestone = accepted
    resp = _client(outsider).post(
        f"/v1/milestones/{milestone.id}/confirm-payment", {"side": "customer"}, format="json"
    )
    assert resp.status_code == 403


# --- Способы, требующие партнёра -------------------------------------------


def test_provider_method_contract_lists_no_payments(customer, contractor):
    """Плашка «оплата через платформу появится с платёжным модулем» на
    фронте опирается ровно на это: списка платежей у таких договоров нет."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=_METHOD.DIRECT_PLATFORM
    )
    resp = _client(customer).get(f"/v1/contracts/{contract.id}/payments")
    assert resp.status_code == 200
    assert resp.data["items"] == []
