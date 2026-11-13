"""Курсорная пагинация ленты ЛК (решение владельца 05.09: «пусть штук 15
висят, далее кнопка "показать ещё"»).

Курсор keyset по (created_at, id), а не offset — лента растёт сверху, и
проверка «новое уведомление между запросами не ломает страницу» здесь
главная: именно на ней offset и ломался бы."""

from __future__ import annotations

import base64

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.notifications import selectors, services
from apps.notifications.models import Notification

from .test_api import _login

pytestmark = pytest.mark.django_db


def _me(client: APIClient, phone: str) -> User:
    _login(client, phone)
    return User.objects.get(phone=phone)


def _place_many(user: User, count: int, template: str = "negotiation.sent") -> list[str]:
    """Возвращает id в ПОРЯДКЕ ЛЕНТЫ (новые сверху)."""
    for _ in range(count):
        services.place_notification(
            recipient=user, template=template, payload={}, legal_significance=False
        )
    return [str(n.id) for n in selectors.list_for_recipient(user)]


def _drain(client: APIClient, **query: object) -> tuple[list[str], int]:
    """Все страницы подряд по next_cursor → (id по порядку, число запросов)."""
    collected: list[str] = []
    cursor: str | None = None
    requests = 0
    while True:
        params = dict(query)
        if cursor:
            params["cursor"] = cursor
        resp = client.get("/v1/notifications", params)
        assert resp.status_code == 200, resp.content
        requests += 1
        collected.extend(i["id"] for i in resp.data["items"])
        cursor = resp.data["next_cursor"]
        if not cursor:
            return collected, requests
        assert requests < 20, "курсор не сходится"


def test_default_page_is_15_and_offers_next_cursor():
    client = APIClient()
    me = _me(client, "+79990901001")
    expected = _place_many(me, 18)

    resp = client.get("/v1/notifications")
    assert selectors.FEED_PAGE_SIZE == 15
    assert [i["id"] for i in resp.data["items"]] == expected[:15]
    assert resp.data["total"] == 18
    assert resp.data["next_cursor"]


def test_cursor_walks_the_whole_feed_without_gaps_or_duplicates():
    client = APIClient()
    me = _me(client, "+79990901002")
    expected = _place_many(me, 37)

    collected, requests = _drain(client)
    assert collected == expected
    assert len(set(collected)) == 37
    assert requests == 3  # 15 + 15 + 7


def test_last_page_has_no_next_cursor():
    client = APIClient()
    me = _me(client, "+79990901003")
    _place_many(me, 15)

    resp = client.get("/v1/notifications")
    assert len(resp.data["items"]) == 15
    assert resp.data["next_cursor"] is None


def test_new_notification_between_pages_does_not_shift_the_page():
    """Главный довод против offset: с ним второй запрос вернул бы уже
    показанный пункт (лента сдвинулась на один вниз)."""
    client = APIClient()
    me = _me(client, "+79990901004")
    _place_many(me, 20)

    first = client.get("/v1/notifications", {"limit": 10})
    first_ids = [i["id"] for i in first.data["items"]]

    fresh = services.place_notification(
        recipient=me, template="negotiation.sent", payload={}, legal_significance=False
    )

    second = client.get("/v1/notifications", {"limit": 10, "cursor": first.data["next_cursor"]})
    second_ids = [i["id"] for i in second.data["items"]]

    assert str(fresh.id) not in first_ids + second_ids
    assert not set(first_ids) & set(second_ids)
    assert first_ids + second_ids == [
        str(n.id) for n in selectors.list_for_recipient(me).exclude(pk=fresh.pk)
    ]
    # total пересчитан по свежей ленте — «Показать ещё» на фронте не соврёт.
    assert second.data["total"] == 21


def test_filter_and_cursor_together():
    client = APIClient()
    me = _me(client, "+79990901005")
    _place_many(me, 6, template="dispute.opened")
    _place_many(me, 6, template="negotiation.sent")
    disputes = [
        str(n.id) for n in selectors.list_for_recipient(me).filter(template="dispute.opened")
    ]

    collected, requests = _drain(client, filter="disputes", limit=2)
    assert collected == disputes
    assert requests == 3

    page = client.get("/v1/notifications", {"filter": "disputes", "limit": 2})
    assert page.data["total"] == 6
    assert {i["type"] for i in page.data["items"]} == {"dispute"}


def test_unread_filter_paginates_and_keeps_tab_counters_over_whole_feed():
    client = APIClient()
    me = _me(client, "+79990901006")
    _place_many(me, 5, template="dispute.opened")
    read_one = services.place_notification(
        recipient=me, template="negotiation.sent", payload={}, legal_significance=False
    )
    services.mark_read(read_one, user=me)

    resp = client.get("/v1/notifications", {"filter": "unread", "limit": 1})
    assert len(resp.data["items"]) == 1
    # Счётчики вкладок — по ВСЕЙ ленте, не по странице и не по фильтру.
    assert resp.data["unread_count"] == 5
    assert resp.data["groups"] == {
        "deals": 0,
        "chats": 0,
        "payments": 0,
        "deadlines": 0,
        "disputes": 5,
    }
    # total — по ОТФИЛЬТРОВАННОЙ ленте (из него фронт берёт «Показать ещё N»).
    assert resp.data["total"] == 5


