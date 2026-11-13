"""ADR-126 — «уведомления должны приходить по КАЖДОМУ действию по договору»
(отсмотр 25.08), сужено ADR-178 (жалоба владельца 11.09 «уведомления должны
приходить только по действиям контрагентов, не моих»). Проверяем:

1. платёжный контур (`confirm_payment`) вообще рождает
   уведомления и попадает во вкладку «Платежи» ленты — жалоба «уведомления
   не приходят при действиях по оплате» дословно про это;
2. КОНТРАГЕНТ актора узнаёт о чужом действии (второй реестр,
   `NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES`), а САМ АКТОР — НЕТ (ADR-178:
   своя же карточка «действие зафиксировано» убрана совсем, история своих
   действий видна в хронике договора/этапа);
3. системное событие без актора адресуется ОБЕИМ сторонам (это не «моё
   действие», а факт, который случился сам);
4. один топик `negotiation.revised` разводится по `payload["action"]`;
5. повторная доставка события (ADR-064 at-least-once) не удваивает ленту.

Сценарии — через настоящие services (тот же путь, что прод), кроме случаев,
где FSM-предусловия дороже самой проверки: там событие конструируется прямо
(`OutboxEvent.objects.create`) и подаётся в `subscriber.handle_event` —
подписчик всё равно единственная проверяемая единица."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from apps.contracts import services as contracts_services
from apps.contracts.models import Contract, ContractParty
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.notifications import selectors as notification_selectors
from apps.notifications import subscriber
from apps.notifications.models import Notification
from common import relay
from common.models import OutboxEvent

from ...milestones.tests._execution_helpers import (
    make_signed_contract_with_leaf,
    make_under_review_contract,
    make_user,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_ROLE = ContractParty.Role
_STATUS = Milestone.Status


def _templates(recipient) -> set[str]:
    return set(Notification.objects.filter(recipient=recipient).values_list("template", flat=True))


def _accepted_leaf(customer, contractor, *, payment_method: str):
    """Подписанный договор с ЕДИНСТВЕННЫМ листом в статусе accepted —
    стартовая точка платёжных действий. Статус ставится напрямую: путь
    start -> submit -> accept проверен в apps/milestones/tests, здесь он
    только шум, а `confirm_payment` требует ровно accepted."""
    contract, milestone = make_signed_contract_with_leaf(
        customer=customer, contractor=contractor, payment_method=payment_method
    )
    milestone.status = _STATUS.ACCEPTED
    milestone.save(update_fields=["status"])
    # Гейт этапа тем же напрямую не проходим — но исполнение договора обязано
    # быть in_progress, иначе `complete_execution` на последнем оплаченном
    # листе упадёт FSM-переходом из pending_start.
    contracts_services.start_execution(contract)
    relay.deliver_due_events()
    Notification.objects.all().delete()  # шум согласования/подписания — не предмет теста
    return contract, milestone


def test_payment_confirmation_notifies_only_counterparty():
    """Главная дыра аудита ADR-126: до неё `milestone.payment_confirmed` не
    был ни в одном реестре — по подтверждению оплаты не приходило НИЧЕГО.
    ADR-178: подтвердившая сторона (актор) свою же карточку больше не
    получает — только контрагент."""
    customer, contractor = make_user("c101"), make_user("c102")
    _contract, milestone = _accepted_leaf(
        customer, contractor, payment_method=Contract.PaymentMethod.CASH
    )

    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    relay.deliver_due_events()

    assert "milestone.payment_confirmed" not in _templates(customer)
    assert "milestone.payment_confirmed.counterparty" in _templates(contractor)


def test_second_confirmation_notifies_only_the_party_that_did_not_just_confirm():
    """ADR-178: `milestone.paid` наступает по ВТОРОМУ подтверждению — актор
    этого события контрагент (второй подтвердивший), он и не получает
    карточку «этап оплачен» (сам только что это сделал); первый
    подтвердивший (customer) — получает."""
    customer, contractor = make_user("c103"), make_user("c104")
    _contract, milestone = _accepted_leaf(
        customer, contractor, payment_method=Contract.PaymentMethod.CASH
    )

    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    relay.deliver_due_events()

    assert "milestone.paid" in _templates(customer)
    assert "milestone.paid" not in _templates(contractor)


def test_payment_notifications_land_in_payments_feed_group():
    """Вкладка «Платежи» ленты и тумблер group_payments считают группу по
    шаблону (selectors.channel_group_for_template). До ADR-126 на тип
    "payment" не ссылался ни один шаблон — вкладка была пуста по построению."""
    for template in (
        # ADR-155: коды аванса остаются в проекции ленты — по ним
        # рендерятся уже размещённые уведомления; новых событий с этими
        # топиками больше не бывает.
        "milestone.advance_confirmed",
        "milestone.advance_confirmed.counterparty",
        "milestone.payment_confirmed",
        "milestone.payment_confirmed.counterparty",
        "milestone.paid",
    ):
        assert notification_selectors.channel_group_for_template(template) == "payments", template


# ADR-155: тест «подтверждение аванса уведомляет контрагента» снят вместе с
# самим авансом (способ `payment_method=prepayment` и вид платежа `advance`
# упразднены). Тот же факт при предоплате несёт `milestone.payment_confirmed`
# — он покрыт `test_payment_confirmation_notifies_actor_and_counterparty` выше: платёж по
# листу теперь ОДИН, и уведомление о его подтверждении тоже одно.


def test_send_for_review_notifies_only_counterparty():
    customer, contractor = make_user("c107"), make_user("c108")
    make_under_review_contract(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    # ADR-178: отправитель (customer) карточку «вы отправили на
    # согласование» больше не получает — только контрагент.
    assert "negotiation.sent" not in _templates(customer)
    assert "negotiation.sent.counterparty" in _templates(contractor)


def test_revision_templates_are_chosen_by_payload_action():
    """Один топик `negotiation.revised` — три разных для контрагента факта.
    Разводит их словарная запись реестра по payload["action"]."""
    customer, contractor = make_user("c109"), make_user("c110")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    relay.deliver_due_events()
    Notification.objects.all().delete()

    proposal = contracts_services.propose_revision(
        contract, user=contractor, item_ref="price", new_value="9000.00"
    )
    relay.deliver_due_events()
    # Правку предложил исполнитель — «предложена правка» видит заказчик.
    assert "negotiation.revised.proposed" in _templates(customer)
    assert "negotiation.revised.proposed" not in _templates(contractor)

    contracts_services.accept_revision(proposal, user=customer)
    relay.deliver_due_events()
    # Приняли ЕГО правку — «ваша правка принята» видит автор правки.
    assert "negotiation.revised.accepted" in _templates(contractor)

    other = contracts_services.propose_revision(
        contract, user=contractor, item_ref="deadline", new_value="30"
    )
    contracts_services.reject_revision(other, user=customer)
    relay.deliver_due_events()
    assert "negotiation.revised.rejected" in _templates(contractor)


def test_system_event_without_actor_notifies_both_parties():
    """`contract.closed` (гарантия истекла) и `negotiation.signature_request_
    expired` (дедлайн-свип) публикуются с пустым actor — до ADR-126 подписчик
    молча выбрасывал такое событие, «некому размещать уведомление»."""
    customer, contractor = make_user("c111"), make_user("c112")
    contract, _milestone = _accepted_leaf(
        customer, contractor, payment_method=Contract.PaymentMethod.CASH
    )

    event = OutboxEvent.objects.create(
        topic="contract.closed",
        occurred_at=timezone.now(),
        actor={},
        subject={"type": "contract", "id": str(contract.id)},
        payload={},
    )
    subscriber.handle_event(event)

    assert "contract.closed" in _templates(customer)
    assert "contract.closed" in _templates(contractor)


def test_termination_notifies_counterparty():
    customer, contractor = make_user("c113"), make_user("c114")
    contract, milestone = _accepted_leaf(
        customer, contractor, payment_method=Contract.PaymentMethod.CASH
    )
    contracts_services.terminate_by_customer(contract, user=customer, reason="сроки сорваны")
    relay.deliver_due_events()

    assert "contract.terminated" in _templates(contractor)
    # Инициатору расторжения «вам расторгли договор» не приходит.
    assert "contract.terminated" not in _templates(customer)
    assert milestone.contract_id == contract.id


def test_repeated_delivery_of_the_same_event_does_not_duplicate_notifications():
    """ADR-064: реле переотдаёт событие ВСЕМ подписчикам темы, если упал хоть
    один. Повторная доставка не должна множить ленту. Дедупликация —
    Notification.source_event_id. `milestone.payment_confirmed` (ADR-178)
    адресован только контрагенту подтвердившего — одно уведомление на
    событие, не два."""
    customer, contractor = make_user("c115"), make_user("c116")
    _contract, milestone = _accepted_leaf(
        customer, contractor, payment_method=Contract.PaymentMethod.CASH
    )
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    event = OutboxEvent.objects.get(topic="milestone.payment_confirmed")

    subscriber.handle_event(event)
    after_first = Notification.objects.count()
    assert after_first == 1  # только контрагент

    subscriber.handle_event(event)
    subscriber.handle_event(event)
    assert Notification.objects.count() == after_first
    assert Notification.objects.filter(source_event_id=event.event_id).count() == after_first


def test_direct_place_notification_keeps_null_source_event_id():
    """«Прямые» вызовы place_notification (signature_requested и соседи) не
    от события — их source_event_id остаётся NULL, и условный
    UniqueConstraint не схлопывает их между собой."""
    from apps.notifications import services as notification_services

    recipient = make_user("c117")
    for _ in range(2):
        notification_services.place_notification(
            recipient=recipient,
            template="signature_requested",
            payload={"side": _ROLE.CUSTOMER},
            legal_significance=True,
        )
    placed = Notification.objects.filter(recipient=recipient, template="signature_requested")
    assert placed.count() == 2
    assert all(n.source_event_id is None for n in placed)


def test_milestone_tree_edits_stay_unmapped():
    """Обратная сторона аудита: правка дерева этапов (milestone.created и
    соседи) сознательно НЕ рождает уведомление — иначе мастер создания
    договора засыпал бы ленту. Фиксируем решение тестом, чтобы «дополним
    реестр до полноты» не прошло молча."""
    customer, contractor = make_user("c118"), make_user("c119")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    relay.deliver_due_events()
    Notification.objects.all().delete()

    milestones_services.create_milestone(
        contract, user=customer, title="Ещё работа", amount=Decimal("500.00"), currency="RUB"
    )
    relay.deliver_due_events()

    assert Notification.objects.count() == 0


def test_new_templates_render_from_real_l10n_packs():
    """Коды-топики берут текст из `l10n/packs/*.json` (namespace
    `notifications.<code>`), а не из body_i18n — миграция 0014 сеет строки с
    ПУСТЫМ body_i18n намеренно. Если ключ в пакет не долит, лента покажет
    пустоту, поэтому проверяем на настоящих файлах, тем же путём, что
    `import_l10n_pack` в деплое."""
    import json
    from pathlib import Path

    from django.conf import settings

    from apps.l10n import services as l10n_services

    packs_dir = Path(settings.BASE_DIR).parent / "l10n" / "packs"
    for code in ("en", "ru"):
        l10n_services.import_pack(json.loads((packs_dir / f"{code}.json").read_text("utf-8")))

    new_codes = [
        "milestone.paid",
        "milestone.payment_confirmed",
        "milestone.payment_confirmed.counterparty",
        "milestone.advance_confirmed",
        "milestone.advance_confirmed.counterparty",
        "negotiation.sent.counterparty",
        "negotiation.revised.proposed",
        "negotiation.revised.accepted",
        "negotiation.revised.rejected",
        "negotiation.withdrawn",
        "negotiation.rejected",
        "negotiation.reopened",
        "negotiation.signed.counterparty",
        "negotiation.signature_request_expired",
        "contract.amended",
        "contract.terminated",
        "contract.closed",
        "amendment.sent",
        "milestone.material_received",
        # ADR-155: симметричный шаг «передано».
        "milestone.material_handed_over",
        "milestone.resumed",
    ]
    for code in new_codes:
        ru = notification_selectors.render_body(code, locale="ru")
        en = notification_selectors.render_body(code, locale="en")
        assert ru and en and ru != en, code
        assert notification_selectors.render_subject(code, locale="ru"), code
    # Подстановка реально срабатывает (плейсхолдер не остаётся в тексте).
    body = notification_selectors.render_body("milestone.paid", locale="ru")
    assert "{milestone_title}" in body
    assert "Фундамент" in body.format(milestone_title="Фундамент")
