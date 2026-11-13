"""ADR-156 — правки материалов этапа в согласовании уведомляют вторую сторону.

ADR-155 разрешил править материалы прямо в `under_review` (без раунда правок),
но событий `milestone.material_added/updated/removed` не было ни в одном
реестре уведомлений: контрагент узнавал о правке, только открыв договор
(замечание владельца 03.09 — «наверное, надо уведомлять»).

Каждый случай — отдельным тестом (CLAUDE.md): кому приходит, кому НЕ приходит,
что схлопывается, что уже не схлопывается, и что повторная доставка события
ничего не удваивает."""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from django.conf import settings
from django.test import override_settings
from django.utils import timezone

from apps.contracts.models import Contract
from apps.l10n import services as l10n_services
from apps.milestones import selectors as milestones_selectors
from apps.milestones import services as milestones_services
from apps.milestones.models import ContractMaterial
from apps.notifications import selectors as notification_selectors
from apps.notifications import services as notification_services
from apps.notifications import tasks as notification_tasks
from apps.notifications.models import (
    MATERIALS_CHANGED_TEMPLATE,
    Notification,
    PendingMaterialsChange,
)
from common import relay
from common.models import OutboxEvent, TaskHeartbeat

from ...contracts.tests._signing_helpers import add_leaf_milestone
from ...milestones.tests._execution_helpers import make_under_review_contract, make_user

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_SOURCE = ContractMaterial.Source
_PACKS_DIR = Path(settings.BASE_DIR).parent / "l10n" / "packs"


@pytest.fixture
def _l10n_packs():
    """Тексты уведомлений и подписи хроники живут в языковых пакетах, а не в
    БД по умолчанию (`selectors.render_body`) — импортируем ru/en так же, как
    apps/contracts/tests/test_timeline.py."""
    for code in ("en", "ru"):
        l10n_services.import_pack(json.loads((_PACKS_DIR / f"{code}.json").read_text("utf-8")))


def _catalog_item_code() -> str:
    from apps.catalog.models import MaterialCatalogItem

    item = MaterialCatalogItem.objects.filter(is_active=True).first()
    assert item is not None, "фикстуры каталога материалов должны быть засеяны"
    return item.code


def _leaf_under_review(customer, contractor):
    """Договор НА СОГЛАСОВАНИИ с одним листом — та самая зона ADR-155, где
    материалы ещё можно править (`_assert_editable`: draft/under_review)."""
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer)
    milestone = contract.milestones.get()
    relay.deliver_due_events()
    Notification.objects.all().delete()  # шум отправки на согласование — не предмет теста
    PendingMaterialsChange.objects.all().delete()
    return contract, milestone


def _add_material(milestone, *, user) -> ContractMaterial:
    return milestones_services.create_material(
        milestone,
        user=user,
        catalog_item_code=_catalog_item_code(),
        description="Плитка керамическая",
        source=_SOURCE.CUSTOMER,
        unit_price=Decimal("500.00"),
        unit_price_currency="RUB",
        quantity=Decimal("10"),
        unit="м2",
    )


def _flush(*, after: timedelta = timedelta(hours=1)) -> int:
    """Закрыть все окна, как это сделал бы минутный свип спустя `after`."""
    return notification_services.flush_materials_change_digests(now=timezone.now() + after)


def _cards(recipient) -> list[Notification]:
    return list(
        Notification.objects.filter(
            recipient=recipient, template=MATERIALS_CHANGED_TEMPLATE
        ).order_by("created_at")
    )


def test_under_review_change_notifies_the_other_party():
    customer, contractor = make_user("m201"), make_user("m202")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()

    # Само событие карточку ещё НЕ рождает — она рождается закрытием окна.
    assert _cards(contractor) == []
    assert _flush() == 1
    cards = _cards(contractor)
    assert len(cards) == 1
    assert cards[0].payload["added"] == 1
    assert cards[0].payload["milestone_title"] == milestone.title


def test_actor_does_not_notify_himself():
    """Правку внёс заказчик — карточка только у исполнителя (ADR-126: реестр
    актора для этих топиков не заводится вовсе)."""
    customer, contractor = make_user("m203"), make_user("m204")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    _flush()

    assert _cards(customer) == []
    assert len(_cards(contractor)) == 1


