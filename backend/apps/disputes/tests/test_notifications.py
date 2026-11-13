"""ADR-126 + ADR-131: КАЖДОЕ действие по разногласию и гарантии рождает
уведомление ОБЕИМ сторонам (актор + контрагент), с телом на языке
получателя из настоящих пакетов `l10n/packs/*.json` — тот же приём, что
apps/notifications/tests/test_wiring_e2e.py: если контент разойдётся с
ожиданиями здесь, он разойдётся и в проде."""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from django.conf import settings
from django.utils import timezone

from apps.contracts import services as contracts_services
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.disputes import services
from apps.l10n import services as l10n_services
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from apps.notifications import selectors as notification_selectors
from apps.notifications.models import Notification
from apps.notifications.selectors import channel_group_for_template
from apps.warranty import services as warranty_services
from common import relay

from ._helpers import make_warranty_contract, open_milestone_dispute

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"
_ANTI_WAIVER = "Скидка закрывает только указанный дефект"


@pytest.fixture(autouse=True)
def _import_l10n_packs():
    for code in ("en", "ru"):
        data = json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))
        l10n_services.import_pack(data)


@pytest.fixture
def customer():
    return make_user("n001")


@pytest.fixture
def contractor():
    return make_user("n002")


@pytest.fixture
def dispute(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    return open_milestone_dispute(contract, milestone, customer=customer, contractor=contractor)


class _SafeDict(dict):
    """format_map без KeyError — зеркало `_SafeFormatDict` из
    apps.notifications.selectors (тексты пакетов могут ссылаться на ключи,
    которых нет в payload)."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _templates(user) -> set[str]:
    return set(Notification.objects.filter(recipient=user).values_list("template", flat=True))


def _both(customer, contractor, template: str) -> None:
    for user in (customer, contractor):
        assert template in _templates(user), (
            f"нет уведомления {template!r} для {user.trust_id}; есть: {sorted(_templates(user))}"
        )


def _only_the_other_side(actor, other, template: str) -> None:
    """ADR-178: актор действия свою же карточку не получает (история видна
    в хронике спора/этапа) — только другая сторона."""
    assert template not in _templates(actor), (
        f"актор {actor.trust_id} получил свою же карточку {template!r}"
    )
    assert template in _templates(other), (
        f"нет уведомления {template!r} для {other.trust_id}; есть: {sorted(_templates(other))}"
    )


def test_fix_request_notifies_only_the_contractor(dispute, customer, contractor):
    services.request_fix(dispute, user=customer, comment="переделать")
    relay.deliver_due_events()
    _only_the_other_side(customer, contractor, "dispute.fix_requested")
    notification = Notification.objects.filter(
        recipient=contractor, template="dispute.fix_requested"
    ).get()
    body = notification_selectors.render_body("dispute.fix_requested", locale="ru").format_map(
        _SafeDict(notification.payload)
    )
    # Текст пришёл из настоящего пакета l10n и плейсхолдеры подставились
    # (ADR-098: payload самодостаточен в момент размещения).
    assert "раунд исправления 1 из 2" in body
    assert "{milestone_title}" not in body


def test_fix_resubmit_notifies_only_the_customer(dispute, customer, contractor):
    fix_request = services.request_fix(dispute, user=customer)
    services.resubmit_fix(fix_request, user=contractor)
    relay.deliver_due_events()
    _only_the_other_side(contractor, customer, "dispute.fix_resubmitted")


def test_respond_notifies_only_the_customer(dispute, customer, contractor):
    services.respond_to_dispute(dispute, user=contractor, comment="возражаю", evidence=[])
    relay.deliver_due_events()
    _only_the_other_side(contractor, customer, "dispute.responded")


def test_discount_proposal_and_decline_notify_only_the_other_side(dispute, customer, contractor):
    agreement = services.propose_discount(
        dispute,
        user=contractor,
        new_amount=Decimal("9000.00"),
        currency="RUB",
        anti_waiver_note=_ANTI_WAIVER,
    )
    relay.deliver_due_events()
    _only_the_other_side(contractor, customer, "dispute.discount_proposed")

    services.decline_discount(agreement, user=customer)
    relay.deliver_due_events()
    _only_the_other_side(customer, contractor, "dispute.discount_declined")


def test_cap_reached_notifies_both_sides_without_actor(dispute, customer, contractor):
    deadline = DomainDeadline.objects.get(
        kind="dispute_cap", subject_type="dispute", subject_id=dispute.id
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()
    relay.deliver_due_events()
    _both(customer, contractor, "dispute.cap_reached")
    _both(customer, contractor, "dispute.resolved")


def test_window_expired_notifies_both_sides(dispute, customer, contractor):
    deadline = DomainDeadline.objects.get(
        kind="dispute_response_window", subject_type="dispute", subject_id=dispute.id
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    relay.deliver_due_events()
    relay.deliver_due_events()
    _both(customer, contractor, "dispute.window_expired")


def test_termination_window_contest_notifies_only_the_terminating_side(customer, contractor):
    from ._helpers import submit_milestone_with_evidence

    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    submit_milestone_with_evidence(contract, milestone, customer=customer, contractor=contractor)
    contracts_services.terminate_by_contractor(contract, user=contractor, reason="нет доступа")
    relay.deliver_due_events()
    relay.deliver_due_events()
    window = contract.dispute_windows.get()
    services.contest_window(window, user=customer, comment="доступ был")
    relay.deliver_due_events()
    _only_the_other_side(customer, contractor, "dispute.window_contested")


def test_warranty_claim_notifies_only_the_contractor_then_auto_resolution_notifies_both(
    customer, contractor
):
    """Подача претензии — действие заказчика (актор), карточку получает
    только исполнитель. Закрытие БЕЗ актора (сюда — как системный исход
    диалога, `resolve_warranty_claim` без `user`) уходит обеим сторонам."""
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    claim = warranty_services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )
    relay.deliver_due_events()
    relay.deliver_due_events()
    _only_the_other_side(customer, contractor, "warranty.claim_submitted")

    warranty_services.resolve_warranty_claim(claim, resolution_type="warranty_satisfied")
    relay.deliver_due_events()
    _both(customer, contractor, "warranty.claim_resolved")


def test_warranty_claim_decline_notifies_only_the_customer(customer, contractor):
    """`POST /warranty-claims/{id}/decline` -> `warranty.claim_declined`
    только заказчику (исполнитель — актор отказа, свою же карточку не
    получает), текст — из настоящего пакета (ru: «Исполнитель отказал…»);
    `warranty.claim_resolved` о том же моменте НЕ дублируется (ADR-126 §4)."""
    contract, _milestone = make_warranty_contract(customer=customer, contractor=contractor)
    claim = warranty_services.submit_warranty_claim(
        contract, user=customer, description="плитка отошла", evidence=["photo.jpg"]
    )
    relay.deliver_due_events()
    relay.deliver_due_events()
    warranty_services.decline_warranty_claim(claim, user=contractor, comment="монтаж по ТЗ")
    relay.deliver_due_events()
    relay.deliver_due_events()
    _only_the_other_side(contractor, customer, "warranty.claim_declined")
    assert "warranty.claim_resolved" not in _templates(customer)
    body = notification_selectors.render_body("warranty.claim_declined", locale="ru")
    assert body.startswith("Исполнитель отказал по гарантийной претензии")


def test_dispute_templates_land_in_disputes_feed_group():
    """Новых ТИПОВ ленты фронту не заводится: всё падает в существующие
    группы-каналы (ADR-126 «Фронту новые типы уведомлений не требуют работы»)."""
    for template in (
        "dispute.fix_requested",
        "dispute.responded",
        "dispute.discount_proposed",
        "dispute.discount_declined",
        "dispute.window_contested",
        "dispute.cap_reached",
        "warranty.claim_submitted",
        "warranty.claim_resolved",
        "warranty.claim_declined",
    ):
        assert channel_group_for_template(template) == "disputes"
    assert channel_group_for_template("dispute.window_expired") == "deadlines"
    assert channel_group_for_template("dispute.fix_resubmitted") == "deals"


def test_every_registered_dispute_topic_has_a_template_row():
    """Реестр без строки NotificationTemplate = молчаливая потеря
    уведомления (subscriber._place пишет warning и выходит)."""
    from apps.notifications.models import NotificationTemplate

    codes = {
        code
        for topic, code in settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES.items()
        if isinstance(code, str) and (topic.startswith("dispute.") or topic.startswith("warranty."))
    }
    existing = set(
        NotificationTemplate.objects.filter(code__in=codes).values_list("code", flat=True)
    )
    assert codes - existing == set()
