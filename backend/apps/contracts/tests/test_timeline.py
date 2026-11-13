"""Хроника договора (ADR-134): реестр topic'ов apps.contracts, производный
`kind`, фильтр чата, свёрнутые ключевые события дочерних сущностей
(`nested`), `subject` со ссылкой, порядок по времени."""

from __future__ import annotations

import ast
import json
import re
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from django.conf import settings
from django.utils import timezone

from apps.accounts.models import User
from apps.contracts import events
from apps.contracts.models import Amendment, Contract
from apps.l10n import services as l10n_services
from common import outbox
from common.models import OutboxEvent

from .test_negotiation_api import _two_sided_setup

pytestmark = pytest.mark.django_db

_SERVICES_PATH = Path(__file__).resolve().parents[1] / "services.py"


# --- реестр topic'ов ----------------------------------------------------------


def _published_topics_in_services() -> list[ast.expr]:
    """Первый аргумент каждого вызова `*.publish(...)` в services.py —
    по исходнику (AST), а не перехватом в рантайме: перехват покрыл бы
    только те сайты, до которых дошли тесты."""
    tree = ast.parse(_SERVICES_PATH.read_text(encoding="utf-8"))
    return [
        node.args[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "publish"
        and node.args
    ]


def test_every_published_topic_is_in_registry():
    args = _published_topics_in_services()
    assert len(args) >= 35, "сайтов публикации в services.py стало меньше — реестр устарел?"
    registry = {t.value for t in events.Topic}
    for arg in args:
        if isinstance(arg, ast.Constant):
            assert arg.value in registry, f"topic {arg.value!r} не в events.Topic"
        elif isinstance(arg, ast.Attribute):
            assert isinstance(arg.value, ast.Name) and arg.value.id == "Topic", ast.dump(arg)
            assert hasattr(events.Topic, arg.attr), f"Topic.{arg.attr} нет в реестре"
        else:  # pragma: no cover — новый способ передать topic
            raise AssertionError(f"неожиданный аргумент publish: {ast.dump(arg)}")


def test_registry_values_are_unique_and_dotted():
    values = [t.value for t in events.Topic]
    assert len(values) == len(set(values))
    assert all(v.count(".") == 1 for v in values), values


def test_timeline_kinds_registry_is_complete_and_unique():
    kinds = events.TIMELINE_KINDS
    assert len(kinds) == len(set(kinds))
    # многозначные topic'и представлены только суффиксными kind'ами
    for raw in ("negotiation.revised", "negotiation.reopened", "contract.terminated"):
        assert raw not in kinds
    assert "negotiation.revised.accept_all" in kinds
    assert "deadline.warranty_expired" in kinds
    # чужие вложенные topic'и — kind == topic
    for topic in events.NESTED_TOPICS:
        assert topic in kinds
    # чат — не хроника
    assert events.MESSAGE_CREATED not in kinds


# --- timeline_kind: каждая ветка ----------------------------------------------


@pytest.mark.parametrize(
    ("topic", "payload", "expected"),
    [
        ("negotiation.revised", {"action": "proposed"}, "negotiation.revised.proposed"),
        ("negotiation.revised", {"action": "accepted"}, "negotiation.revised.accepted"),
        (
            "negotiation.revised",
            {"action": "accepted", "via": "accept_all"},
            "negotiation.revised.accept_all",
        ),
        ("negotiation.revised", {"action": "rejected"}, "negotiation.revised.rejected"),
        ("negotiation.revised", {"action": "countered"}, "negotiation.revised.countered"),
        (
            "negotiation.revised",
            {"action": "preapproved_applied"},
            "negotiation.revised.alternative",
        ),
        ("negotiation.revised", {}, "negotiation.revised"),
        ("negotiation.revised", None, "negotiation.revised"),
        ("negotiation.revised", {"action": "unknown"}, "negotiation.revised"),
        (
            "negotiation.reopened",
            {"reason": "returned_for_revision"},
            "negotiation.reopened.returned",
        ),
        (
            "negotiation.reopened",
            {"reason": "declined_for_revision"},
            "negotiation.reopened.declined",
        ),
        ("negotiation.reopened", {}, "negotiation.reopened"),
        ("contract.terminated", {"terminated_by": "customer"}, "contract.terminated.by_customer"),
        (
            "contract.terminated",
            {"terminated_by": "contractor"},
            "contract.terminated.by_contractor",
        ),
        ("contract.terminated", {}, "contract.terminated"),
        ("domain_deadline.fired", {"kind": "contract_warranty"}, "deadline.warranty_expired"),
        (
            "domain_deadline.fired",
            {"kind": "termination_dispute_window"},
            "deadline.termination_window_closed",
        ),
        ("domain_deadline.fired", {"kind": "milestone_acceptance"}, "domain_deadline.fired"),
        ("domain_deadline.fired", {}, "domain_deadline.fired"),
        ("contract.signed", {"integrity_hash": "x"}, "contract.signed"),
        ("milestone.accepted", {"milestone_title": "Этап 1"}, "milestone.accepted"),
        ("amendment.rejected", {"reason": "нет"}, "amendment.rejected"),
    ],
)
def test_timeline_kind(topic: str, payload: dict | None, expected: str):
    assert events.timeline_kind(topic, payload) == expected


def test_every_derived_kind_is_in_registry():
    """Все суффиксные kind'ы, которые может вернуть `timeline_kind`, есть в
    TIMELINE_KINDS — иначе фронт/l10n не узнают о новом ключе."""
    derived = [
        events.timeline_kind("negotiation.revised", {"action": a})
        for a in ("proposed", "accepted", "rejected", "countered", "preapproved_applied")
    ]
    derived.append(
        events.timeline_kind("negotiation.revised", {"action": "accepted", "via": "accept_all"})
    )
    derived += [
        events.timeline_kind("negotiation.reopened", {"reason": r})
        for r in ("returned_for_revision", "declined_for_revision")
    ]
    derived += [
        events.timeline_kind("contract.terminated", {"terminated_by": s})
        for s in ("customer", "contractor")
    ]
    derived += [
        events.timeline_kind("domain_deadline.fired", {"kind": k})
        for k in ("contract_warranty", "termination_dispute_window")
    ]
    missing = [k for k in derived if k not in events.TIMELINE_KINDS]
    assert not missing, missing


# --- API: фильтр чата, вложенные события, порядок ------------------------------


def _shift(event: OutboxEvent, seconds: int) -> None:
    """Раздвинуть события по времени явно — в тесте всё публикуется в одну
    миллисекунду, а проверяется именно порядок по `occurred_at`."""
    event.occurred_at = timezone.now() + timedelta(seconds=seconds)
    event.save(update_fields=["occurred_at"])


def test_chat_messages_are_not_in_timeline():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870901", "+79990870902", "tl-1"
    )
    outbox.publish(
        "message.created",
        subject={"type": "contract", "id": contract_id},
        payload={"message_id": str(uuid4())},
    )
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    topics = [e["topic"] for e in resp.data]
    assert "message.created" not in topics
    assert "contract.drafted" in topics


