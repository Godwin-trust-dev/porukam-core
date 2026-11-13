"""Агрегаты карточки репутации (ADR-163, макет владельца 05.09) — волна 1:
всё считается ИЗ УЖЕ НАКОПЛЕННЫХ `DealFact`, новых событий волна не вводит.
`DealFact` заводится напрямую (это read-слой, сквозной сценарий Э4.6
покрыт `test_subscriber.py`/`test_api.py`).

Каждый агрегат — отдельным тестом, включая ЗАПРЕТЫ: сделка чужого профиля
не попадает ни в одну цифру, незавершённая сделка не считается нигде, и
роли никогда не складываются между собой."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.reputation import selectors
from apps.reputation.models import DealFact

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

CONTRACTOR = selectors.CONTRACTOR_ROLE
CUSTOMER = selectors.CUSTOMER_ROLE

_ME = "018f1a00-0000-7000-8000-00000000f001"
_OTHER_A = "018f1a00-0000-7000-8000-00000000f0a1"
_OTHER_B = "018f1a00-0000-7000-8000-00000000f0b1"
_STRANGER = "018f1a00-0000-7000-8000-00000000f0ff"

_SEQ = {"n": 0}


def _deal(
    *,
    contractor=_ME,
    customer=_OTHER_A,
    spheres=(),
    accepted=0,
    rejected=0,
    disputes_opened=0,
    disputes_resolved=0,
    completed=True,
    completed_days_ago=1,
) -> DealFact:
    _SEQ["n"] += 1
    completed_at = timezone.now() - timedelta(days=completed_days_ago) if completed else None
    return DealFact.objects.create(
        contract_id=f"018f1a00-0000-7000-8000-0000000{_SEQ['n']:05d}",
        contractor_profile_id=contractor,
        customer_profile_id=customer,
        sphere_codes=list(spheres),
        milestones_accepted=accepted,
        milestones_rejected=rejected,
        disputes_opened=disputes_opened,
        disputes_resolved=disputes_resolved,
        is_completed=completed,
        completed_at=completed_at,
    )


# --- роль в сделке -----------------------------------------------------


def test_role_in_deal_is_contractor_when_profile_is_the_contractor_side():
    deal = _deal(contractor=_ME, customer=_OTHER_A)
    assert selectors.role_in_deal(deal, _ME) == CONTRACTOR


def test_role_in_deal_is_customer_when_profile_is_the_customer_side():
    deal = _deal(contractor=_OTHER_A, customer=_ME)
    assert selectors.role_in_deal(deal, _ME) == CUSTOMER


def test_role_in_deal_is_none_for_a_profile_that_is_not_a_party():
    deal = _deal(contractor=_OTHER_A, customer=_OTHER_B)
    assert selectors.role_in_deal(deal, _STRANGER) is None


# --- by_role -----------------------------------------------------------


def test_by_role_splits_deals_between_contractor_and_customer_sides():
    _deal(contractor=_ME, customer=_OTHER_A, accepted=2)
    _deal(contractor=_ME, customer=_OTHER_B, accepted=1)
    _deal(contractor=_OTHER_A, customer=_ME, accepted=3)

    by_role = selectors.card_aggregates(_ME)["by_role"]

    assert by_role[CONTRACTOR]["deals"] == 2
    assert by_role[CUSTOMER]["deals"] == 1


def test_by_role_never_mixes_the_two_roles_of_the_same_profile():
    """Две системы оценки по роли (решение владельца 05.09): цифры
    исполнителя и заказчика не складываются НИ В ОДНОМ поле."""
    _deal(contractor=_ME, customer=_OTHER_A, accepted=4, rejected=1)
    _deal(contractor=_OTHER_A, customer=_ME, accepted=10, rejected=0)

    by_role = selectors.card_aggregates(_ME)["by_role"]

    assert by_role[CONTRACTOR]["first_time"] == {"done": 3, "total": 4}
    assert by_role[CUSTOMER]["first_time"] == {"done": 10, "total": 10}


def test_by_role_first_time_counts_every_rejection_as_a_stage_lost():
    _deal(contractor=_ME, accepted=5, rejected=2)
    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["first_time"] == {"done": 3, "total": 5}


def test_by_role_first_time_never_goes_negative_on_more_rejections_than_accepts():
    _deal(contractor=_ME, accepted=1, rejected=3)
    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["first_time"] == {"done": 0, "total": 1}


def test_by_role_counts_disputes_opened_and_resolved_separately():
    _deal(contractor=_ME, disputes_opened=2, disputes_resolved=1)
    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["disputes_opened"] == 2
    assert stats["disputes_resolved"] == 1


def test_by_role_disputes_free_counts_deals_without_a_single_dispute():
    _deal(contractor=_ME, disputes_opened=0)
    _deal(contractor=_ME, disputes_opened=1)
    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["disputes_free"] == {"done": 1, "total": 2}


def test_by_role_time_axes_are_empty_pairs_in_wave_one():
    """Волна 1 не считает сроков — но КЛЮЧИ отдаёт (контракт API один на
    обе волны). Пустая пара 0/0 значит «нечего мерить», не «плохо»."""
    _deal(contractor=_ME, accepted=1)
    stats = selectors.card_aggregates(_ME)["by_role"][CONTRACTOR]
    assert stats["on_time_delivery"] == {"done": 0, "total": 0}
    assert stats["on_time_payment"] == {"done": 0, "total": 0}
    assert stats["prompt_acceptance"] == {"done": 0, "total": 0}
    assert stats["warranty_claims"] == 0


def test_by_role_is_all_zeros_for_a_profile_without_deals():
    by_role = selectors.card_aggregates(_ME)["by_role"]
    assert by_role[CONTRACTOR]["deals"] == 0
    assert by_role[CUSTOMER]["deals"] == 0


# --- by_sphere ---------------------------------------------------------


def test_by_sphere_counts_a_multi_sphere_deal_in_every_one_of_its_spheres():
    _deal(contractor=_ME, spheres=("repair", "plumbing"), accepted=2)
    rows = selectors.card_aggregates(_ME)["by_sphere"]
    assert {r["sphere_code"] for r in rows} == {"repair", "plumbing"}
    assert all(r["deals"] == 1 for r in rows)


def test_by_sphere_keeps_the_same_sphere_in_two_rows_when_roles_differ():
    _deal(contractor=_ME, customer=_OTHER_A, spheres=("repair",))
    _deal(contractor=_OTHER_A, customer=_ME, spheres=("repair",))

    rows = selectors.card_aggregates(_ME)["by_sphere"]

    assert {(r["sphere_code"], r["role"]) for r in rows} == {
        ("repair", CONTRACTOR),
        ("repair", CUSTOMER),
    }


def test_by_sphere_is_ordered_by_deal_count_then_code():
    _deal(contractor=_ME, spheres=("repair",))
    _deal(contractor=_ME, spheres=("repair",))
    _deal(contractor=_ME, spheres=("tutoring",))

    rows = selectors.card_aggregates(_ME)["by_sphere"]

    assert [r["sphere_code"] for r in rows] == ["repair", "tutoring"]


def test_by_sphere_skips_deals_without_any_sphere_code():
    _deal(contractor=_ME, spheres=(), accepted=1)
    assert selectors.card_aggregates(_ME)["by_sphere"] == []


def test_by_sphere_accumulates_first_time_and_disputes_inside_a_sphere():
    _deal(contractor=_ME, spheres=("repair",), accepted=3, rejected=1, disputes_opened=1)
    _deal(contractor=_ME, spheres=("repair",), accepted=2, rejected=0)

    row = selectors.card_aggregates(_ME)["by_sphere"][0]

    assert row["deals"] == 2
    assert row["first_time"] == {"done": 4, "total": 5}
    assert row["disputes"] == 1
    assert row["warranty"] == 0
    assert row["on_time"] == {"done": 0, "total": 0}


# --- disputes_free / repeat_counterparties / last_deal_at ---------------


def test_disputes_free_is_counted_over_all_deals_of_both_roles():
    _deal(contractor=_ME, disputes_opened=0)
    _deal(contractor=_OTHER_A, customer=_ME, disputes_opened=1)
    assert selectors.card_aggregates(_ME)["disputes_free"] == {"done": 1, "total": 2}


def test_repeat_counterparties_counts_only_counterparties_seen_more_than_once():
    _deal(contractor=_ME, customer=_OTHER_A)
    _deal(contractor=_ME, customer=_OTHER_A)
    _deal(contractor=_ME, customer=_OTHER_B)

    assert selectors.card_aggregates(_ME)["repeat_counterparties"] == {"count": 1, "total": 2}


def test_repeat_counterparties_counts_the_same_person_across_both_roles():
    """Повтор — про ЧЕЛОВЕКА, а не про роль: заказал у него, потом сделал
    для него — это тот же контрагент во второй раз."""
    _deal(contractor=_ME, customer=_OTHER_A)
    _deal(contractor=_OTHER_A, customer=_ME)

    assert selectors.card_aggregates(_ME)["repeat_counterparties"] == {"count": 1, "total": 1}


def test_last_deal_at_is_the_freshest_completion():
    _deal(contractor=_ME, completed_days_ago=30)
    fresh = _deal(contractor=_ME, completed_days_ago=2)

    assert selectors.card_aggregates(_ME)["last_deal_at"] == fresh.completed_at


def test_last_deal_at_is_none_without_deals():
    assert selectors.card_aggregates(_ME)["last_deal_at"] is None


# --- запреты -----------------------------------------------------------


def test_unfinished_deal_is_counted_in_no_aggregate_at_all():
    _deal(contractor=_ME, spheres=("repair",), accepted=5, completed=False)

    aggregates = selectors.card_aggregates(_ME)

    assert aggregates["by_role"][CONTRACTOR]["deals"] == 0
    assert aggregates["by_sphere"] == []
    assert aggregates["disputes_free"] == {"done": 0, "total": 0}
    assert aggregates["repeat_counterparties"] == {"count": 0, "total": 0}
    assert aggregates["last_deal_at"] is None


def test_someone_elses_deal_is_counted_in_no_aggregate_at_all():
    _deal(contractor=_OTHER_A, customer=_OTHER_B, spheres=("repair",), accepted=5)

    aggregates = selectors.card_aggregates(_ME)

    assert aggregates["by_role"][CONTRACTOR]["deals"] == 0
    assert aggregates["by_role"][CUSTOMER]["deals"] == 0
    assert aggregates["by_sphere"] == []
