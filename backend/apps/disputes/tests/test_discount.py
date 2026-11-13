"""Скидка = допник через ОБЩИЙ контур подписания (tech-spec.md §5.2.7, §8.8;
§20.3 анти-waiver; ADR-131). Проверяем и сам контур, и инвариант «сумма
листьев = сумма договора» после применения допника."""

from __future__ import annotations

from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from apps.contracts import services as contracts_services
from apps.contracts.models import Amendment, Contract, ContractParty, SignatureRequest
from apps.disputes import handlers, services
from apps.disputes.models import DiscountAgreement, Dispute
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications.models import Notification
from common import relay
from common.fsm import InvalidTransitionError
from common.models import OutboxEvent

from ._helpers import make_warranty_contract, open_milestone_dispute

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_ANTI_WAIVER = (
    "Скидка закрывает только дефект по пункту чек-листа, остальные требования сохраняются"
)


@pytest.fixture
def customer():
    return make_user("g001")


@pytest.fixture
def contractor():
    return make_user("g002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


def _sign_amendment_both(amendment, *, customer, contractor):
    """Общий контур §8.6: заморозка -> маршрутизация обеих сторон -> две
    подписи. Именно он, а не отдельная кнопка, и есть «принятие скидки»."""
    contracts_services.freeze_amendment(amendment, user=customer)
    amendment.refresh_from_db()
    customer_request = contracts_services.route_amendment_signatory(
        amendment,
        user=customer,
        side=_ROLE.CUSTOMER,
        version_id=amendment.frozen_version_id,
        signatory_user_id=customer.id,
    )
    contractor_request = contracts_services.route_amendment_signatory(
        amendment,
        user=contractor,
        side=_ROLE.CONTRACTOR,
        version_id=amendment.frozen_version_id,
        signatory_user_id=contractor.id,
    )
    amendment.refresh_from_db()
    version_hash = amendment.frozen_version.integrity_hash
    contracts_services.sign_amendment(customer_request, user=customer, version_hash=version_hash)
    contracts_services.sign_amendment(
        contractor_request, user=contractor, version_hash=version_hash
    )
    # Две волны: первая доставляет `contract.amended` (спор закрывается),
    # вторая — рождённый им `dispute.resolved` (этап возвращается в
    # `accepted` подписчиком apps.milestones). Реле берёт фиксированный срез
    # due-событий ДО обработки (common/relay.py).
    relay.deliver_due_events()
    relay.deliver_due_events()


def test_propose_discount_creates_amendment_under_review(dispute, contractor):
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("8000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.AWAITING_DISCOUNT
    assert agreement.status == DiscountAgreement.Status.PROPOSED
    assert agreement.old_amount == Decimal("10000.00")
    assert agreement.new_amount == Decimal("8000.00")
    amendment = agreement.amendment
    amendment.refresh_from_db()
    assert amendment.negotiation_status == "under_review"
    # §20.3: анти-waiver уходит в payload изменения, то есть в подписываемый
    # снимок допника — а не только в строку соглашения.
    change = amendment.changes.get()
    assert change.payload[contracts_services.AMENDMENT_ANTI_WAIVER_KEY]["note"] == _ANTI_WAIVER
    assert change.payload[contracts_services.AMENDMENT_ANTI_WAIVER_KEY][
        "covers_checklist_item_id"
    ] == str(dispute.checklist_item_id)


def test_signed_discount_amendment_lowers_leaf_and_resolves_dispute(dispute, customer, contractor):
    contract = dispute.contract
    total_before = milestones_services.total_leaf_amount(contract)
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("8000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    _sign_amendment_both(agreement.amendment, customer=customer, contractor=contractor)

    agreement.refresh_from_db()
    dispute.refresh_from_db()
    assert agreement.status == DiscountAgreement.Status.ACCEPTED
    assert dispute.status == Dispute.Status.RESOLVED
    assert dispute.resolution_type == "discount_accepted"
    assert dispute.outcome == Dispute.Outcome.RESOLVED

    milestone = Milestone.objects.get(pk=dispute.milestone_id)
    assert milestone.amount == Decimal("8000.00")
    # Инвариант «сумма листьев = сумма договора»: отдельной строки «сумма
    # договора» нет, она и есть сумма листьев (effective_terms / total_leaf_
    # amount) — значит скидка листа сдвинула её ровно на дельту допника.
    total_after = milestones_services.total_leaf_amount(contract)
    assert total_before.amount - total_after.amount == Decimal("2000.00")
    assert total_after.currency == total_before.currency
    milestones_services.assert_leaf_sum_matches(contract, total_after)
    # Исход диалога возвращает этап в accepted (apps.milestones.handlers).
    assert milestone.status == Milestone.Status.ACCEPTED


def test_decline_discount_returns_dispute_to_open(dispute, customer, contractor):
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    services.decline_discount(agreement, user=customer)
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert agreement.status == DiscountAgreement.Status.DECLINED
    assert dispute.status == Dispute.Status.OPEN


def test_decline_own_discount_is_forbidden(dispute, contractor):
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    with pytest.raises(services.NotDisputeCounterpartyError):
        services.decline_discount(agreement, user=contractor)


def test_decline_discount_twice_is_forbidden(dispute, customer, contractor):
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    services.decline_discount(agreement, user=customer)
    with pytest.raises(services.DiscountAlreadyDecidedError):
        services.decline_discount(agreement, user=customer)


def test_second_discount_proposal_while_awaiting_is_forbidden(dispute, contractor):
    services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    dispute.refresh_from_db()
    with pytest.raises(services.InvalidDisputeTransitionError):
        services.propose_discount(
            dispute,
            user=contractor,
            new_amount=Decimal("8000.00"),
            currency="RUB",
            anti_waiver_note=_ANTI_WAIVER,
        )


def test_discount_above_current_amount_is_rejected(dispute, contractor):
    with pytest.raises(services.DiscountNotApplicableError):
        services.propose_discount(
            dispute,
            user=contractor,
            new_amount=Decimal("11000.00"),
            currency="RUB",
            anti_waiver_note=_ANTI_WAIVER,
        )


def test_discount_in_other_currency_is_rejected(dispute, contractor):
    with pytest.raises(services.DiscountNotApplicableError):
        services.propose_discount(
            dispute,
            user=contractor,
            new_amount=Decimal("100.00"),
            currency="USD",
            anti_waiver_note=_ANTI_WAIVER,
        )


def test_discount_without_anti_waiver_note_is_rejected(dispute, contractor):
    with pytest.raises(services.DiscountNotApplicableError):
        services.propose_discount(
            dispute,
            user=contractor,
            new_amount=Decimal("9000.00"),
            currency="RUB",
            anti_waiver_note="   ",
        )


def test_discount_on_warranty_dispute_is_rejected(customer, contractor):
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    warranty_dispute = services.open_warranty_dispute(
        contract, user=customer, description="течёт", evidence=["photo.jpg"]
    )
    with pytest.raises(services.DiscountNotApplicableError):
        services.propose_discount(
            warranty_dispute,
            user=contractor,
            new_amount=Decimal("1000.00"),
            currency="RUB",
            anti_waiver_note=_ANTI_WAIVER,
        )


def test_ordinary_amendment_does_not_touch_disputes(dispute, customer, contractor):
    """`contract.amended` от ОБЫЧНОГО допника (§8.6) не должен закрывать
    открытые разногласия — подписчик обязан найти именно допник скидки."""
    amendment = contracts_services.create_amendment(
        dispute.contract,
        user=customer,
        reason="добавить этап",
        changes=[
            {
                "type": "add_milestone",
                "payload": {"title": "Доп. работа", "amount": "500.00", "currency": "RUB"},
            }
        ],
    )
    contracts_services.send_amendment_for_review(amendment, user=customer)
    amendment.refresh_from_db()
    _sign_amendment_both(amendment, customer=customer, contractor=contractor)
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN


# --- Дополнение 26.08 к ADR-075: допник скидки отозван/отклонён контуром §8.6 ---


def _propose(dispute, *, contractor):
    return services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )


def test_rejected_discount_amendment_returns_dispute_to_open(dispute, customer, contractor):
    """Заказчик отклонил допник через `POST /amendments/{id}/reject` — спор
    не висит в `awaiting_discount`, предложение `declined`."""
    agreement = _propose(dispute, contractor=contractor)
    contracts_services.reject_amendment(agreement.amendment, user=customer, reason="мало")
    relay.deliver_due_events()
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN
    assert agreement.status == DiscountAgreement.Status.DECLINED
    assert agreement.decided_by_id == customer.id
    assert agreement.decided_at is not None
    event = OutboxEvent.objects.get(topic="dispute.discount_cancelled")
    assert event.payload["cause"] == "rejected"
    assert event.payload["amendment_id"] == str(agreement.amendment_id)
    # О самом действии уведомляет `amendment.rejected`; дубля `discount_declined` нет.
    assert not OutboxEvent.objects.filter(topic="dispute.discount_declined").exists()


def test_withdrawn_discount_amendment_returns_dispute_to_open(dispute, contractor):
    agreement = _propose(dispute, contractor=contractor)
    contracts_services.withdraw_amendment(agreement.amendment, user=contractor)
    relay.deliver_due_events()
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN
    assert agreement.status == DiscountAgreement.Status.DECLINED
    assert agreement.decided_by_id == contractor.id
    assert OutboxEvent.objects.get(topic="dispute.discount_cancelled").payload["cause"] == (
        "withdrawn"
    )


def test_dispute_can_take_new_discount_after_amendment_rejected(dispute, customer, contractor):
    agreement = _propose(dispute, contractor=contractor)
    contracts_services.reject_amendment(agreement.amendment, user=customer)
    relay.deliver_due_events()
    dispute.refresh_from_db()
    second = _propose(dispute, contractor=contractor)
    dispute.refresh_from_db()
    assert second.amendment_id != agreement.amendment_id
    assert dispute.status == Dispute.Status.AWAITING_DISCOUNT


def test_amendment_closed_after_direct_decline_is_noop(dispute, customer, contractor):
    """Скидку уже отклонили кнопкой спора — допник закрыт ею же (дополнение
    26.08 к ADR-131), отозвать его руками уже нельзя; доставка рождённого
    отказом `amendment.rejected` повторного «отклонения» и события не даёт
    (идемпотентность реле)."""
    agreement = _propose(dispute, contractor=contractor)
    services.decline_discount(agreement, user=customer)
    with pytest.raises(InvalidTransitionError):
        contracts_services.withdraw_amendment(agreement.amendment, user=contractor)
    relay.deliver_due_events()
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN
    assert agreement.decided_by_id == customer.id
    assert not OutboxEvent.objects.filter(topic="dispute.discount_cancelled").exists()


def test_ordinary_amendment_rejection_does_not_touch_disputes(dispute, customer, contractor):
    amendment = contracts_services.create_amendment(
        dispute.contract,
        user=contractor,
        reason="Обычный допник",
        changes=[{"type": "custom_term", "payload": {"text": "срок +3 дня"}}],
    )
    contracts_services.send_amendment_for_review(amendment, user=contractor)
    contracts_services.reject_amendment(amendment, user=customer)
    relay.deliver_due_events()
    dispute.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN
    assert not OutboxEvent.objects.filter(topic="dispute.discount_cancelled").exists()


# --- Дополнение 26.08 к ADR-131 (в6-6): отказ от скидки закрывает допник ------

_AMENDMENT_STATUS = Contract.NegotiationStatus
_SIG_STATUS = SignatureRequest.Status


def _templates(user) -> list[str]:
    return list(
        Notification.objects.filter(recipient=user)
        .order_by("placed_in_cabinet_at")
        .values_list("template", flat=True)
    )


def test_decline_discount_rejects_amendment_as_counterparty(dispute, customer, contractor):
    """Кнопка спора «отказаться от скидки» закрывает и допник: статус
    `rejected_by_counterparty`, актор — отказавший, `reason` — его
    комментарий, `cause=discount_declined` в payload."""
    agreement = _propose(dispute, contractor=contractor)
    services.decline_discount(agreement, user=customer, comment="мало")
    amendment = Amendment.objects.get(pk=agreement.amendment_id)
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert amendment.negotiation_status == _AMENDMENT_STATUS.REJECTED_BY_COUNTERPARTY
    assert dispute.status == Dispute.Status.OPEN
    assert agreement.status == DiscountAgreement.Status.DECLINED
    assert agreement.decided_by_id == customer.id
    rejected = OutboxEvent.objects.get(topic="amendment.rejected")
    assert rejected.actor == {"user_id": str(customer.id)}
    assert rejected.payload["reason"] == "мало"
    assert rejected.payload["cause"] == "discount_declined"
    declined = OutboxEvent.objects.get(topic="dispute.discount_declined")
    assert declined.payload["comment"] == "мало"
    assert declined.payload["amendment_rejected"] is True


def test_decline_discount_from_pending_signature_annuls_amendment_round(
    dispute, customer, contractor
):
    """Допник скидки уже заморожен и отправлен на подпись — отказ от скидки
    аннулирует раунд подписания допника, как ручной reject."""
    agreement = _propose(dispute, contractor=contractor)
    amendment = agreement.amendment
    contracts_services.freeze_amendment(amendment, user=contractor)
    amendment.refresh_from_db()
    request = contracts_services.route_amendment_signatory(
        amendment,
        user=contractor,
        side=_ROLE.CONTRACTOR,
        version_id=amendment.frozen_version_id,
        signatory_user_id=contractor.id,
    )
    services.decline_discount(agreement, user=customer)
    amendment.refresh_from_db()
    request.refresh_from_db()
    assert amendment.negotiation_status == _AMENDMENT_STATUS.REJECTED_BY_COUNTERPARTY
    assert amendment.frozen_version_id is None
    assert request.status == _SIG_STATUS.DECLINED_FOR_REVISION
    rejected = OutboxEvent.objects.get(topic="amendment.rejected")
    assert rejected.payload["annulled_signature_request_ids"] == [str(request.id)]


def test_decline_discount_notifies_only_the_other_side_once(dispute, customer, contractor):
    """Одно действие — одно уведомление, и только контрагенту (ADR-178):
    `dispute.discount_declined` актору (customer, отказавшему от скидки) не
    приходит, `amendment.rejected` с cause=discount_declined заглушён у
    обоих (ADR-126 §4)."""
    agreement = _propose(dispute, contractor=contractor)
    relay.deliver_due_events()
    Notification.objects.all().delete()
    services.decline_discount(agreement, user=customer, comment="мало")
    relay.deliver_due_events()
    assert _templates(customer) == []
    assert _templates(contractor) == ["dispute.discount_declined"]


def test_decline_discount_redelivered_amendment_rejected_is_noop(dispute, customer, contractor):
    """`handle_amendment_closed` на рождённом отказом `amendment.rejected`:
    предложение уже `declined`, спор уже `open` — второго события нет ни при
    первой доставке, ни при повторной (ADR-064)."""
    agreement = _propose(dispute, contractor=contractor)
    services.decline_discount(agreement, user=customer)
    relay.deliver_due_events()
    handlers.handle_amendment_closed(OutboxEvent.objects.get(topic="amendment.rejected"))
    dispute.refresh_from_db()
    agreement.refresh_from_db()
    assert dispute.status == Dispute.Status.OPEN
    assert agreement.status == DiscountAgreement.Status.DECLINED
    assert agreement.decided_by_id == customer.id
    assert not OutboxEvent.objects.filter(topic="dispute.discount_cancelled").exists()
    assert OutboxEvent.objects.filter(topic="amendment.rejected").count() == 1


def test_decline_discount_twice_leaves_amendment_rejected_once(dispute, customer, contractor):
    agreement = _propose(dispute, contractor=contractor)
    services.decline_discount(agreement, user=customer)
    with pytest.raises(services.DiscountAlreadyDecidedError):
        services.decline_discount(agreement, user=customer)
    assert OutboxEvent.objects.filter(topic="amendment.rejected").count() == 1
    assert (
        Amendment.objects.get(pk=agreement.amendment_id).negotiation_status
        == _AMENDMENT_STATUS.REJECTED_BY_COUNTERPARTY
    )


def test_dispute_can_take_new_discount_after_decline(dispute, customer, contractor):
    agreement = _propose(dispute, contractor=contractor)
    services.decline_discount(agreement, user=customer)
    dispute.refresh_from_db()
    second = _propose(dispute, contractor=contractor)
    assert second.amendment_id != agreement.amendment_id
    assert (
        Amendment.objects.get(pk=second.amendment_id).negotiation_status
        == _AMENDMENT_STATUS.UNDER_REVIEW
    )


def test_decline_discount_api_with_comment(dispute, customer, contractor):
    agreement = _propose(dispute, contractor=contractor)
    client = APIClient()
    client.force_authenticate(user=customer)
    resp = client.post(
        f"/v1/disputes/{dispute.id}/discount-proposals/{agreement.id}/decline",
        {"comment": "мало"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "declined"
    assert (
        Amendment.objects.get(pk=agreement.amendment_id).negotiation_status
        == _AMENDMENT_STATUS.REJECTED_BY_COUNTERPARTY
    )
    assert OutboxEvent.objects.get(topic="amendment.rejected").payload["reason"] == "мало"


def test_decline_discount_api_without_body(dispute, customer, contractor):
    agreement = _propose(dispute, contractor=contractor)
    client = APIClient()
    client.force_authenticate(user=customer)
    resp = client.post(f"/v1/disputes/{dispute.id}/discount-proposals/{agreement.id}/decline")
    assert resp.status_code == 200, resp.content
    assert OutboxEvent.objects.get(topic="amendment.rejected").payload["reason"] == ""