def test_draft_changes_are_silent():
    """В `draft` договор второй стороне ещё не показан — уведомлять не о чем
    (ADR-156). Проверяем и отсутствие карточки, и отсутствие самой строки
    ожидания: молчим ДО окна, а не после."""
    customer, contractor = make_user("m205"), make_user("m206")
    contract = make_under_review_contract(customer=customer, contractor=contractor)
    add_leaf_milestone(contract, user=customer)
    milestone = contract.milestones.get()
    # Возврат в черновик — единственный способ получить редактируемый draft с
    # уже заведённым этапом (FSM: under_review -> draft отдельным переходом
    # нет, поле правим напрямую — предмет теста не FSM согласования).
    contract.negotiation_status = Contract.NegotiationStatus.DRAFT
    contract.save(update_fields=["negotiation_status"])
    Notification.objects.all().delete()
    PendingMaterialsChange.objects.all().delete()

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    _flush()

    assert PendingMaterialsChange.objects.count() == 0
    assert _cards(contractor) == []


def test_batch_of_changes_collapses_into_one_card_with_counters():
    """Три правки в одном окне — ОДНА карточка со счётчиками 1/1/1."""
    customer, contractor = make_user("m207"), make_user("m208")
    _contract, milestone = _leaf_under_review(customer, contractor)

    kept = _add_material(milestone, user=customer)
    doomed = _add_material(milestone, user=customer)
    milestones_services.patch_material(kept, user=customer, quantity=Decimal("12"))
    milestones_services.delete_material(doomed, user=customer)
    relay.deliver_due_events()

    assert _flush() == 1
    cards = _cards(contractor)
    assert len(cards) == 1
    payload = cards[0].payload
    assert (payload["added"], payload["updated"], payload["removed"]) == (2, 1, 1)


def test_window_does_not_slide_with_every_new_change():
    """Вторая правка подсаживается в ОТКРЫТОЕ окно с тем же `notify_at` —
    иначе непрерывно правящая сторона откладывала бы уведомление бесконечно."""
    customer, contractor = make_user("m209"), make_user("m210")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    _add_material(milestone, user=customer)
    relay.deliver_due_events()

    notify_ats = set(PendingMaterialsChange.objects.values_list("notify_at", flat=True))
    assert len(notify_ats) == 1


def test_change_after_the_window_starts_a_new_card():
    customer, contractor = make_user("m211"), make_user("m212")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    assert _flush() == 1

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    assert _flush(after=timedelta(hours=2)) == 1

    cards = _cards(contractor)
    assert len(cards) == 2
    assert [c.payload["added"] for c in cards] == [1, 1]


def test_redelivered_event_does_not_duplicate_the_change():
    """ADR-064 at-least-once: реле может отдать одно и то же событие второй
    раз (упал другой подписчик того же топика) — счётчик не должен вырасти."""
    customer, contractor = make_user("m213"), make_user("m214")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    event = OutboxEvent.objects.filter(topic="milestone.material_added").get()

    from apps.notifications import subscriber

    subscriber.handle_event(event)
    subscriber.handle_event(event)

    assert PendingMaterialsChange.objects.filter(recipient=contractor).count() == 1
    assert _flush() == 1
    assert _cards(contractor)[0].payload["added"] == 1


def test_second_flush_of_the_same_window_places_nothing():
    """Идемпотентность самого свипа: закрытое окно повторно не отправляется."""
    customer, contractor = make_user("m215"), make_user("m216")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()

    assert _flush() == 1
    assert _flush() == 0
    assert len(_cards(contractor)) == 1


@override_settings(NOTIFICATIONS_MATERIALS_CHANGE_DEBOUNCE_MINUTES=10)
def test_window_width_comes_from_settings():
    customer, contractor = make_user("m217"), make_user("m218")
    _contract, milestone = _leaf_under_review(customer, contractor)

    before = timezone.now()
    _add_material(milestone, user=customer)
    relay.deliver_due_events()

    row = PendingMaterialsChange.objects.get(recipient=contractor)
    assert row.notify_at >= before + timedelta(minutes=10)
    # Свип «сейчас» окно не закрывает — оно ещё не созрело.
    assert notification_services.flush_materials_change_digests() == 0