def test_timeline_item_contract_shape_and_kind():
    customer_client, contractor_client, contract_id = _two_sided_setup(
        "+79990870903", "+79990870904", "tl-2"
    )
    customer_client.post(f"/v1/contracts/{contract_id}/send", format="json")
    resp = customer_client.post(
        f"/v1/contracts/{contract_id}/revisions",
        {"item_ref": "title", "new_value": "Вариант А"},
        format="json",
    )
    proposal_id = resp.data["id"]
    contractor_client.post(f"/v1/revisions/{proposal_id}/accept", format="json")

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    assert [e["kind"] for e in resp.data] == [
        "contract.drafted",
        "negotiation.sent",
        "negotiation.revised.proposed",
        "negotiation.revised.accepted",
    ]
    item = resp.data[2]
    assert set(item) == {
        "event_id",
        "topic",
        "kind",
        "title",
        "detail",
        "nested",
        "occurred_at",
        "actor",
        "subject",
        "payload",
    }
    assert item["topic"] == "negotiation.revised"  # совместимость: topic/payload как были
    assert item["payload"]["action"] == "proposed"
    assert item["nested"] is False
    assert item["subject"] == {"type": "contract", "id": contract_id, "title": None}


def test_nested_child_events_are_collected_in_order():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870905", "+79990870906", "tl-3"
    )
    other_contract_id = str(uuid4())
    milestone_id, dispute_id, amendment_id, payment_id = (str(uuid4()) for _ in range(4))

    # Порядок публикации нарочно НЕ хронологический — проверяем сортировку.
    paid = outbox.publish(
        "payment.paid",
        subject={"type": "payment", "id": payment_id, "contract_id": contract_id},
        payload={
            "contract_id": contract_id,
            "milestone_id": milestone_id,
            "milestone_title": "Штукатурка",
            "amount": "1000.00",
            "currency": "RUB",
        },
    )
    _shift(paid, 40)
    accepted = outbox.publish(
        "milestone.accepted",
        subject={"type": "milestone", "id": milestone_id, "contract_id": contract_id},
        payload={"contract_id": contract_id, "milestone_title": "Штукатурка"},
    )
    _shift(accepted, 20)
    opened = outbox.publish(
        "dispute.opened",
        subject={"type": "dispute", "id": dispute_id, "contract_id": contract_id},
        payload={
            "contract_id": contract_id,
            "dispute_kind": "milestone",
            "milestone_title": "Штукатурка",
        },
    )
    _shift(opened, 10)
    # Допник: subject — сам допник, contract_id только в payload.
    sent = outbox.publish(
        "amendment.sent",
        subject={"type": "amendment", "id": amendment_id},
        payload={"contract_id": contract_id},
    )
    _shift(sent, 30)
    # Шум и чужое — не попадает.
    outbox.publish(
        "milestone.gate_passed",
        subject={"type": "milestone", "id": milestone_id, "contract_id": contract_id},
        payload={"contract_id": contract_id},
    )
    outbox.publish(
        "milestone.accepted",
        subject={"type": "milestone", "id": str(uuid4()), "contract_id": other_contract_id},
        payload={"contract_id": other_contract_id, "milestone_title": "Чужой этап"},
    )
    outbox.publish(
        "amendment.drafted",
        subject={"type": "amendment", "id": amendment_id},
        payload={"contract_id": contract_id, "order": 1},
    )

    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    assert [(e["kind"], e["nested"]) for e in resp.data] == [
        ("contract.drafted", False),
        ("dispute.opened", True),
        ("milestone.accepted", True),
        ("amendment.sent", True),
        ("payment.paid", True),
    ]
    by_kind = {e["kind"]: e for e in resp.data}
    assert by_kind["milestone.accepted"]["subject"] == {
        "type": "milestone",
        "id": milestone_id,
        "title": "Штукатурка",
    }
    assert by_kind["dispute.opened"]["subject"]["id"] == dispute_id
    assert by_kind["amendment.sent"]["subject"] == {
        "type": "amendment",
        "id": amendment_id,
        "title": None,
    }
    assert by_kind["payment.paid"]["subject"]["type"] == "payment"
    assert by_kind["payment.paid"]["payload"]["amount"] == "1000.00"


