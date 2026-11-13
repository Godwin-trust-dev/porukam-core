"""Отсмотр прода 2026-08-20: мета пункта ленты (ссылка на договор,
контрагент, сумма) резолвится ПРИ ЧТЕНИИ из живого договора, а не
единожды из payload при размещении (ADR-098).

Прод-кейс: уведомление «Договор отправлен на согласование», размещённое до
выката обогащения — contract_id пуст, payload пуст — было некликабельным и
без контрагента/суммы, и дописать ему payload нельзя (append-only,
content_hash). Плюс `amount` вообще не доходил до фронта: selectors клали
его в пункт, а NotificationFeedItemSerializer поля не объявлял."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from rest_framework.test import APIClient

from apps.accounts import services as accounts_services
from apps.l10n import services as l10n_services
from apps.notifications import selectors, services
from apps.notifications.models import Notification

from ...contracts.tests._signing_helpers import make_under_review_contract, make_user
from ...milestones.tests._execution_helpers import make_signed_contract_with_leaf
from .test_api import _login

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_PACKS_DIR = Path(__file__).resolve().parents[4] / "l10n" / "packs"


@pytest.fixture(autouse=True)
def _import_l10n_packs():
    for code in ("en", "ru"):
        data = json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))
        l10n_services.import_pack(data)


@pytest.fixture
def customer():
    return make_user("f201")


@pytest.fixture
def contractor():
    user = make_user("f202")
    accounts_services.update_profile(user, full_name="Пётр Исполнителев")
    return user


def _place_legacy(recipient, template: str, payload: dict | None = None) -> Notification:
    """Запись «как до ADR-098»: без субъекта, без contract_id, payload без
    меты — place_notification тогда не обогащает (contract_id не вычислить)."""
    return services.place_notification(
        recipient=recipient, template=template, payload=payload or {}, legal_significance=False
    )


def test_legacy_notification_gets_link_counterparty_and_amount_at_read_time(customer, contractor):
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = _place_legacy(customer, "negotiation.sent")
    # Имитация записи, размещённой до ADR-098, но по этому договору: на
    # проде такие несут contract_id в колонке (миграция 0006 бэкфилла нет)
    # либо не несут ничего. Проверяем самый частый вариант — колонка есть,
    # payload пуст.
    Notification.objects.filter(pk=n.pk).update(contract_id=contract.id)
    assert n.payload == {}

    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    # ADR-170: ссылка ведёт в РАЗДЕЛ повода — `negotiation.sent` это переговоры.
    assert item["action"] == {"label": "", "href": f"/contracts/{contract.id}#negoSign"}
    assert item["contract"]["id"] == contract.id
    assert item["contract"]["title"] == contract.title
    assert item["counterparty"]["name"] == "Пётр Исполнителев"
    assert item["amount"] == {"amount": "10000.00", "currency": "RUB"}
    # Текст — полная фраза с названием договора, не короткая тема.
    assert contract.title in item["title"]
    assert "{" not in item["title"]
    # payload не тронут — content_hash неприкосновенен.
    n.refresh_from_db()
    assert n.payload == {}


def test_legacy_payload_only_contract_id_resolves(customer, contractor):
    """Прямой шаблон с contract_id только в payload (signature_requested до
    фикса #143): колонка пуста — ссылка всё равно есть."""
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = _place_legacy(contractor, "signature_requested", {"contract_id": str(contract.id)})
    Notification.objects.filter(pk=n.pk).update(contract_id=None)
    feed = selectors.feed_for_recipient(contractor, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert item["action"]["href"] == f"/contracts/{contract.id}#negoSign"
    # Контрагент относительно ПОЛУЧАТЕЛЯ (исполнитель → заказчик без имени).
    assert "counterparty" not in item


def test_legacy_milestone_payload_resolves_contract_and_title(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = _place_legacy(
        customer, "milestone_submitted_for_acceptance", {"milestone_id": str(milestone.id)}
    )
    Notification.objects.filter(pk=n.pk).update(contract_id=None)
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    # ADR-170: этап известен из payload — якорь на сам этап, а не на «Этапы».
    assert item["action"]["href"] == f"/contracts/{contract.id}#milestone-{milestone.id}"
    assert milestone.title in item["title"]


def test_live_amount_wins_over_stale_payload(customer, contractor):
    """Сумма в payload — снимок на момент события; лента показывает
    текущую сумму договора (payload — фолбэк только для удалённого договора)."""
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="contract.signed",
        payload={"amount": "1.00", "currency": "RUB"},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    # setdefault: явно переданное издателем значение не перетирается — это
    # контракт ADR-098 для payload; в ЛЕНТЕ же приоритет у живого договора.
    assert item["amount"] == {"amount": "10000.00", "currency": "RUB"}


def test_deleted_contract_falls_back_to_payload(customer, contractor):
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="negotiation.sent",
        payload={},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    assert n.payload["contract_title"]
    contract.delete()
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert item["contract"]["title"] == n.payload["contract_title"]
    assert "{" not in item["title"]


def test_api_returns_amount_and_counterparty(customer, contractor):
    """Сквозь сериализатор: `amount` раньше молча выкидывался."""
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = _place_legacy(customer, "negotiation.sent")
    Notification.objects.filter(pk=n.pk).update(contract_id=contract.id)
    client = APIClient()
    _login(client, customer.phone)
    resp = client.get("/v1/notifications")
    assert resp.status_code == 200, resp.content
    item = next(i for i in resp.data["items"] if str(i["id"]) == str(n.id))
    assert item["amount"] == {"amount": "10000.00", "currency": "RUB"}
    assert item["counterparty"]["name"] == "Пётр Исполнителев"
    assert item["action"]["href"] == f"/contracts/{contract.id}#negoSign"
