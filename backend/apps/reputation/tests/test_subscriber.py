"""apps.reputation.subscriber — ГВ.4 (docs/tasks/global-wave.md): read-модель
строится ИСКЛЮЧИТЕЛЬНО из событий-исходов Э4.6. Приёмка ГВ.4: «после
сквозного сценария Э4.6 карточка обеих сторон показывает сделку с
исходом»."""

from __future__ import annotations

import pytest

from apps.contracts.models import Contract, ContractParty
from apps.disputes import services as disputes_services
from apps.milestones import services as milestones_services
from apps.milestones.models import ChecklistItem, Milestone
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.profiles.models import PortfolioProject
from apps.reputation import selectors
from apps.reputation.models import DealFact, ProcessedEvent
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role


def _drain(*, max_sweeps: int = 5) -> None:
    """`relay.deliver_due_events()` доставляет только события, СУЩЕСТВОВАВШИЕ
    на момент своего вызова — подписчик, обработавший `milestone.rejected`,
    сам публикует `dispute.opened` ВНУТРИ этого же вызова (apps.disputes.
    handlers.handle_milestone_rejected -> services.open_dispute), и это
    новое событие попадёт под доставку только СЛЕДУЮЩИМ вызовом. Сметает,
    пока очередь не опустеет — тот же приём, что `loop-until-dry`."""
    for _ in range(max_sweeps):
        if relay.deliver_due_events() == 0:
            return