def test_deadline_fired_kinds_on_contract():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870907", "+79990870908", "tl-4"
    )
    outbox.publish(
        "domain_deadline.fired",
        subject={"type": "contract", "id": contract_id},
        payload={"deadline_id": str(uuid4()), "kind": "contract_warranty", "outcome": "timed_out"},
    )
    outbox.publish(
        "domain_deadline.fired",
        subject={"type": "contract", "id": contract_id},
        payload={
            "deadline_id": str(uuid4()),
            "kind": "termination_dispute_window",
            "outcome": "timed_out",
        },
    )
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    kinds = [e["kind"] for e in resp.data]
    assert kinds[-2:] == ["deadline.warranty_expired", "deadline.termination_window_closed"]
    assert all(e["nested"] is False for e in resp.data)


# --- Подписи из l10n-паков (ADR-134: title/detail отдаёт API) -----------------

_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"
_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def _pack(code: str) -> dict:
    return json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("code", ["ru", "en"])
def test_every_kind_has_title_in_pack(code: str):
    ui = _pack(code)["ui"]
    missing = [k for k in events.TIMELINE_KINDS if not ui.get(events.timeline_title_key(k))]
    assert not missing, f"{code}: нет ui.timeline.* для {missing}"


def test_every_kind_has_title_in_every_pack():
    """Тот же стражник, что `apps/l10n/tests/test_packs_coverage.py` для
    уведомлений: ключ физически есть в КАЖДОМ пакете, иначе 27 языков молча
    живут на en-фолбэке."""
    missing: list[str] = []
    for path in sorted(_PACKS_DIR.glob("*.json")):
        ui = json.loads(path.read_text(encoding="utf-8")).get("ui", {})
        for kind in events.TIMELINE_KINDS:
            if not ui.get(events.timeline_title_key(kind)):
                missing.append(f"{path.stem}:{kind}")
    assert not missing, missing


