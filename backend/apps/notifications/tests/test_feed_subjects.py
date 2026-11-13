"""ADR-098 (отсмотр прода 2026-08-19): субъект уведомления + обогащение
payload. До этого лента была некликабельна (сериализатор не отдавал action/
contract/counterparty), а заголовки печатали буквальный `{contract_title}` —
события контрактного контура публикуются с пустым payload."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.accounts import services as accounts_services
from apps.l10n import services as l10n_services
from apps.notifications import selectors, services
from apps.notifications.models import Notification
from apps.profiles.models import Profile
from common import relay

from ...contracts.tests._signing_helpers import make_under_review_contract, make_user
from ...milestones.tests._execution_helpers import make_signed_contract_with_leaf

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_PACKS_DIR = Path(__file__).resolve().parents[4] / "l10n" / "packs"


@pytest.fixture(autouse=True)
def _import_l10n_packs():
    """Тексты шаблонов — из файловых пакетов ru/en (как test_wiring_e2e):
    иначе в тестовой БД пакетов нет и render_body падает на body_i18n."""
    for code in ("en", "ru"):
        data = json.loads((_PACKS_DIR / f"{code}.json").read_text(encoding="utf-8"))
        l10n_services.import_pack(data)


@pytest.fixture
def customer():
    return make_user("f101")


@pytest.fixture
def contractor():
    return make_user("f102")


def _latest(recipient, template: str) -> Notification:
    return Notification.objects.filter(recipient=recipient, template=template).latest("created_at")


def test_place_persists_subject_and_enriches_payload(customer, contractor):
    # send_for_review — актор customer; ADR-178: самому себе «отправлено на
    # согласование» больше не приходит, карточку получает контрагент
    # (negotiation.sent.counterparty).
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    n = _latest(contractor, "negotiation.sent.counterparty")
    assert n.subject_type == "contract"
    assert n.subject_id == contract.id
    assert n.contract_id == contract.id
    expected_number = str(contract.id).replace("-", "")[-6:].upper()
    assert n.payload["contract_number"] == expected_number
    assert n.payload["contract_title"] == contract.title  # title непустой в helper'е
    # Контрагент — ОТНОСИТЕЛЬНО получателя: получатель contractor, значит
    # профиль заказчика.
    customer_profile_ids = {str(p.id) for p in customer.profiles.all()}
    assert n.payload["counterparty_profile_id"] in customer_profile_ids
    # Имени у тестового пользователя нет (full_name_encrypted пуст) —
    # counterparty_name честно отсутствует, не пустая строка.
    assert "counterparty_name" not in n.payload


def test_milestone_subject_carries_contract_id(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="milestone.started",
        payload={},
        legal_significance=False,
        subject_type="milestone",
        subject_id=str(milestone.id),
        subject_contract_id=str(contract.id),
    )
    assert n.subject_type == "milestone"
    assert n.subject_id == milestone.id
    assert n.contract_id == contract.id
    assert n.payload["contract_number"]


def test_feed_item_exposes_action_contract_and_skips_empty(customer, contractor):
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    with_contract = [item for item in feed["items"] if "contract" in item]
    assert with_contract, "ни один пункт ленты не получил contract-ссылку"
    item = with_contract[0]
    # ADR-170: у пункта переговоров ссылка с якорем раздела.
    assert item["action"] == {"label": "", "href": f"/contracts/{contract.id}#negoSign"}
    assert item["contract"]["id"] == contract.id
    assert item["contract"]["number"] == str(contract.id).replace("-", "")[-6:].upper()
    # counterparty без имени не отдаётся вовсе (пустое поле фронт не рисует,
    # DEV-14 §3) — а не приходит с пустым name.
    assert "counterparty" not in item


def test_feed_counterparty_carries_live_avatar(customer, contractor):
    """ADR-173: фото контрагента в ленте — ЖИВОЕ, не из снимка события
    (ссылка версионируется и подписывается, ADR-103), и одной пачкой на
    страницу: профилей в ленте столько же, сколько разных контрагентов.

    Получатель — CONTRACTOR: ADR-178 убрал самоуведомления актора, а всю
    подготовку и первую подпись в `make_signed_contract_with_leaf` делает
    customer — контрагенту (contractor) достаётся несколько карточек ОДНОГО
    договора (`negotiation.sent.counterparty`, `negotiation.frozen`,
    `negotiation.signed.counterparty`), нужных именно для проверки пачки."""
    accounts_services.update_profile(customer, full_name="Анна Заказчикова")
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()
    profile = Profile.objects.filter(owner_user=customer, kind=Profile.Kind.PERSON).get()
    profile.avatar_key = "avatars/cus/0198cc00"
    profile.avatar_visibility = Profile.AvatarVisibility.PUBLIC
    profile.save(update_fields=["avatar_key", "avatar_visibility"])

    request = SimpleNamespace(user=contractor, acting_profile_id=None)
    with CaptureQueriesContext(connection) as queries:
        feed = selectors.feed_for_recipient(
            contractor, filter_key="all", locale="ru", request=request
        )
    with_counterparty = [item for item in feed["items"] if "counterparty" in item]
    assert with_counterparty, "ни один пункт ленты не получил контрагента"
    assert len(with_counterparty) > 1, "нужна лента из нескольких пунктов одного договора"
    for item in with_counterparty:
        assert str(profile.id) in item["counterparty"]["avatar_url"]
    batch_sql = 'FROM "profile" WHERE "profile"."id" IN'
    batched = [q for q in queries.captured_queries if batch_sql in q["sql"]]
    assert len(batched) == 1


def test_feed_counterparty_without_photo_has_null_avatar(customer, contractor):
    accounts_services.update_profile(contractor, full_name="Пётр Подрядов")
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    with_counterparty = [item for item in feed["items"] if "counterparty" in item]
    assert with_counterparty
    assert all(item["counterparty"]["avatar_url"] is None for item in with_counterparty)


def test_feed_item_without_contract_has_no_action(customer):
    services.place_notification(
        recipient=customer, template="entity_claimed", payload={}, legal_significance=False
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = feed["items"][0]
    assert "action" not in item
    assert "contract" not in item
    assert "counterparty" not in item


def test_feed_item_group_subject_links_to_group_card(customer):
    """Групповое событие — договора нет, но пункт обязан вести к месту события:
    карточке объединения (замечание тестеров 27.08 — клик никуда не вёл)."""
    group_id = uuid4()
    services.place_notification(
        recipient=customer,
        template="group.join_requested",
        payload={"group_name": "Мастера"},
        legal_significance=False,
        subject_type="group",
        subject_id=str(group_id),
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = feed["items"][0]
    assert item["action"] == {"label": "", "href": f"/groups/{group_id}"}
    assert "contract" not in item


def test_feed_title_has_no_literal_placeholder(customer, contractor):
    """Прод-баг: «Договор «{contract_title}» отправлен…» буквально — payload
    контрактных событий пуст, обогащение ADR-098 обязано его закрыть."""
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    assert feed["items"]
    for item in feed["items"]:
        assert "{contract_title}" not in item["title"], item["title"]


def test_blank_contract_title_falls_back_to_number(customer, contractor):
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    contract.title = ""
    contract.save(update_fields=["title"])
    n = services.place_notification(
        recipient=customer,
        template="contract.signed",
        payload={},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    number = str(contract.id).replace("-", "")[-6:].upper()
    assert n.payload["contract_title"] == f"№ {number}"


def test_publisher_payload_not_overwritten(customer, contractor):
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="contract.signed",
        payload={"contract_title": "Явное имя от издателя"},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    assert n.payload["contract_title"] == "Явное имя от издателя"  # setdefault, не перетирание


# --- отсмотр прода 2026-08-20: сумма в ленте, «прямые» шаблоны, старые записи ---


def test_payload_and_feed_carry_amount_pair(customer, contractor):
    """Сумма — «сумма листьев = сумма договора» (tech-spec §6.1): в payload
    строкой + валюта, в ленте — парой `amount: {amount, currency}`."""
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="contract.signed",
        payload={},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    assert n.payload["amount"] == "10000.00"
    assert n.payload["currency"] == "RUB"
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert item["amount"] == {"amount": "10000.00", "currency": "RUB"}


def test_draft_without_milestones_has_no_amount(customer, contractor):
    """Черновик без этапов: суммы нет — ключей нет (ни пустой строки, ни
    валюты по умолчанию), пункт ленты без `amount`."""
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="negotiation.sent",
        payload={},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    assert "amount" not in n.payload
    assert "currency" not in n.payload
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert "amount" not in item


def test_signature_requested_resolves_contract_from_payload(customer, contractor):
    """«Подпишите договор» — прямой шаблон без subject, contract_id только в
    payload: раньше оставался некликабельным и с сырым текстом."""
    contract, _ = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=contractor,
        template="signature_requested",
        payload={"contract_id": str(contract.id), "side": "contractor"},
        legal_significance=True,
    )
    assert n.contract_id == contract.id
    assert n.payload["contract_title"] == contract.title
    feed = selectors.feed_for_recipient(contractor, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert item["action"]["href"] == f"/contracts/{contract.id}#negoSign"
    assert contract.title in item["title"]
    assert "{" not in item["title"]


def test_milestone_direct_template_resolves_contract_and_title(customer, contractor):
    """milestone_submitted_for_acceptance: subject=milestone без contract_id,
    в payload — только milestone_id. Договор и название этапа — из этапа."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=customer,
        template="milestone_submitted_for_acceptance",
        payload={"milestone_id": str(milestone.id), "comment": ""},
        legal_significance=True,
        subject_type="milestone",
        subject_id=str(milestone.id),
    )
    assert n.contract_id == contract.id
    assert n.payload["milestone_title"] == milestone.title
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert milestone.title in item["title"]


