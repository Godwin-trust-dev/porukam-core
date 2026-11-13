"""`POST /v1/payments/webhooks/{provider}` — идемпотентный адаптер
(CLAUDE.md: «вебхуки идемпотентны»; tech-spec.md §8.7).

Партнёра нет (ADR-130), поэтому единственный зарегистрированный провайдер —
`manual`, и доменного эффекта у его вебхука тоже нет. Проверяется ровно то,
что нельзя «дописать потом»: контракт эндпоинта, разбор, дедупликация по
`(provider, event_id)` и поведение на повторе.
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.payments.models import ProviderWebhookEvent
from apps.payments.providers import (
    ManualProvider,
    PaymentProvider,
    PaymentProviderUnknownError,
    get_provider,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

_URL = "/v1/payments/webhooks/manual"


def test_manual_provider_satisfies_the_protocol():
    """Протокол — не декоративный: подключение партнёра не должно
    потребовать правок в services/api."""
    assert isinstance(ManualProvider(), PaymentProvider)


def test_unknown_provider_is_404():
    resp = APIClient().post("/v1/payments/webhooks/nonexistent", {"event_id": "1"}, format="json")
    assert resp.status_code == 404


def test_get_provider_raises_for_unknown():
    with pytest.raises(PaymentProviderUnknownError):
        get_provider("nonexistent")


def test_webhook_without_event_id_is_422():
    """Без ключа дедупликации доставка не идемпотентна — принимать её
    нельзя, и партнёр обязан узнать об этом кодом ответа, а не 500."""
    resp = APIClient().post(_URL, {"outcome": "paid"}, format="json")
    assert resp.status_code == 422
    assert resp.data["code"] == "webhook_malformed"
    assert not ProviderWebhookEvent.objects.exists()


def test_webhook_is_accepted_once():
    resp = APIClient().post(_URL, {"event_id": "evt-1", "outcome": "paid"}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["status"] == "accepted"
    assert resp.data["outcome"] == "ignored_no_partner"
    assert ProviderWebhookEvent.objects.count() == 1


def test_repeated_webhook_is_deduplicated():
    client = APIClient()
    body = {"event_id": "evt-2", "outcome": "paid"}
    first = client.post(_URL, body, format="json")
    second = client.post(_URL, body, format="json")
    third = client.post(_URL, body, format="json")
    assert first.data["status"] == "accepted"
    assert second.data["status"] == "duplicate"
    assert third.data["status"] == "duplicate"
    # Ровно одна запись — вот и вся идемпотентность (UNIQUE, не память).
    assert ProviderWebhookEvent.objects.filter(provider="manual", event_id="evt-2").count() == 1


def test_different_event_ids_are_separate_deliveries():
    client = APIClient()
    client.post(_URL, {"event_id": "evt-a"}, format="json")
    client.post(_URL, {"event_id": "evt-b"}, format="json")
    assert ProviderWebhookEvent.objects.count() == 2


def test_webhook_needs_no_authentication():
    """Зовёт партнёр, а не пользователь — сессии у него нет."""
    resp = APIClient().post(_URL, {"event_id": "evt-anon"}, format="json")
    assert resp.status_code == 200