def test_detail_placeholders_match_en_canon():
    en_ui = _pack("en")["ui"]
    canon = {
        key: sorted(_PLACEHOLDER_RE.findall(value))
        for key, value in en_ui.items()
        if key.startswith(events.TIMELINE_TEXT_PREFIX)
    }
    known = set(events.timeline_detail_vars({}).keys()) | {
        "milestone_title",
        "item",
        "amount",
        "currency",
        "comment",
        "reason",
        "description",
    }
    for key, placeholders in canon.items():
        assert set(placeholders) <= known, (key, placeholders)
    for path in sorted(_PACKS_DIR.glob("*.json")):
        ui = json.loads(path.read_text(encoding="utf-8")).get("ui", {})
        for key, expected in canon.items():
            if key in ui:
                assert sorted(_PLACEHOLDER_RE.findall(ui[key])) == expected, (path.stem, key)


@pytest.mark.parametrize(
    ("template", "payload", "expected"),
    [
        (None, {"milestone_title": "Крыша"}, None),
        ("", {"milestone_title": "Крыша"}, None),
        ("«{milestone_title}»", {"milestone_title": "Крыша"}, "«Крыша»"),
        ("«{milestone_title}»", {"milestone_title": None}, None),
        ("«{milestone_title}»", {"milestone_title": "  "}, None),
        ("«{milestone_title}»", {}, None),
        ("Пункт: {item}", {"item_ref": "form.price"}, "Пункт: form.price"),
        (
            "{amount} {currency} · «{milestone_title}»",
            {"amount": "1000.00", "currency": "RUB", "milestone_title": "Крыша"},
            "1000.00 RUB · «Крыша»",
        ),
        ("Основание: {reason}", {"reason": "срыв сроков"}, "Основание: срыв сроков"),
        ("{unknown_placeholder}", {"reason": "x"}, None),
    ],
)
def test_render_timeline_detail(template: str | None, payload: dict, expected: str | None):
    assert events.render_timeline_detail(template, payload) == expected


@pytest.fixture
def _l10n_packs():
    for code in ("en", "ru"):
        l10n_services.import_pack(_pack(code))


