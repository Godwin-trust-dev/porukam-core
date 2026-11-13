"""Web Push (ADR-110): подписки, выбор провайдера, WebPushProvider.

Юрканал остаётся ЛК (`placed_in_cabinet_at`, ADR-057) — здесь тестируется
только дублирующий канал: регистрация/отзыв подписки, чистка мёртвых
endpoint по 404/410 и минимальная полезная нагрузка (без сумм и имён).
`pywebpush.webpush` мокается — наружу тесты не ходят.
"""

from __future__ import annotations

from unittest import mock

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.notifications import selectors, services
from apps.notifications.models import PushSubscription
from apps.notifications.providers import FakePushProvider, WebPushProvider, get_push_provider

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

ENDPOINT = "https://push.example.com/send/abc123"


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-push-{suffix}", phone=f"+7999091{suffix}")


def _subscribe(user: User, endpoint: str = ENDPOINT) -> PushSubscription:
    return services.subscribe_push(user, endpoint=endpoint, p256dh="p-key", auth="a-key")


# --- services ----------------------------------------------------------------


def test_subscribe_is_idempotent_by_endpoint():
    user = _user("001")
    first = _subscribe(user)
    second = services.subscribe_push(user, endpoint=ENDPOINT, p256dh="p-key-2", auth="a-key-2")
    assert first.id == second.id
    assert PushSubscription.objects.count() == 1
    assert second.p256dh == "p-key-2"


def test_subscribe_reassigns_endpoint_to_new_user():
    """Endpoint принадлежит браузеру: вошёл другой аккаунт — пуши получает он."""
    old, new = _user("002"), _user("003")
    _subscribe(old)
    _subscribe(new)
    assert PushSubscription.objects.get(endpoint=ENDPOINT).user_id == new.id
    assert not selectors.list_push_subscriptions(old).exists()


def test_unsubscribe_is_idempotent_and_scoped_to_owner():
    user, stranger = _user("004"), _user("005")
    _subscribe(user)
    services.unsubscribe_push(stranger, endpoint=ENDPOINT)  # чужой endpoint — no-op
    assert PushSubscription.objects.count() == 1
    services.unsubscribe_push(user, endpoint=ENDPOINT)
    services.unsubscribe_push(user, endpoint=ENDPOINT)  # повторно — no-op
    assert PushSubscription.objects.count() == 0


# --- выбор провайдера --------------------------------------------------------


def test_provider_defaults_to_fake(settings):
    settings.NOTIFICATIONS_PUSH_PROVIDER = "fake"
    assert isinstance(get_push_provider(), FakePushProvider)


def test_provider_webpush_by_env(settings):
    settings.NOTIFICATIONS_PUSH_PROVIDER = "webpush"
    assert isinstance(get_push_provider(), WebPushProvider)


# --- WebPushProvider ---------------------------------------------------------

MESSAGE = {
    "subject": "Этап сдан на приёмку",
    "body": "Откройте личный кабинет, чтобы посмотреть детали.",
    "template": "milestone.submitted",
    "payload": {"amount": "100.00"},
}


def test_webpush_no_subscription():
    user = _user("006")
    result = WebPushProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "no_subscription"


def test_webpush_sends_minimal_payload_without_domain_data(settings):
    settings.WEBPUSH_VAPID_PRIVATE_KEY = "priv"
    settings.WEBPUSH_VAPID_CONTACT = "support@example.com"
    user = _user("007")
    _subscribe(user)
    with mock.patch("pywebpush.webpush") as webpush_mock:
        result = WebPushProvider().send(user, MESSAGE)
    assert result.delivered is True
    kwargs = webpush_mock.call_args.kwargs
    assert kwargs["subscription_info"]["endpoint"] == ENDPOINT
    # Полезная нагрузка минимальна: заголовок/текст шаблона + маршрут; ни
    # суммы, ни payload наружу не уходят (ADR-110).
    assert "100.00" not in kwargs["data"]
    assert "Этап сдан на приёмку" in kwargs["data"]
    assert "/notifications" in kwargs["data"]
    assert kwargs["vapid_claims"] == {"sub": "mailto:support@example.com"}


def test_webpush_410_deletes_dead_subscription():
    from pywebpush import WebPushException

    user = _user("008")
    _subscribe(user)
    response = mock.Mock(status_code=410)
    with mock.patch("pywebpush.webpush", side_effect=WebPushException("gone", response=response)):
        result = WebPushProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert result.status == "gone_410"
    assert PushSubscription.objects.count() == 0


def test_webpush_network_error_keeps_subscription():
    from pywebpush import WebPushException

    user = _user("009")
    _subscribe(user)
    with mock.patch("pywebpush.webpush", side_effect=WebPushException("boom")):
        result = WebPushProvider().send(user, MESSAGE)
    assert result.delivered is False
    assert PushSubscription.objects.count() == 1


