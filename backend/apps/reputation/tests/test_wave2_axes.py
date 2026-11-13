"""Волна 2 ADR-163: оси сроков по роли, гарантийные обращения, скрытые
метрики и Insights владельца.

Подписчик тестируется напрямую поддельным `OutboxEvent` (как
`test_subscriber.py`): сквозной Э4.6-сценарий с реальными дедлайнами живёт
в `test_api.py`, а здесь проверяется РАЗБОР payload — включая запреты
(чужая роль, событие без срока, автоприёмка)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.reputation import selectors, subscriber
from apps.reputation.models import DealFact, MilestoneFact
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

CONTRACTOR = selectors.CONTRACTOR_ROLE
CUSTOMER = selectors.CUSTOMER_ROLE

_ME = "018f1a00-0000-7000-8000-00000000e001"
_OTHER = "018f1a00-0000-7000-8000-00000000e0a1"
_CONTRACT = "018f1a00-0000-7000-8000-00000000e0c1"


def _parties(*, contractor=_ME, customer=_OTHER) -> dict:
    return {
        "contractor": {"profile_id": contractor},
        "customer": {"profile_id": customer},
    }


def _event(topic: str, **payload) -> OutboxEvent:
    base = {
        "contract_id": _CONTRACT,
        "parties": _parties(),
        "occurred_at": timezone.now().isoformat(),
    }
    base.update(payload)
    return OutboxEvent(event_id=uuid.uuid4(), topic=topic, payload=base)


def _deliver(topic: str, **payload) -> None:
    subscriber.handle_event(_event(topic, **payload))


def _accept(
    *,
    milestone_id: str,
    due_at=None,
    submitted_at=None,
    auto_accepted: bool = False,
    on_time=None,
    sphere: str = "repair",
) -> None:
    now = timezone.now()
    _deliver(
        "milestone.auto_accepted" if auto_accepted else "milestone.accepted",
        milestone_id=milestone_id,
        milestone_title="Этап",
        milestone_sphere_code=sphere,
        due_at=due_at.isoformat() if due_at else None,
        submitted_at=submitted_at.isoformat() if submitted_at else None,
        accepted_at=now.isoformat(),
        auto_accepted=auto_accepted,
        on_time=on_time,
    )


def _complete(**extra) -> None:
    payload = {
        "completed_at": timezone.now().isoformat(),
        "contract_type_code": "services_repair",
        "segment": "free_c2c",
    }
    payload.update(extra)
    _deliver("contract.completed", **payload)


# --- ось исполнителя «сделано в срок» ----------------------------------


def test_milestone_submitted_before_its_deadline_counts_as_delivered_on_time():
    now = timezone.now()
    _accept(milestone_id=str(uuid.uuid4()), due_at=now, submitted_at=now - timedelta(hours=2))
    _complete()

    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 1, "total": 1}


def test_milestone_submitted_after_its_deadline_counts_in_total_but_not_in_done():
    now = timezone.now()
    _accept(milestone_id=str(uuid.uuid4()), due_at=now, submitted_at=now + timedelta(hours=2))
    _complete()

    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 0, "total": 1}


def test_milestone_without_a_deadline_is_not_counted_as_late_it_is_not_counted_at_all():
    """Запрет: этап без срока НЕ просрочен — он вне доли (иначе договоры
    без дедлайнов красили бы карточку в красное)."""
    _accept(milestone_id=str(uuid.uuid4()), due_at=None, submitted_at=timezone.now())
    _complete()

    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 0, "total": 0}


def test_delivery_axis_never_appears_in_the_customer_block():
    """Запрет ADR-163 §1: чужой срок в свой блок не попадает."""
    now = timezone.now()
    _accept(milestone_id=str(uuid.uuid4()), due_at=now, submitted_at=now - timedelta(hours=1))
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["on_time_delivery"] == {"done": 0, "total": 0}


# --- ось заказчика «принято без затягивания» ---------------------------


def test_acceptance_inside_the_window_counts_as_prompt():
    _accept(milestone_id=str(uuid.uuid4()), on_time=True)
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["prompt_acceptance"] == {"done": 1, "total": 1}


def test_auto_acceptance_by_timeout_is_never_prompt_even_when_on_time_says_so():
    """Автоприёмка — это НЕ решение заказчика: для него «затянуто», хотя
    для исполнителя этап принят (ADR-163 §1)."""
    _accept(milestone_id=str(uuid.uuid4()), auto_accepted=True, on_time=True)
    _complete()

    aggregates = selectors.card_aggregates(_OTHER)
    assert aggregates["by_role"][CUSTOMER]["prompt_acceptance"] == {"done": 0, "total": 1}
    assert selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]["deals"] == 1


def test_acceptance_without_an_anchored_window_is_not_measured():
    _accept(milestone_id=str(uuid.uuid4()), on_time=None)
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["prompt_acceptance"] == {"done": 0, "total": 0}


# --- ось заказчика «оплачено в срок» -----------------------------------


def _payment(*, milestone_id: str, due_delta: timedelta, side: str = "customer") -> None:
    now = timezone.now()
    _deliver(
        "milestone.payment_confirmed",
        milestone_id=milestone_id,
        milestone_title="Этап",
        milestone_sphere_code="repair",
        side=side,
        payment_due_at=(now + due_delta).isoformat(),
        confirmed_at=now.isoformat(),
    )


def test_payment_confirmed_by_payer_before_due_counts_as_on_time():
    mid = str(uuid.uuid4())
    _payment(milestone_id=mid, due_delta=timedelta(days=1))
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["on_time_payment"] == {"done": 1, "total": 1}


def test_payment_confirmed_after_due_counts_in_total_but_not_in_done():
    mid = str(uuid.uuid4())
    _payment(milestone_id=mid, due_delta=timedelta(days=-1))
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["on_time_payment"] == {"done": 0, "total": 1}


def test_payee_confirmation_is_ignored_it_is_not_about_paying_on_time():
    """Запрет: подтверждение ПОЛУЧАТЕЛЯ говорит, что деньги дошли, а не
    что их вовремя отправили."""
    mid = str(uuid.uuid4())
    _payment(milestone_id=mid, due_delta=timedelta(days=1), side="contractor")
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["on_time_payment"] == {"done": 0, "total": 0}
    assert MilestoneFact.objects.filter(milestone_id=mid).exists() is False


def test_payment_event_without_a_due_date_is_not_measured():
    mid = str(uuid.uuid4())
    _deliver(
        "milestone.payment_confirmed",
        milestone_id=mid,
        side="customer",
        payment_due_at=None,
        confirmed_at=timezone.now().isoformat(),
    )
    _complete()

    stats = selectors.card_aggregates(_OTHER)["by_role"][CUSTOMER]
    assert stats["on_time_payment"] == {"done": 0, "total": 0}


# --- гарантийные обращения ---------------------------------------------


def test_warranty_claim_is_counted_as_a_separate_number():
    _deliver("warranty.claim_submitted", warranty_claim_id=str(uuid.uuid4()))
    _complete()

    assert selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]["warranty_claims"] == 1


def test_warranty_claim_enters_no_ratio_denominator():
    """ADR-030: гарантия рейтинг задним числом НЕ пересчитывает."""
    now = timezone.now()
    _accept(milestone_id=str(uuid.uuid4()), due_at=now, submitted_at=now - timedelta(hours=1))
    _deliver("warranty.claim_submitted", warranty_claim_id=str(uuid.uuid4()))
    _complete()

    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 1, "total": 1}
    assert stats["disputes_free"] == {"done": 1, "total": 1}


def test_warranty_claim_shows_up_in_the_sphere_row():
    _accept(milestone_id=str(uuid.uuid4()), sphere="repair")
    _deliver("warranty.claim_submitted", warranty_claim_id=str(uuid.uuid4()))
    _complete()

    row = selectors.card_aggregates(_ME)["by_sphere"][0]
    assert row["sphere_code"] == "repair"
    assert row["warranty"] == 1


# --- идемпотентность ----------------------------------------------------


def test_redelivered_acceptance_does_not_double_the_ratio():
    now = timezone.now()
    mid = str(uuid.uuid4())
    event = _event(
        "milestone.accepted",
        milestone_id=mid,
        due_at=now.isoformat(),
        submitted_at=(now - timedelta(hours=1)).isoformat(),
        accepted_at=now.isoformat(),
        auto_accepted=False,
        on_time=True,
    )
    subscriber.handle_event(event)
    subscriber.handle_event(event)
    _complete()

    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 1, "total": 1}


def test_recompute_assigns_counters_and_never_accumulates_them():
    now = timezone.now()
    _accept(milestone_id=str(uuid.uuid4()), due_at=now, submitted_at=now - timedelta(hours=1))
    _complete()
    deal = DealFact.objects.get(contract_id=_CONTRACT)

    subscriber.recompute_deal_counters(deal)
    subscriber.recompute_deal_counters(deal)

    assert deal.milestones_on_time == 1
    assert deal.milestones_with_due == 1


# --- скрытые метрики ----------------------------------------------------


def test_volume_and_protection_are_stored_but_never_reach_the_public_card():
    _accept(milestone_id=str(uuid.uuid4()))
    _complete(
        total={"amount": "150000.00", "currency": "RUB"},
        payment_method="hold",
        payment_protected=True,
    )

    deal = DealFact.objects.get(contract_id=_CONTRACT)
    assert deal.total_amount == Decimal("150000.00")
    assert deal.total_currency == "RUB"
    assert deal.payment_protected is True

    card = selectors.card_aggregates(_ME)
    assert "volume" not in card
    assert "protected_payments" not in card
    assert all("volume" not in row for row in card["by_sphere"])


def test_insights_exposes_volume_and_protected_share_to_the_owner():
    _accept(milestone_id=str(uuid.uuid4()))
    _complete(
        total={"amount": "150000.00", "currency": "RUB"},
        payment_method="hold",
        payment_protected=True,
    )

    hidden = selectors.insights_for_profile(_ME)["hidden"]

    assert hidden["volume"] == [{"amount": "150000.00", "currency": "RUB"}]
    assert hidden["protected_payments"] == {"done": 1, "total": 1}


# --- Insights: подсказка «до зелёной зоны» ------------------------------


def test_to_green_is_none_when_the_ratio_is_already_green():
    assert selectors._to_green(9, 10) is None


def test_to_green_is_none_when_there_is_nothing_to_measure():
    assert selectors._to_green(0, 0) is None


def test_to_green_counts_events_not_percent_points():
    """«Не хватает 3 %» и «не хватает 3 этапов» — разные величины: каждое
    новое удачное событие растит и числитель, и знаменатель."""
    n = selectors._to_green(5, 10)
    assert n is not None and n >= 1
    assert (5 + n) / (10 + n) >= selectors.GREEN_ZONE_PERCENT / 100
    assert (5 + n - 1) / (10 + n - 1) < selectors.GREEN_ZONE_PERCENT / 100


def test_insights_drops_metrics_without_a_denominator():
    _accept(milestone_id=str(uuid.uuid4()), due_at=None, submitted_at=None, on_time=None)
    _complete()

    codes = {m["code"] for m in selectors.insights_for_profile(_ME)["metrics"]}
    assert "on_time_delivery" not in codes


def test_insights_drilldown_names_the_late_milestone():
    now = timezone.now()
    mid = str(uuid.uuid4())
    _accept(milestone_id=mid, due_at=now, submitted_at=now + timedelta(days=2))
    _complete()

    metric = next(
        m for m in selectors.insights_for_profile(_ME)["metrics"] if m["code"] == "on_time_delivery"
    )
    assert [(i["milestone_id"], i["ok"]) for i in metric["items"]] == [(mid, False)]


def test_insights_drilldown_carries_the_rejection_reason():
    mid = str(uuid.uuid4())
    _deliver(
        "milestone.rejected",
        milestone_id=mid,
        milestone_title="Этап",
        checklist_item_id=str(uuid.uuid4()),
        checklist_item_description="Швы не затёрты",
        evidence=["doc-1"],
    )
    _accept(milestone_id=mid)
    _complete()

    metric = next(
        m
        for m in selectors.insights_for_profile(_ME)["metrics"]
        if m["code"] == "first_time" and m["role"] == CONTRACTOR
    )
    assert [i["detail"] for i in metric["items"]] == ["Швы не затёрты"]


def test_insights_recent_window_counts_the_last_thirty_days():
    _accept(milestone_id=str(uuid.uuid4()))
    _complete()

    recent = selectors.insights_for_profile(_ME)["recent"]
    assert recent["deals"] == 1
    assert recent["counterparties"] == 1
