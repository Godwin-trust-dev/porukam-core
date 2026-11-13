"""feat/notifications-wiring — приёмка: сквозной сценарий Э4.6
(negotiation -> signing -> execution -> acceptance/dispute -> completion,
тот же путь, что apps/milestones/tests/test_execution.py, «ускоренный
конфиг» — дедлайны сдвигаются в прошлое напрямую, не ждём реальное время)
порождает Notification в каждой замапленной точке КОНТРАГЕНТУ актора
(ADR-178: сам актор своей же карточки не получает — было ровно наоборот
до этой правки, отсюда жалоба владельца «уведомления должны приходить
только по действиям контрагентов, не моих»), с телом на языке получателя.

Тексты — из настоящих файлов `l10n/packs/*.json` (не инлайн-фикстура):
пакеты импортируются напрямую через apps.l10n.services.import_pack, тот же
путь, что `import_l10n_pack`/деплой (chore/l10n-import, .github/workflows/
deploy-staging.yml) — если контент разойдётся с ожиданиями теста здесь,
разойдётся и в проде, тест должен это ловить, а не подставлять свой текст."""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest
from django.conf import settings
from django.utils import timezone

from apps.contracts.models import ContractParty
from apps.deadlines import tasks as deadlines_tasks
from apps.deadlines.models import DomainDeadline
from apps.disputes import services as disputes_services
from apps.disputes.models import Dispute
from apps.evidence import services as evidence_services
from apps.l10n import services as l10n_services
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.notifications.models import Notification
from common import relay

from ...milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_STATUS = Milestone.Status

_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"


@pytest.fixture(autouse=True)
def _import_l10n_packs():
    """en/ru — единственные locale, реально достижимые через контур
    получателя сегодня (apps.jurisdictions: только RU и GLOBAL/en сиды,
    docstring JurisdictionConfig.primary_locale) — es/hi/uk и остальные
    проверяются отдельно на уровне selectors (test_render_*_multilanguage
    ниже), не через полный flow."""
    for code in ("en", "ru"):
        data = json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))
        l10n_services.import_pack(data)


@pytest.fixture
def customer():
    return make_user("e001")


@pytest.fixture
def contractor():
    return make_user("e002")


def _notification(recipient, template_code: str) -> Notification:
    qs = Notification.objects.filter(recipient=recipient, template=template_code)
    if not qs.exists():
        existing = list(
            Notification.objects.filter(recipient=recipient).values_list("template", flat=True)
        )
        raise AssertionError(
            f"нет Notification(template={template_code!r}) для {recipient.trust_id} — "
            f"есть: {existing}"
        )
    return qs.latest("created_at")


def _no_notification(recipient, template_code: str) -> None:
    """ADR-178: своя же карточка на своё действие не размещается — обратная
    проверка к `_notification` (актор события НЕ должен её получить)."""
    assert not Notification.objects.filter(recipient=recipient, template=template_code).exists(), (
        f"актор {recipient.trust_id} получил свою же карточку {template_code!r}"
    )