def test_webpush_delivered_if_any_of_many(settings):
    """Один живой endpoint из двух — доставлено (SMS-фолбэк не нужен)."""
    from pywebpush import WebPushException

    user = _user("010")
    _subscribe(user, endpoint="https://push.example.com/dead")
    _subscribe(user, endpoint="https://push.example.com/alive")
    response = mock.Mock(status_code=404)

    def _send(**kwargs):
        if kwargs["subscription_info"]["endpoint"].endswith("/dead"):
            raise WebPushException("gone", response=response)
        return None

    with mock.patch("pywebpush.webpush", side_effect=_send):
        result = WebPushProvider().send(user, MESSAGE)
    assert result.delivered is True
    assert PushSubscription.objects.count() == 1  # мёртвая удалена


# --- HTTP-слой ---------------------------------------------------------------


def test_push_api_requires_authentication():
    client = APIClient()
    assert client.get("/v1/push/config").status_code == 401
    assert client.post("/v1/push-subscriptions", {}, format="json").status_code == 401


def test_push_subscribe_and_unsubscribe_http(settings):
    settings.WEBPUSH_VAPID_PUBLIC_KEY = "pub-key"
    user = _user("011")
    client = APIClient()
    client.force_authenticate(user=user)

    assert client.get("/v1/push/config").data == {"vapid_public_key": "pub-key"}

    body = {"endpoint": ENDPOINT, "keys": {"p256dh": "p", "auth": "a"}}
    resp = client.post("/v1/push-subscriptions", body, format="json")
    assert resp.status_code == 201, resp.content
    assert PushSubscription.objects.get(endpoint=ENDPOINT).user_id == user.id

    resp = client.post("/v1/push-subscriptions/unsubscribe", {"endpoint": ENDPOINT}, format="json")
    assert resp.status_code == 204
    assert PushSubscription.objects.count() == 0


def test_push_subscribe_validates_body():
    user = _user("012")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.post("/v1/push-subscriptions", {"endpoint": "not-a-url"}, format="json")
    assert resp.status_code == 400


def test_webpush_payload_substitutes_without_private_keys(monkeypatch, settings):
    """ADR-141/ADR-180: в пуше — название сделки (заголовок) и короткая фраза
    действия (тело), но НЕ сумма и НЕ имя контрагента (экран блокировки);
    ссылка — в сделку."""
    import json

    from apps.notifications import providers

    settings.WEBPUSH_VAPID_PRIVATE_KEY = "k"
    user = User.objects.create(trust_id="trust-push-sub", phone="+79990930001")
    PushSubscription.objects.create(user=user, endpoint="https://p.example/1", p256dh="p", auth="a")
    sent: dict[str, object] = {}

    def fake_webpush(**kwargs):  # noqa: ANN003, ANN202
        sent.update(kwargs)

    import pywebpush

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    message = {
        "subject": "Этап «{milestone_title}» сдан",
        "body": "Договор «{contract_title}», {counterparty_name}, {amount} {currency}",
        "payload": {
            "milestone_title": "Плитка",
            "contract_title": "Ремонт кухни",
            "counterparty_name": "Иван Петров",
            "amount": "100.00",
            "currency": "RUB",
        },
        "contract_id": "01a02359-6ef5-7466-8712-ef63299b169a",
    }
    result = providers.WebPushProvider().send(user, message)
    assert result.delivered is True
    data = json.loads(str(sent["data"]))
    # ADR-180: заголовок — название договора, тело — короткий subject;
    # длинное тело письма («Договор «…», …, … …») в пуш больше не идёт.
    assert data["title"] == "Ремонт кухни"
    assert data["body"] == "Этап «Плитка» сдан"
    assert "icon" not in data  # договора в БД нет — фото взять неоткуда
    raw = str(sent["data"])
    assert "Иван" not in raw and "100.00" not in raw and "RUB" not in raw
    assert data["url"] == "/contracts/01a02359-6ef5-7466-8712-ef63299b169a"


def test_webpush_falls_back_to_subject_and_body_without_contract_title():
    """ADR-180: уведомления без договора (объединения, claim юрлица) —
    поведение как раньше: title = subject, body = тело, без пустого
    заголовка."""
    from apps.notifications import providers

    message = {
        "subject": "Юрлицо подтверждено",
        "body": "Вы подтвердили право представлять «ООО Ромашка».",
        "payload": {},
    }
    result = providers.push_payload(message)
    assert result["title"] == "Юрлицо подтверждено"
    assert result["body"] == "Вы подтвердили право представлять «ООО Ромашка»."
    assert "icon" not in result