@pytest.mark.usefixtures("_l10n_packs")
def test_timeline_titles_follow_request_locale():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870909", "+79990870910", "tl-5"
    )
    milestone_id = str(uuid4())
    outbox.publish(
        "milestone.accepted",
        subject={"type": "milestone", "id": milestone_id, "contract_id": contract_id},
        payload={"contract_id": contract_id, "milestone_title": "Штукатурка"},
    )
    outbox.publish(
        "payment.paid",
        subject={"type": "payment", "id": str(uuid4()), "contract_id": contract_id},
        payload={
            "contract_id": contract_id,
            "milestone_title": "Штукатурка",
            "amount": "1000.00",
            "currency": "RUB",
        },
    )
    outbox.publish(
        "dispute.opened",
        subject={"type": "dispute", "id": str(uuid4()), "contract_id": contract_id},
        payload={"contract_id": contract_id, "dispute_kind": "warranty", "milestone_title": None},
    )

    # Язык не выбран -> страна по телефону (RU) -> ru.
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    by_kind = {e["kind"]: e for e in resp.data}
    assert by_kind["contract.drafted"]["title"] == "Черновик создан"
    assert by_kind["contract.drafted"]["detail"] is None
    assert by_kind["milestone.accepted"]["title"] == "Этап принят"
    assert by_kind["milestone.accepted"]["detail"] == "«Штукатурка»"
    assert by_kind["payment.paid"]["detail"] == "1000.00 RUB · «Штукатурка»"
    # гарантийный спор без этапа — detail null, не подпись с дыркой
    assert by_kind["dispute.opened"]["title"] == "Открыт спор"
    assert by_kind["dispute.opened"]["detail"] is None

    # Явный выбор языка в переключателе (`User.locale`, ADR-095) сильнее
    # страны и Accept-Language — тот же порядок, что у ошибок и уведомлений.
    User.objects.filter(phone="+79990870909").update(locale="en")
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    by_kind = {e["kind"]: e for e in resp.data}
    assert by_kind["contract.drafted"]["title"] == "Draft created"
    assert by_kind["milestone.accepted"]["detail"] == "“Штукатурка”"


@pytest.mark.usefixtures("_l10n_packs")
def test_unknown_kind_title_is_null():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870911", "+79990870912", "tl-6"
    )
    outbox.publish(
        "domain_deadline.fired",
        subject={"type": "contract", "id": contract_id},
        payload={"deadline_id": str(uuid4()), "kind": "some_future_kind", "outcome": "timed_out"},
    )
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    last = resp.data[-1]
    assert last["kind"] == "domain_deadline.fired"
    assert last["title"] is None
    assert last["detail"] is None


def test_timeline_without_imported_packs_does_not_fail():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870913", "+79990870914", "tl-7"
    )
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    assert resp.status_code == 200, resp.content
    assert resp.data[0]["kind"] == "contract.drafted"
    assert resp.data[0]["title"] is None


@pytest.mark.usefixtures("_l10n_packs")
def test_amendment_timeline_has_same_item_contract():
    customer_client, _contractor_client, contract_id = _two_sided_setup(
        "+79990870915", "+79990870916", "tl-8"
    )
    contract = Contract.objects.get(pk=contract_id)
    amendment = Amendment.objects.create(
        contract=contract, order=1, reason="уточнить срок", created_by=contract.created_by
    )
    outbox.publish(
        "amendment.sent",
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={"contract_id": contract_id},
    )
    resp = customer_client.get(f"/v1/amendments/{amendment.id}/timeline")
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 1
    item = resp.data[0]
    assert item["kind"] == "amendment.sent"
    assert item["title"] == "Допсоглашение отправлено на рассмотрение"
    assert item["detail"] is None
    assert item["nested"] is True
    assert item["subject"] == {"type": "amendment", "id": str(amendment.id), "title": None}

    # и в хронике договора — свёрнуто
    resp = customer_client.get(f"/v1/contracts/{contract_id}/timeline")
    nested = [e for e in resp.data if e["nested"]]
    assert [e["kind"] for e in nested] == ["amendment.sent"]
