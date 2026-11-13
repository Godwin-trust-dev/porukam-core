"""POST /v1/analytics/constructor-step — единственный ВВОД приложения (§8.1)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.analytics.models import ConstructorStepEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

URL = "/v1/analytics/constructor-step"


def _authorized() -> APIClient:
    """Мастер договора живёт за логином, поэтому и приёмник событий тоже:
    анонимная запись без лимита позволила бы залить витрину мусором.
    Личность в само событие при этом НЕ попадает — она нужна только на входе."""
    client = APIClient()
    # Пользователь берётся через get_user_model(): аналитика — читатель и не
    # импортирует apps.* даже в тестах (контракт import-linter, ADR-145).
    user = get_user_model().objects.create(trust_id="trust-analytics", phone="+79990000001")
    client.force_authenticate(user)
    return client


def test_anonymous_cannot_write_events() -> None:
    """🚫 Без логина событие не принимается."""
    response = APIClient().post(URL, {"step_code": "stages", "action": "left"}, format="json")
    assert response.status_code in (401, 403)
    assert not ConstructorStepEvent.objects.exists()


def test_records_step_event() -> None:
    """✅ Событие принимается и ложится в узкий поведенческий слой."""
    response = _authorized().post(URL, {"step_code": "stages", "action": "left"}, format="json")
    assert response.status_code == 204, response.content
    event = ConstructorStepEvent.objects.get()
    assert (event.step_code, event.action) == ("stages", "left")


def test_rejects_unknown_action() -> None:
    """🚫 Произвольное действие не принимается — иначе слой перестаёт быть узким."""
    response = _authorized().post(URL, {"step_code": "stages", "action": "scrolled"}, format="json")
    assert response.status_code == 400
    assert not ConstructorStepEvent.objects.exists()


def test_ignores_extra_fields_that_would_be_personal_data() -> None:
    """✅ Лишние поля отбрасываются сериализатором: клиент не может дослать
    в аналитику ни пользователя, ни содержимое формы (§1 п.3)."""
    response = _authorized().post(
        URL,
        {
            "step_code": "parties",
            "action": "left",
            "user_id": "00000000-0000-0000-0000-000000000001",
            "phone": "+70000000000",
            "form_data": {"title": "секрет"},
        },
        format="json",
    )
    assert response.status_code == 204, response.content
    event = ConstructorStepEvent.objects.get()
    assert event.step_code == "parties"
    # В модели этих полей нет вовсе — проверяем именно это, а не «не сохранилось».
    stored = {f.name for f in ConstructorStepEvent._meta.get_fields()}
    assert not (stored & {"user", "user_id", "phone", "form_data", "ip"})