def test_webpush_counterparty_photo_in_icon_when_visible(settings):
    """ADR-180: фото контрагента — в `icon`, абсолютным URL; имя контрагента
    текстом в push не идёт (владелец 11.09 — «фото да, имя не надо»)."""
    from apps.contracts.tests._signing_helpers import make_user
    from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf
    from apps.notifications import providers
    from apps.profiles.models import Profile

    settings.PUBLIC_WEB_BASE_URL = "https://porukam.example"
    customer, contractor = make_user("push101"), make_user("push102")
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    contractor_profile = Profile.objects.filter(
        owner_user=contractor, kind=Profile.Kind.PERSON
    ).get()
    contractor_profile.avatar_key = "avatars/ctr/0198ff00"
    contractor_profile.avatar_visibility = Profile.AvatarVisibility.PUBLIC
    contractor_profile.save(update_fields=["avatar_key", "avatar_visibility"])

    message = {
        "subject": "Этап принят",
        "body": "Заказчик принял этап.",
        "payload": {"contract_title": contract.title},
        "contract_id": str(contract.id),
    }
    result = providers.push_payload(message, recipient=customer)
    assert result["icon"] is not None
    assert result["icon"].startswith("https://porukam.example/")
    assert str(contractor_profile.id) in result["icon"]
    assert "counterparty_name" not in message["payload"]  # имя рядом не подставляли


def test_webpush_no_icon_when_counterparty_photo_not_visible():
    """`deals_only` (ADR-103) и сделка ещё не завершена (`DealFact.
    is_completed`, ADR-059) — фото зрителю нельзя, ключа `icon` просто нет
    (не пустая строка, не сломанная ссылка)."""
    from apps.contracts.tests._signing_helpers import make_user
    from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf
    from apps.notifications import providers
    from apps.profiles.models import Profile

    customer, contractor = make_user("push103"), make_user("push104")
    contract, _milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    contractor_profile = Profile.objects.filter(
        owner_user=contractor, kind=Profile.Kind.PERSON
    ).get()
    contractor_profile.avatar_key = "avatars/ctr/0198ff01"
    contractor_profile.avatar_visibility = Profile.AvatarVisibility.DEALS_ONLY
    contractor_profile.save(update_fields=["avatar_key", "avatar_visibility"])

    message = {
        "subject": "Этап принят",
        "body": "Заказчик принял этап.",
        "payload": {"contract_title": contract.title},
        "contract_id": str(contract.id),
    }
    result = providers.push_payload(message, recipient=customer)
    assert "icon" not in result


def test_webpush_no_icon_without_recipient():
    """Обратная совместимость: `push_payload` без `recipient` (как в старых
    тестах и любых прочих вызывающих местах) не пытается идти в БД за фото."""
    from apps.notifications import providers

    result = providers.push_payload(
        {"subject": "Тема", "body": "Текст", "payload": {"contract_title": "Договор"}}
    )
    assert "icon" not in result
    assert result["title"] == "Договор"
    assert result["body"] == "Тема"


def test_webpush_sends_urgency_and_ttl_headers(monkeypatch, settings):
    """Жалоба владельца 10.09.2026: «пуш живой, приходит при запуске приложения»
    при Chrome «без ограничений» по батарее. Без заголовка Urgency push-сервис
    считает сообщение обычным, и Android в Doze копит его до пробуждения
    браузера. Шлём Urgency из настроек (по умолчанию high) и ttl рядом."""
    from apps.notifications import providers

    settings.WEBPUSH_VAPID_PRIVATE_KEY = "k"
    settings.WEBPUSH_URGENCY = "high"
    settings.WEBPUSH_TTL_SECONDS = 3600
    user = User.objects.create(trust_id="trust-push-urg", phone="+79990930002")
    PushSubscription.objects.create(user=user, endpoint="https://p.example/2", p256dh="p", auth="a")
    sent: dict[str, object] = {}

    def fake_webpush(**kwargs):  # noqa: ANN003, ANN202
        sent.update(kwargs)

    import pywebpush

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    result = providers.WebPushProvider().send(user, {"subject": "Тема", "body": "Текст"})

    assert result.delivered is True
    assert sent["headers"] == {"Urgency": "high"}
    assert sent["ttl"] == 3600


def test_webpush_urgency_is_configurable(monkeypatch, settings):
    """Значение берётся из настроек, а не зашито: если push-сервис начнёт
    штрафовать за high, срочность понижается переменной окружения без выкатки."""
    from apps.notifications import providers

    settings.WEBPUSH_VAPID_PRIVATE_KEY = "k"
    settings.WEBPUSH_URGENCY = "normal"
    user = User.objects.create(trust_id="trust-push-urg2", phone="+79990930003")
    PushSubscription.objects.create(user=user, endpoint="https://p.example/3", p256dh="p", auth="a")
    sent: dict[str, object] = {}

    def fake_webpush(**kwargs):  # noqa: ANN003, ANN202
        sent.update(kwargs)

    import pywebpush

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    providers.WebPushProvider().send(user, {"subject": "Тема", "body": "Текст"})

    assert sent["headers"] == {"Urgency": "normal"}