def test_sweep_task_places_cards_and_beats_heartbeat():
    """Свип — точка входа Celery beat: он и размещает карточки, и отбивает
    heartbeat на КАЖДОМ прогоне (иначе «нет правок» и «beat остановлен»
    неотличимы, fundament-2.md ЭФ.6)."""
    customer, contractor = make_user("m219"), make_user("m220")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    PendingMaterialsChange.objects.update(notify_at=timezone.now() - timedelta(minutes=1))

    assert notification_tasks.sweep_materials_change_digests() == 1
    assert TaskHeartbeat.objects.filter(name="notifications_materials_change_sweep").exists()
    assert len(_cards(contractor)) == 1


def test_card_lands_in_deals_feed_group_and_links_to_the_milestone():
    """Лента: вкладка «Сделки» (правка — факт переговоров) и ссылка на
    карточку договора с якорем изменившегося этапа (ADR-156)."""
    customer, contractor = make_user("m221"), make_user("m222")
    contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    _flush()

    assert notification_selectors.channel_group_for_template(MATERIALS_CHANGED_TEMPLATE) == "deals"
    feed = notification_selectors.feed_for_recipient(contractor, filter_key="all", locale="ru")
    item = next(i for i in feed["items"] if i["type"] == "negotiation" and "action" in i)
    assert item["action"]["href"] == f"/contracts/{contract.id}#milestone-{milestone.id}"


@pytest.mark.usefixtures("_l10n_packs")
def test_card_text_is_rendered_with_counters():
    """Текст берётся из языкового пакета (`notifications.contract.
    materials_changed`) и подставляет счётчики — буквальных `{added}` в
    ленте быть не должно."""
    customer, contractor = make_user("m223"), make_user("m224")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    relay.deliver_due_events()
    _flush()

    card = _cards(contractor)[0]
    body = notification_selectors.render_body(MATERIALS_CHANGED_TEMPLATE, locale="ru")
    rendered = notification_selectors.substitute_placeholders(body, card.payload)
    assert milestone.title in rendered
    assert "{added}" not in rendered
    assert "…" not in rendered


def test_changes_by_both_parties_are_separate_cards():
    """Окно ключуется актором: правки заказчика и исполнителя — разные факты
    для читателя и не должны схлопываться в одну карточку."""
    customer, contractor = make_user("m225"), make_user("m226")
    _contract, milestone = _leaf_under_review(customer, contractor)

    _add_material(milestone, user=customer)
    _add_material(milestone, user=contractor)
    relay.deliver_due_events()

    assert _flush() == 2
    assert len(_cards(customer)) == 1
    assert len(_cards(contractor)) == 1


def test_material_events_are_not_wired_into_topic_registries():
    """Страховка от регресса: если топики материалов когда-нибудь попадут в
    реестр топик->шаблон, каждая правка снова начнёт рождать свою карточку —
    ровно то, против чего написан ADR-156."""
    from django.conf import settings as django_settings

    for topic in (
        "milestone.material_added",
        "milestone.material_updated",
        "milestone.material_removed",
    ):
        assert topic not in django_settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES, topic
        assert topic not in django_settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES, topic


@pytest.mark.usefixtures("_l10n_packs")
def test_material_events_carry_milestone_title_for_the_timeline():
    """Хроника этапа (`GET /milestones/{id}/timeline`) строится из outbox —
    подпись `ui.timeline.milestone.material_*.detail` подставляет
    `{milestone_title}` прямо из payload события (ADR-156)."""
    customer, contractor = make_user("m227"), make_user("m228")
    _contract, milestone = _leaf_under_review(customer, contractor)
    material = _add_material(milestone, user=customer)
    milestones_services.patch_material(material, user=customer, quantity=Decimal("11"))
    milestones_services.delete_material(material, user=customer)

    topics = {
        "milestone.material_added",
        "milestone.material_updated",
        "milestone.material_removed",
    }
    rows = OutboxEvent.objects.filter(topic__in=topics)
    assert {r.topic for r in rows} == topics
    assert all(r.payload["milestone_title"] == milestone.title for r in rows)

    entries = {e.kind: e for e in milestones_selectors.get_timeline(milestone, locale="ru")}
    for topic in topics:
        entry = entries[topic]
        # Человекочитаемая строка, а не «сырой» код события, и подпись с
        # названием этапа — то, чего у правок материалов не было до ADR-156.
        assert entry.title, topic
        assert entry.detail == f"«{milestone.title}»", topic
