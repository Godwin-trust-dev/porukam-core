"""Лента ЛК DEV-14 §7 (отсмотр прода 2026-08-18 №1/№2): {items, unread_count,
groups}, ?filter=, POST /read-all. Контракт зеркалит мок фронта
(web/src/mocks/notificationsDb.ts) — «мок — зеркало бэкенда», в этот раз
бэкенд догоняет мок."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.notifications import selectors, services
from apps.notifications.models import Notification

from .test_api import _login

pytestmark = pytest.mark.django_db


def _me(client: APIClient, phone: str) -> User:
    _login(client, phone)
    return User.objects.get(phone=phone)


def _place(user: User, template: str, **payload: str) -> Notification:
    return services.place_notification(
        recipient=user, template=template, payload=dict(payload), legal_significance=False
    )


def test_feed_shape_and_counters():
    client = APIClient()
    me = _me(client, "+79990900321")
    _place(me, "signature_requested", contract_id="c-1")
    read_one = _place(me, "entity_claimed")
    services.mark_read(read_one, user=me)

    resp = client.get("/v1/notifications")
    assert resp.status_code == 200, resp.content
    assert set(resp.data.keys()) == {
        "items",
        "unread_count",
        "groups",
        "next_cursor",
        "total",
    }
    assert resp.data["unread_count"] == 1
    assert resp.data["total"] == 2
    assert resp.data["next_cursor"] is None
    assert resp.data["groups"] == {
        "deals": 1,
        "chats": 0,
        "payments": 0,
        "deadlines": 0,
        "disputes": 0,
    }
    item = resp.data["items"][0]
    # ADR-159 добавил `template_code` — код шаблона строки Notification.
    assert set(item.keys()) == {
        "id",
        "type",
        "template_code",
        "title",
        "severity",
        "created_at",
        "read",
        "group",
    }


def test_feed_template_mapping_signature_and_dispute():
    client = APIClient()
    me = _me(client, "+79990900322")
    _place(me, "signature_requested", contract_id="c-1")
    _place(me, "dispute.opened", dispute_id="d-1")

    resp = client.get("/v1/notifications")
    by_type = {item["type"]: item for item in resp.data["items"]}
    assert by_type["signature"]["severity"] == "due"
    assert by_type["dispute"]["severity"] == "due"
    assert resp.data["groups"]["deals"] == 1
    assert resp.data["groups"]["disputes"] == 1


def test_feed_unknown_template_falls_back_not_lost():
    """Лента — юрканал (ADR-057): неизвестный шаблон не выбрасываем."""
    client = APIClient()
    me = _me(client, "+79990900323")
    _place(me, "template_nobody_mapped_yet")

    resp = client.get("/v1/notifications")
    assert len(resp.data["items"]) == 1
    assert resp.data["items"][0]["type"] == "negotiation"
    assert resp.data["items"][0]["severity"] == "normal"
    # Тела у несуществующего шаблона нет — заголовком остаётся код (не пустая строка).
    assert resp.data["items"][0]["title"] == "template_nobody_mapped_yet"


def test_feed_filter_unread_and_channel_group():
    client = APIClient()
    me = _me(client, "+79990900324")
    unread_deal = _place(me, "negotiation.sent")
    read_deal = _place(me, "contract.signed")
    services.mark_read(read_deal, user=me)
    _place(me, "dispute.opened")

    resp = client.get("/v1/notifications", {"filter": "unread"})
    assert {i["id"] for i in resp.data["items"]} == {
        str(unread_deal.id),
        str(Notification.objects.get(template="dispute.opened").id),
    }
    # Счётчики вкладок — по всей ленте, фильтр сужает только items.
    assert resp.data["unread_count"] == 2

    resp = client.get("/v1/notifications", {"filter": "disputes"})
    assert [i["type"] for i in resp.data["items"]] == ["dispute"]

    resp = client.get("/v1/notifications", {"filter": "deals"})
    assert {i["id"] for i in resp.data["items"]} == {str(unread_deal.id), str(read_deal.id)}


def test_feed_invalid_filter_is_400():
    client = APIClient()
    _me(client, "+79990900325")
    resp = client.get("/v1/notifications", {"filter": "everything"})
    assert resp.status_code == 400


def test_read_all_marks_everything_and_returns_feed():
    client = APIClient()
    me = _me(client, "+79990900326")
    _place(me, "negotiation.sent")
    _place(me, "signature_requested")

    resp = client.post("/v1/notifications/read-all")
    assert resp.status_code == 200, resp.content
    assert resp.data["unread_count"] == 0
    assert resp.data["groups"] == {
        "deals": 0,
        "chats": 0,
        "payments": 0,
        "deadlines": 0,
        "disputes": 0,
    }
    assert Notification.objects.filter(recipient=me, read_at__isnull=True).count() == 0


def test_read_all_requires_authentication():
    resp = APIClient().post("/v1/notifications/read-all")
    assert resp.status_code == 401


def test_feed_time_groups_today_yesterday_earlier():
    client = APIClient()
    me = _me(client, "+79990900327")
    now = timezone.now()
    fresh = _place(me, "negotiation.sent")
    yesterday = _place(me, "negotiation.sent")
    Notification.objects.filter(pk=yesterday.pk).update(
        placed_in_cabinet_at=now - timedelta(days=1)
    )
    old = _place(me, "negotiation.sent")
    Notification.objects.filter(pk=old.pk).update(placed_in_cabinet_at=now - timedelta(days=10))

    resp = client.get("/v1/notifications")
    groups_by_id = {item["id"]: item["group"] for item in resp.data["items"]}
    assert groups_by_id[str(fresh.id)] == "today"
    assert groups_by_id[str(yesterday.id)] == "yesterday"
    assert groups_by_id[str(old.id)] == "earlier"


def test_feed_title_localized_per_user_locale():
    """Заголовок — из body_i18n шаблона на языке получателя (ГВ.5/ADR-095)."""
    client = APIClient()
    me = _me(client, "+79990900328")
    _place(me, "signature_requested")

    resp = client.get("/v1/notifications")
    title_default = resp.data["items"][0]["title"]

    me.locale = "en"
    me.save(update_fields=["locale"])
    resp = client.get("/v1/notifications")
    title_en = resp.data["items"][0]["title"]

    assert title_default != title_en
    assert title_default and title_en


def test_feed_every_mapped_type_has_channel_group():
    """Каждый тип из маппинга шаблонов обязан иметь группу-канал — иначе
    feed_for_recipient упадёт KeyError на счётчиках вкладок."""
    for item_type, _severity in selectors._FEED_TEMPLATE_TYPES.values():
        assert item_type in selectors._FEED_TYPE_GROUP


def test_chat_message_lands_in_chats_group_and_filter():
    """Отсмотр 2026-08-24: сообщения чата — своя складка «Чаты», не «Сделки»."""
    client = APIClient()
    me = _me(client, "+79990900329")
    _place(me, "message.received", contract_id="c-1", message_id="m-1")
    _place(me, "signature_requested", contract_id="c-1")

    resp = client.get("/v1/notifications")
    assert resp.data["groups"]["chats"] == 1
    assert resp.data["groups"]["deals"] == 1
    only_chats = client.get("/v1/notifications", {"filter": "chats"})
    assert [i["type"] for i in only_chats.data["items"]] == ["message"]
