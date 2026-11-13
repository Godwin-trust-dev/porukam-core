import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.notifications import services

pytestmark = pytest.mark.django_db


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return resp.data


def test_list_notifications_requires_authentication():
    client = APIClient()
    resp = client.get("/v1/notifications")
    assert resp.status_code == 401


def test_list_notifications_returns_only_own():
    client = APIClient()
    _login(client, "+79990900301")
    me = User.objects.get(phone="+79990900301")
    stranger = User.objects.create(trust_id="trust-notif-api-stranger", phone="+79990900302")

    mine = services.place_notification(
        recipient=me, template="entity_claimed", payload={}, legal_significance=False
    )
    services.place_notification(
        recipient=stranger, template="entity_claimed", payload={}, legal_significance=False
    )

    resp = client.get("/v1/notifications")
    assert resp.status_code == 200, resp.content
    ids = [row["id"] for row in resp.data["items"]]
    assert ids == [str(mine.id)]


def test_read_notification_marks_read_at():
    client = APIClient()
    _login(client, "+79990900303")
    me = User.objects.get(phone="+79990900303")
    notification = services.place_notification(
        recipient=me, template="entity_claimed", payload={}, legal_significance=False
    )

    resp = client.post(f"/v1/notifications/{notification.id}/read")
    assert resp.status_code == 200, resp.content
    notification.refresh_from_db()
    assert notification.read_at is not None
    assert resp.data["unread_count"] == 0


def test_read_someone_elses_notification_is_404():
    client = APIClient()
    _login(client, "+79990900304")
    stranger = User.objects.create(trust_id="trust-notif-api-stranger-2", phone="+79990900305")
    notification = services.place_notification(
        recipient=stranger, template="entity_claimed", payload={}, legal_significance=False
    )

    resp = client.post(f"/v1/notifications/{notification.id}/read")
    assert resp.status_code == 404


def test_get_notification_settings_matches_frontend_contract():
    """DEV-14 §7 / №10 отсмотра 2026-08-18: форма ответа — контракт фронта
    (packages/core NotificationSettings), не сырые поля модели."""
    client = APIClient()
    _login(client, "+79990900306")

    resp = client.get("/v1/notification-settings")
    assert resp.status_code == 200, resp.content
    assert resp.data == {
        "in_app": True,
        "push": True,
        "push_permission": "default",
        # Миграция 0015 (решение продукта 25.08): e-mail по умолчанию выключен —
        # ровно то, что мок фронта (web/src/mocks/notificationsDb.ts) отдавал
        # с самого начала, расходился именно бэкенд.
        "email": False,
        "email_address": "",
        "sms": True,
        "groups": {
            "deals": True,
            "chats": True,
            "payments": True,
            "deadlines": True,
            "disputes": True,
        },
    }


def test_put_notification_settings_can_disable_push_and_group():
    client = APIClient()
    _login(client, "+79990900307")

    resp = client.put(
        "/v1/notification-settings",
        {"push": False, "groups": {"payments": False}},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["push"] is False
    assert resp.data["in_app"] is True
    assert resp.data["groups"] == {
        "deals": True,
        "chats": True,
        "payments": False,
        "deadlines": True,
        "disputes": True,
    }


def test_put_notification_settings_cannot_disable_in_app():
    """fundament.md ЭФ.4: «настройка не может отключить in_app»."""
    client = APIClient()
    _login(client, "+79990900308")

    resp = client.put("/v1/notification-settings", {"in_app": False}, format="json")
    assert resp.status_code == 422, resp.content


def test_put_push_true_with_denied_permission_is_422():
    """DEV-14 §5 (зеркало мока): при denied включить push через приложение
    нельзя — сначала разрешение в браузере."""
    client = APIClient()
    _login(client, "+79990900309")

    resp = client.put(
        "/v1/notification-settings", {"push_permission": "denied", "push": False}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["push_permission"] == "denied"

    resp = client.put("/v1/notification-settings", {"push": True}, format="json")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "push_permission_denied"

    # granted в том же PUT, что и push=true — валидно (разрешение только что дано).
    resp = client.put(
        "/v1/notification-settings", {"push_permission": "granted", "push": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["push"] is True