def test_material_notice_without_subject_resolves_via_payload_milestone_id(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    n = services.place_notification(
        recipient=contractor,
        template="milestone_material_notice",
        payload={
            "material_id": "00000000-0000-0000-0000-000000000000",
            "reason": "нет",
            "milestone_id": str(milestone.id),
        },
        legal_significance=True,
    )
    assert n.contract_id == contract.id


def test_legacy_notification_with_unresolved_placeholder_shows_subject(customer):
    """Записи до ADR-098 (payload пуст, contract_id нет) — в ленте короткая
    тема «Договор подписан», а не «Договор «{contract_title}» подписан…»."""
    n = Notification.objects.create(
        recipient=customer, template="contract.signed", payload={}, legal_significance=False
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)
    assert item["title"] == "Договор подписан"
    assert "action" not in item


def test_every_pack_text_renders_from_enriched_payload(customer, contractor):
    """Все шаблоны ru/en: плейсхолдеры текстов закрываются обогащением
    (contract_title/milestone_title/…) — ни одного «{…}» в ленте."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    from apps.l10n import selectors as l10n_selectors

    for locale in ("ru", "en"):
        codes = [
            "negotiation.sent",
            "negotiation.revised",
            "negotiation.frozen",
            "negotiation.signed",
            "contract.signed",
            "contract.completed",
            "dispute.opened",
            "entity_claimed",
            "signature_requested",
        ]
        milestone_codes = [
            "milestone.started",
            "milestone.accepted",
            "milestone.auto_accepted",
            "milestone.rejected",
            "dispute.resolved",
            "evidence_received",
            "milestone_submitted_for_acceptance",
            "milestone_material_notice",
        ]
        for code in codes:
            assert l10n_selectors.get_notification_text(code, locale=locale), code
            services.place_notification(
                recipient=customer,
                template=code,
                payload={},
                legal_significance=False,
                subject_type="contract",
                subject_id=str(contract.id),
            )
        for code in milestone_codes:
            assert l10n_selectors.get_notification_text(code, locale=locale), code
            services.place_notification(
                recipient=customer,
                template=code,
                payload={},
                legal_significance=False,
                subject_type="milestone",
                subject_id=str(milestone.id),
                subject_contract_id=str(contract.id),
            )
        feed = selectors.feed_for_recipient(customer, filter_key="all", locale=locale)
        for item in feed["items"]:
            assert "{" not in item["title"], (locale, item["title"])


# --- ADR-159: код шаблона в пункте ленты ----------------------------------


def test_feed_item_carries_template_code(customer, contractor):
    """`type` склеивает десятки поводов в один (`negotiation`) — адресно
    работать с конкретным по нему нельзя. Код шаблона — тот же, что на
    строке Notification."""
    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    assert feed["items"], "лента пуста — проверять нечего"
    for item in feed["items"]:
        n = Notification.objects.get(pk=item["id"])
        assert item["template_code"] == n.template


def test_materials_changed_is_distinguishable_without_href_sniffing(customer, contractor):
    """Ровно тот случай, ради которого поле заведено: `contract.
    materials_changed` отличался от других `negotiation`-пунктов только
    якорем `#milestone-` в `action.href`."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    services.place_notification(
        recipient=customer,
        template="contract.materials_changed",
        payload={"milestone_id": str(milestone.id), "changes_count": 2},
        legal_significance=False,
        subject_type="contract",
        subject_id=str(contract.id),
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")

    changed = [i for i in feed["items"] if i["template_code"] == "contract.materials_changed"]
    assert len(changed) == 1
    # Тип остался прежним — новое поле не ломает старую проекцию.
    assert changed[0]["type"] == "negotiation"


def test_feed_item_with_unknown_template_still_carries_its_code(customer):
    """Неизвестный проекции шаблон пункт не теряет (лента — юрканал,
    ADR-057): тип падает в дефолтный, а код отдаётся как есть."""
    n = Notification.objects.create(
        recipient=customer, template="something.unmapped", payload={}, legal_significance=False
    )
    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["id"] == n.id)

    assert item["template_code"] == "something.unmapped"
    assert item["type"] == "negotiation"


def test_feed_serializer_keeps_template_code(customer, contractor):
    """Сериализатор ленты выкидывает поля, которых не знает (прод-баг с
    `amount`, 2026-08-20) — код шаблона обязан пережить сериализацию."""
    from apps.notifications.api.serializers import NotificationFeedSerializer

    make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    relay.deliver_due_events()

    feed = selectors.feed_for_recipient(customer, filter_key="all", locale="ru")
    data = NotificationFeedSerializer(feed).data
    assert data["items"]
    for serialized, item in zip(data["items"], feed["items"], strict=True):
        assert serialized["template_code"] == item["template_code"]