def test_full_execution_path_produces_notifications_for_the_counterparty(customer, contractor):
    # make_signed_contract_with_leaf проводит договор через ВЕСЬ Э4.2-Э4.4
    # (draft -> under_review [negotiation.sent] -> pending_signature
    # [negotiation.frozen] -> signed [negotiation.signed + contract.signed]),
    # apps/contracts/tests/_signing_helpers.py — единственная точка, где
    # заводится Contract, дальше только читаем её последствия.
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    # negotiation.sent — actor customer; ADR-178: сам не получает, получает
    # контрагент (код с суффиксом .counterparty, текст расходится).
    _no_notification(customer, "negotiation.sent")
    negotiation_sent = _notification(contractor, "negotiation.sent.counterparty")
    assert negotiation_sent.payload is not None
    assert negotiation_sent.placed_in_cabinet_at is not None

    # negotiation.frozen — actor тоже customer (freeze_contract вызван им в
    # helper'е); текст нейтрален — один код, но актор его больше не видит.
    _no_notification(customer, "negotiation.frozen")
    _notification(contractor, "negotiation.frozen")

    # negotiation.signed — actor первого подписанта (helper подписывает
    # customer первым, apps/contracts/tests/_signing_helpers.py::sign_both);
    # код без .counterparty актору больше не размещается вовсе.
    _no_notification(customer, "negotiation.signed")
    _notification(contractor, "negotiation.signed.counterparty")

    # contract.signed — actor второго подписанта (contractor); customer —
    # неактор, получает; contractor свою же карточку — нет.
    _notification(customer, "contract.signed")
    _no_notification(contractor, "contract.signed")

    # --- milestone.started: лист гейт уже прошёл САМ сразу после
    # contract.signed (apps.milestones.handlers.handle_contract_signed ->
    # _try_auto_start, ADR-162) — событие БЕЗ актора, обеим сторонам.
    # Явный `start_milestone(user=customer)` ниже на уже `in_progress`
    # листе — идемпотентный no-op (ничего нового не публикует).
    milestones_services.start_milestone(milestone, user=customer)
    relay.deliver_due_events()
    _notification(customer, "milestone.started")
    _notification(contractor, "milestone.started")

    # --- сдача: milestone_submitted_for_acceptance (прямой вызов, customer) ---
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    milestones_services.submit_milestone(milestone, user=contractor)
    relay.deliver_due_events()
    _notification(customer, "milestone_submitted_for_acceptance")
    # evidence_received — прямой вызов, контрагенту загрузившего (customer)
    _notification(customer, "evidence_received")

    # --- milestone.accepted (accept_milestone, actor — customer) ---
    milestones_services.accept_milestone(milestone, user=customer)
    relay.deliver_due_events()
    _no_notification(customer, "milestone.accepted")
    _notification(contractor, "milestone.accepted")

    # --- dispute.opened / dispute.resolved — через reject -> resolve ---
    item2 = add_checklist_item_with_evidence(milestone)
    milestone.status = _STATUS.UNDER_ACCEPTANCE
    milestone.save(update_fields=["status"])
    milestones_services.reject_milestone(
        milestone, user=customer, checklist_item_id=item2.id, evidence=["photo-defect.jpg"]
    )
    # milestone.rejected сам по себе не публикует dispute.opened — тот
    # публикует apps.disputes.handlers.handle_milestone_rejected, ПОДПИСЧИК
    # на milestone.rejected (settings.OUTBOX_SUBSCRIBERS). deliver_due_events
    # берёт фиксированный срез due-событий ДО обработки (common/relay.py) —
    # событие, порождённое подписчиком в процессе доставки, попадёт в
    # выборку только следующим вызовом, отсюда два прохода.
    relay.deliver_due_events()
    relay.deliver_due_events()
    _no_notification(customer, "dispute.opened")
    _notification(contractor, "dispute.opened")

    dispute = Dispute.objects.get(milestone=milestone)
    disputes_services.resolve_dispute(dispute, user=contractor, resolution_type="accepted")
    relay.deliver_due_events()
    relay.deliver_due_events()
    _no_notification(contractor, "dispute.resolved")
    _notification(customer, "dispute.resolved")

    # --- оплата -> contract.completed (прямой вызов ОБЕИМ сторонам, не
    # затронут ADR-178 — двусторонний факт, а не «моё действие») ---
    milestone.refresh_from_db()
    if milestone.status != _STATUS.ACCEPTED:
        milestones_services.accept_milestone(milestone, user=customer)
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    relay.deliver_due_events()
    _notification(customer, "contract.completed")
    _notification(contractor, "contract.completed")

    # --- milestone.auto_accepted — отдельный договор (после accept выше
    # этот путь уже не воспроизвести на том же milestone) ---
    customer2, contractor2 = make_user("e003"), make_user("e004")
    contract2, milestone2 = make_signed_contract_with_leaf(
        customer=customer2, contractor=contractor2
    )
    relay.deliver_due_events()
    milestones_services.start_milestone(milestone2, user=customer2)
    item3 = add_checklist_item_with_evidence(milestone2)
    evidence_services.upload_evidence(
        contract2,
        user=contractor2,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone2.id,
        checklist_item_id=item3.id,
    )
    milestones_services.submit_milestone(milestone2, user=contractor2)
    deadline = DomainDeadline.objects.get(
        subject_type="milestone", subject_id=milestone2.id, kind="milestone_acceptance"
    )
    deadline.deadline_at = timezone.now() - timedelta(hours=1)
    deadline.save(update_fields=["deadline_at"])
    deadlines_tasks.sweep_domain_deadlines()
    # domain_deadline.fired -> apps.milestones.handlers.handle_deadline_fired
    # (finalize_acceptance, публикует milestone.auto_accepted) -> ещё один
    # проход на доставку самого milestone.auto_accepted (тот же каскад, что
    # dispute.opened/dispute.resolved выше).
    relay.deliver_due_events()
    relay.deliver_due_events()
    # ADR-178: автоприёмка — системное событие БЕЗ актора (свип дедлайнов),
    # а не «моё действие» — уходит ОБЕИМ сторонам через реестр контрагента.
    # До ADR-178 finalize_acceptance подставлял заказчика fallback-актором,
    # чтобы попасть в реестр «актора» — тогда это давало карточку только
    # заказчику; теперь фолбэка нет, и получают оба.
    _notification(customer2, "milestone.auto_accepted")
    _notification(contractor2, "milestone.auto_accepted")


