"""Глубокие ссылки уведомлений (ADR-170).

Пункт ленты, пуш и кнопка письма ведут в РАЗДЕЛ, о котором пришло
уведомление, а не на общую вкладку сделки. Карта «шаблон -> цель» — чистая
функция `feed_href_for`, поэтому основная часть тестов идёт без БД: по одному
на семейство шаблонов плюс запрет якоря у «обзорных» шаблонов.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest

from apps.accounts.models import User
from apps.notifications import providers
from apps.notifications.models import PushSubscription
from apps.notifications.selectors import feed_anchor_for, feed_href_for

CONTRACT_ID = UUID("01a02359-6ef5-7466-8712-ef63299b169a")
MILESTONE_ID = UUID("01a02359-6ef5-7466-8712-ef63299b169b")
DISPUTE_ID = UUID("01a02359-6ef5-7466-8712-ef63299b169c")


# --- Семейства шаблонов -----------------------------------------------------


@pytest.mark.parametrize(
    "template",
    [
        "negotiation.sent",
        "negotiation.sent.counterparty",
        "negotiation.revised.proposed",
        "negotiation.signed",
        "negotiation.signature_request_expired",
        "signature_requested",
        "contract.signed",
    ],
)
def test_negotiation_family_opens_nego_sign_tab(template: str) -> None:
    """Правки, отправка на согласование и подписи — вкладка «Переговоры и
    подписи»: ровно тот случай, из-за которого владелец «искал правку»."""
    assert feed_href_for(template, CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}#negoSign"


@pytest.mark.parametrize(
    "template",
    ["amendment.sent", "amendment.rejected", "amendment.withdrawn", "contract.amended"],
)
def test_amendment_family_opens_amendments_tab(template: str) -> None:
    assert feed_href_for(template, CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}#amendments"


@pytest.mark.parametrize(
    "template",
    [
        "milestone.started",
        "milestone.accepted",
        "milestone.rejected",
        "milestone_submitted_for_acceptance",
        "milestone_acceptance_reminder",
        "milestone_material_notice",
        "evidence_received",
    ],
)
def test_milestone_family_opens_the_milestone_itself(template: str) -> None:
    """С `milestone_id` в payload — якорь конкретного этапа (фронт по нему
    открывает «Этапы» и прокручивает к этапу)."""
    payload = {"milestone_id": str(MILESTONE_ID)}
    assert feed_href_for(template, CONTRACT_ID, payload) == (
        f"/contracts/{CONTRACT_ID}#milestone-{MILESTONE_ID}"
    )


def test_milestone_family_without_id_opens_stages_tab() -> None:
    assert feed_href_for("milestone.started", CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}#stages"


def test_milestone_family_with_garbage_id_degrades_to_stages() -> None:
    """Битый `milestone_id` (легаси-запись) не должен рождать мусорный якорь."""
    payload = {"milestone_id": "не-uuid"}
    assert feed_href_for("milestone.accepted", CONTRACT_ID, payload) == (
        f"/contracts/{CONTRACT_ID}#stages"
    )


def test_materials_changed_keeps_milestone_anchor() -> None:
    """ADR-156 §3 не потерян: правки материалов по-прежнему ведут в этап."""
    payload = {"milestone_id": str(MILESTONE_ID), "changes_count": 2}
    assert feed_href_for("contract.materials_changed", CONTRACT_ID, payload) == (
        f"/contracts/{CONTRACT_ID}#milestone-{MILESTONE_ID}"
    )


@pytest.mark.parametrize(
    "template",
    [
        "payment.created",
        "payment.overdue",
        "payment.cancelled",
        "payment.cancelled.counterparty",
        "milestone.paid",
        "milestone.payment_confirmed",
        "milestone.payment_confirmed.counterparty",
        "milestone.advance_confirmed",
    ],
)
def test_payment_family_opens_payments_tab(template: str) -> None:
    """Платёжные `milestone.*` — «Платежи», а не «Этапы»: тот же разрыв
    семейства и раздела, что уже зашит в проекцию типа ленты."""
    payload = {"milestone_id": str(MILESTONE_ID)}
    assert feed_href_for(template, CONTRACT_ID, payload) == f"/contracts/{CONTRACT_ID}#payments"


@pytest.mark.parametrize(
    "template",
    [
        "dispute.opened",
        "dispute.responded",
        "dispute.window_expired",
        "warranty.claim_submitted",
        "warranty.claim_satisfied",
        "warranty_claim_acceptance_reminder",
    ],
)
def test_dispute_family_opens_its_own_page(template: str) -> None:
    """У разногласий вкладки в карточке нет — только своя страница."""
    payload = {"dispute_id": str(DISPUTE_ID), "contract_id": str(CONTRACT_ID)}
    assert feed_href_for(template, CONTRACT_ID, payload) == f"/disputes/{DISPUTE_ID}"


def test_dispute_without_id_falls_back_to_contract_card() -> None:
    assert feed_href_for("dispute.opened", CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}"


def test_chat_message_opens_the_thread_not_the_card_tab() -> None:
    """Вкладка «Чат» карточки — каллаут с кнопкой; ведём сразу в переписку."""
    assert feed_href_for("message.received", CONTRACT_ID, {}) == f"/chat/{CONTRACT_ID}"


def test_archive_ready_opens_archive_page() -> None:
    assert feed_href_for("archive.ready", CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}/archive"


@pytest.mark.parametrize(
    "template",
    [
        "contract.completed",
        "contract.closed",
        "contract.terminated",
        "contract.idle_warning",
        "contract.idle_blocked",
        "contract.auto_closed",
        "evidence.retention_expiring",
        "evidence.archived",
        "evidence.shredded",
        "entity_claimed",
        "",
        "какой-то.новый.код",
    ],
)
def test_overview_templates_get_no_anchor(template: str) -> None:
    """Обзорные и незнакомые шаблоны — карточка целиком. Промахнуться
    разделом хуже, чем не угадать его вовсе."""
    assert feed_anchor_for(template, {"milestone_id": str(MILESTONE_ID)}) == ""
    assert feed_href_for(template, CONTRACT_ID, {}) == f"/contracts/{CONTRACT_ID}"


# --- Те же ссылки в пуше и письме -------------------------------------------


@pytest.mark.django_db
def test_push_url_uses_the_same_map(monkeypatch, settings) -> None:  # noqa: ANN001
    """Тап по пушу и клик по пункту ленты о том же поводе ведут в одно место."""
    settings.WEBPUSH_VAPID_PRIVATE_KEY = "k"
    user = User.objects.create(trust_id="trust-push-deep", phone="+79990934001")
    PushSubscription.objects.create(
        user=user, endpoint="https://p.example/deep", p256dh="p", auth="a"
    )
    sent: dict[str, object] = {}

    def fake_webpush(**kwargs: object) -> None:
        sent.update(kwargs)

    import pywebpush

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    message = {
        "subject": "Правка",
        "body": "Правка",
        "template": "negotiation.revised.proposed",
        "payload": {"contract_title": "Ремонт кухни"},
        "contract_id": str(CONTRACT_ID),
    }
    assert providers.WebPushProvider().send(user, message).delivered is True
    assert json.loads(str(sent["data"]))["url"] == f"/contracts/{CONTRACT_ID}#negoSign"


def test_email_button_uses_the_same_map(settings) -> None:  # noqa: ANN001
    settings.PUBLIC_WEB_BASE_URL = "https://porukam.app"
    message = {
        "template": "payment.created",
        "payload": {"milestone_id": str(uuid4())},
        "contract_id": str(CONTRACT_ID),
    }
    assert providers._deal_url(message) == f"https://porukam.app/contracts/{CONTRACT_ID}#payments"