def _complete_deal(customer, contractor):
    """Полный сквозной сценарий Э4.6: подписан -> старт -> сдача -> приёмка
    -> обе стороны подтвердили оплату -> `complete_execution` (тот же путь,
    что `apps.milestones.tests.test_execution`)."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.accept_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    contract.refresh_from_db()
    return contract, milestone


def test_full_scenario_builds_deal_fact_visible_on_both_cards():
    customer = make_user("rep001")
    contractor = make_user("rep002")
    contract, _milestone = _complete_deal(customer, contractor)
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY

    delivered = relay.deliver_due_events()
    assert delivered > 0

    deal = DealFact.objects.get(contract_id=contract.id)
    assert deal.is_completed is True
    assert deal.outcome == DealFact.Outcome.COMPLETED
    assert deal.milestones_accepted == 1
    assert deal.completed_at is not None
    assert deal.period_start is not None and deal.period_end is not None

    customer_profile_id = contract.parties.get(role=_ROLE.CUSTOMER).profile_id
    contractor_profile_id = contract.parties.get(role=_ROLE.CONTRACTOR).profile_id
    assert str(deal.customer_profile_id) == str(customer_profile_id)
    assert str(deal.contractor_profile_id) == str(contractor_profile_id)

    # Приёмка ГВ.4: «карточка ОБЕИХ сторон показывает сделку с исходом».
    customer_deals = list(selectors.completed_deals_for_profile(customer_profile_id))
    contractor_deals = list(selectors.completed_deals_for_profile(contractor_profile_id))
    assert [d.contract_id for d in customer_deals] == [contract.id]
    assert [d.contract_id for d in contractor_deals] == [contract.id]

    # «Возраст + N сделок + N контрагентов» — паутина видна глазом.
    assert selectors.deals_count(customer_profile_id) == 1
    assert selectors.counterparties_count(customer_profile_id) == 1
    assert selectors.deals_count(contractor_profile_id) == 1
    assert selectors.counterparties_count(contractor_profile_id) == 1
    assert selectors.is_counterparty(customer_profile_id, contractor_profile_id) is True

    # ADR-045: «факт vs заявление» — на contract.completed заводится
    # source=FROM_CONTRACT для ОБЕИХ сторон, неопубликованная (публикация
    # требует согласия контрагента, apps.profiles.services.publish_project).
    for pid in (customer_profile_id, contractor_profile_id):
        project = PortfolioProject.objects.get(
            portfolio__profile_id=pid,
            source=PortfolioProject.Source.FROM_CONTRACT,
            source_contract_id=contract.id,
        )
        assert project.is_verified is True
        assert project.is_published is False
        assert project.counterparty_consent is False


def test_redelivery_after_sibling_subscriber_failure_does_not_duplicate_counts(settings):
    """Тот же сценарий, что apps.audit.tests.test_subscriber
    (redelivery-after-sibling-failure) — здесь для `milestone.accepted`:
    вторая доставка того же события не удваивает `milestones_accepted`."""

    settings.OUTBOX_SUBSCRIBERS = {
        "milestone.accepted": [
            "apps.reputation.tests.test_subscriber._module_flaky_sibling",
            "apps.reputation.subscriber.handle_event",
        ]
    }
    customer = make_user("rep003")
    contractor = make_user("rep004")
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.accept_milestone(milestone, user=customer)

    event = OutboxEvent.objects.get(topic="milestone.accepted")
    _flaky_failures[str(event.event_id)] = 1

    # Другие темы этого сценария (milestone.started и т.п.) не входят в
    # переопределённый OUTBOX_SUBSCRIBERS — relay доставляет их без
    # подписчиков тривиально, `delivered_first` поэтому НЕ 0; интересует
    # только судьба конкретного события milestone.accepted.
    relay.deliver_due_events()
    event.refresh_from_db()
    assert event.published_at is None
    assert DealFact.objects.get(contract_id=contract.id).milestones_accepted == 1
    assert ProcessedEvent.objects.filter(event_id=event.event_id).count() == 1

    event.next_attempt_at = None
    event.delivery_attempts = 0
    event.save(update_fields=["next_attempt_at", "delivery_attempts"])

    delivered_second = relay.deliver_due_events()
    assert delivered_second == 1
    assert DealFact.objects.get(contract_id=contract.id).milestones_accepted == 1
    assert ProcessedEvent.objects.filter(event_id=event.event_id).count() == 1


_flaky_failures: dict[str, int] = {}


def _module_flaky_sibling(event: OutboxEvent) -> None:
    key = str(event.event_id)
    remaining = _flaky_failures.get(key, 0)
    if remaining > 0:
        _flaky_failures[key] = remaining - 1
        raise RuntimeError("искусственный сбой другого подписчика той же темы")


def test_milestone_rejected_and_dispute_events_increment_counts_before_completion():
    customer = make_user("rep005")
    contractor = make_user("rep006")
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    milestones_services.start_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    # required_evidence=[] — reject_milestone (ADR-017) не требует, чтобы
    # пункт нёс required_evidence, только чтобы он существовал на ЭТОМ
    # этапе. Submit-гейта по покрытию больше нет вовсе (ADR-164), но
    # add_checklist_item_with_evidence мы всё равно намеренно НЕ берём:
    # доказательства вне зоны этого теста.
    checklist_item = ChecklistItem.objects.create(
        milestone=milestone,
        description="Работа выполнена по договору",
        measurable_criterion="Заказчик подтверждает",
    )
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.reject_milestone(
        milestone, user=customer, checklist_item_id=checklist_item.id, evidence=["doc-1"]
    )
    milestone.refresh_from_db()
    assert milestone.status == Milestone.Status.DISPUTED

    _drain()

    deal = DealFact.objects.get(contract_id=contract.id)
    assert deal.milestones_rejected == 1
    assert deal.disputes_opened == 1
    assert deal.is_completed is False

    dispute = milestone.disputes.get()
    disputes_services.resolve_dispute(dispute, user=customer, resolution_type="accepted")
    _drain()

    deal.refresh_from_db()
    assert deal.disputes_resolved == 1
    assert deal.dispute_resolutions == ["accepted"]
    # Спор разрешён «в пользу принятия» — этап возвращается в accepted
    # (apps.milestones.handlers.handle_dispute_resolved), но сделка
    # завершится только когда оплата будет подтверждена обеими сторонами —
    # в ГВ.4 список показывает ТОЛЬКО завершённые сделки.
    assert deal.is_completed is False


def test_no_delete_api_for_individual_deal():
    """Приёмка ГВ.4: «удаление отдельной сделки с карточки невозможно (нет
    такого API)» — namespace apps.reputation.api не содержит DELETE-вьюху
    ни для DealFact, ни для карточки целиком."""
    import apps.reputation.api.views as views_module

    view_classes = [
        obj
        for name in dir(views_module)
        if hasattr(obj := getattr(views_module, name), "http_method_names")
    ]
    assert view_classes, "ожидался хотя бы один APIView в apps.reputation.api.views"
    for view_cls in view_classes:
        assert not hasattr(view_cls, "delete"), f"{view_cls.__name__} не должен уметь DELETE"