def test_counters_are_aggregates_not_page_projection():
    """limit=1 — счётчики те же, что и на полной странице: считает БД
    агрегатами, а не построенные пункты."""
    client = APIClient()
    me = _me(client, "+79990901007")
    _place_many(me, 4, template="payment.created")
    _place_many(me, 3, template="milestone_acceptance_reminder")

    full = client.get("/v1/notifications", {"limit": 50})
    page = client.get("/v1/notifications", {"limit": 1})
    expected_groups = {"deals": 0, "chats": 0, "payments": 4, "deadlines": 3, "disputes": 0}
    assert full.data["groups"] == expected_groups
    assert page.data["groups"] == expected_groups
    assert page.data["unread_count"] == full.data["unread_count"] == 7


def test_unknown_template_counts_into_default_group():
    """Неизвестный шаблон падает в «Сделки» и в проекции пункта, и в
    SQL-счётчике вкладки — иначе бейдж вкладки разошёлся бы со списком."""
    client = APIClient()
    me = _me(client, "+79990901008")
    services.place_notification(
        recipient=me, template="totally.unknown", payload={}, legal_significance=False
    )

    resp = client.get("/v1/notifications", {"filter": "deals"})
    assert resp.data["groups"]["deals"] == 1
    assert resp.data["total"] == 1
    assert [i["type"] for i in resp.data["items"]] == ["negotiation"]


def test_invalid_cursor_is_400():
    """Один вход на все варианты: parametrize здесь упёрся бы в rate-limit OTP."""
    client = APIClient()
    me = _me(client, "+79990901009")
    _place_many(me, 2)

    broken = [
        "not-base64!!",  # не base64
        "YWJj",  # base64, но не пара «время|id»
        "   ",  # пустой мусор
        "MjAyNi0wOS0wNXwtLQ",  # «2026-09-05|--» — id не UUID
        base64.urlsafe_b64encode(b"2026-09-05T10:00:00|" + b"0" * 32).decode(),  # время без tz
    ]
    for cursor in broken:
        resp = client.get("/v1/notifications", {"cursor": cursor})
        assert resp.status_code == 400, (cursor, resp.content)


def test_empty_cursor_is_the_first_page():
    """Пустая строка — «курсора нет», а не сломанный курсор."""
    client = APIClient()
    me = _me(client, "+79990901015")
    expected = _place_many(me, 2)

    resp = client.get("/v1/notifications", {"cursor": ""})
    assert resp.status_code == 200
    assert [i["id"] for i in resp.data["items"]] == expected


def test_limit_boundaries():
    client = APIClient()
    me = _me(client, "+79990901010")
    _place_many(me, 3)

    assert client.get("/v1/notifications", {"limit": 50}).status_code == 200
    assert client.get("/v1/notifications", {"limit": 1}).status_code == 200
    assert client.get("/v1/notifications", {"limit": 51}).status_code == 400
    assert client.get("/v1/notifications", {"limit": 0}).status_code == 400
    assert client.get("/v1/notifications", {"limit": -1}).status_code == 400
    assert client.get("/v1/notifications", {"limit": "много"}).status_code == 400


def test_limit_50_returns_up_to_50():
    client = APIClient()
    me = _me(client, "+79990901011")
    _place_many(me, 55)

    resp = client.get("/v1/notifications", {"limit": selectors.FEED_PAGE_SIZE_MAX})
    assert len(resp.data["items"]) == 50
    assert resp.data["total"] == 55
    assert resp.data["next_cursor"]


def test_read_and_read_all_return_first_page_with_same_query():
    client = APIClient()
    me = _me(client, "+79990901012")
    ordered = _place_many(me, 20)

    read = client.post(f"/v1/notifications/{ordered[0]}/read?limit=5")
    assert read.status_code == 200, read.content
    assert [i["id"] for i in read.data["items"]] == ordered[:5]
    assert read.data["unread_count"] == 19
    assert read.data["total"] == 20
    assert read.data["next_cursor"]

    read_all = client.post("/v1/notifications/read-all?limit=5")
    assert [i["id"] for i in read_all.data["items"]] == ordered[:5]
    assert read_all.data["unread_count"] == 0
    assert Notification.objects.filter(recipient=me, read_at__isnull=True).count() == 0


def test_feed_is_scoped_to_recipient():
    """Курсор чужой ленты не вытаскивает чужие пункты — фильтр по получателю
    стоит до keyset."""
    client = APIClient()
    me = _me(client, "+79990901013")
    _place_many(me, 3)
    other_client = APIClient()
    other = _me(other_client, "+79990901014")
    _place_many(other, 3)

    mine = client.get("/v1/notifications", {"limit": 1})
    stolen = other_client.get("/v1/notifications", {"cursor": mine.data["next_cursor"]})
    assert stolen.status_code == 200
    assert {i["id"] for i in stolen.data["items"]} <= {
        str(n.id) for n in selectors.list_for_recipient(other)
    }