def test_notification_body_is_in_recipient_locale_ru_and_en(customer, contractor):
    """Тело/тема реально приходят РАЗНЫМ текстом на ru и en (не пустая
    строка, не один и тот же текст) — доказывает, что рендер идёт через
    apps.l10n, а не молча падает на один язык."""
    from apps.notifications import selectors as notification_selectors

    ru_body = notification_selectors.render_body("negotiation.sent", locale="ru")
    en_body = notification_selectors.render_body("negotiation.sent", locale="en")
    assert ru_body and en_body
    assert ru_body != en_body
    assert "Договор" in ru_body
    assert "contract" in en_body.lower() or "sent" in en_body.lower()

    ru_subject = notification_selectors.render_subject("negotiation.sent", locale="ru")
    en_subject = notification_selectors.render_subject("negotiation.sent", locale="en")
    assert ru_subject and en_subject and ru_subject != en_subject


@pytest.mark.parametrize("locale", ["es", "hi", "uk"])
def test_render_falls_back_to_en_for_unmapped_topic_locales(locale):
    """negotiation.sent и т.п. осознанно НЕ переведены на 24 «machine»
    locale (см. коммит feat/notifications-wiring — старый текст пакета был
    адресован не тому получателю, реальный перевод — отдельная задача) —
    apps.l10n фолбэк locale->en должен молча сработать, а не отдать "" ."""
    from apps.notifications import selectors as notification_selectors

    body = notification_selectors.render_body("negotiation.sent", locale=locale)
    en_body = notification_selectors.render_body("negotiation.sent", locale="en")
    assert body == en_body
    assert body


def test_render_uses_real_pack_translation_when_present():
    """catalog/errors namespaces УЖЕ переведены на все 26 — контрольная
    проверка на соседнем (не notifications) namespace, что чтение пакета
    вообще работает по-честному на не-en/ru locale, раз notifications пока
    им сознательно не покрыт (см. тест выше)."""
    from apps.l10n import selectors as l10n_selectors

    data = json.loads((_PACKS_DIR / "es.json").read_text(encoding="utf-8"))
    l10n_services.import_pack(data)

    es_title = l10n_selectors.get_error_title("otp_invalid_code", locale="es")
    en_title = l10n_selectors.get_error_title("otp_invalid_code", locale="en")
    assert es_title and en_title and es_title != en_title
