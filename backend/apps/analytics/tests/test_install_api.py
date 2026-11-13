"""POST /v1/analytics/install-event — второй ВВОД приложения (ADR-171)."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIClient

from apps.analytics.models import InstallEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

URL = "/v1/analytics/install-event"

ALL_KINDS = [
    "install_prompt_shown",
    "install_click",
    "pwa_installed",
    "play_click",
    "standalone_open",
]


@pytest.fixture(autouse=True)
def _clean_rate_limit():
    """Счётчик лимита живёт в кеше, а кеш не откатывается транзакцией:
    без очистки соседний тест приезжает с чужими 429."""
    cache.clear()
    yield
    cache.clear()


def _authorized() -> tuple[APIClient, object]:
    client = APIClient()
    # Пользователь берётся через get_user_model(): аналитика не импортирует
    # apps.* даже в тестах (контракт import-linter, ADR-145).
    user = get_user_model().objects.create(trust_id="trust-install", phone="+79990000101")
    client.force_authenticate(user)
    return client, user


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_records_every_kind_of_install_event(kind: str) -> None:
    """✅ Каждый вид воронки принимается и ложится в слой — по тесту на вид."""
    response = APIClient().post(URL, {"kind": kind, "platform": "android"}, format="json")
    assert response.status_code == 204, response.content
    event = InstallEvent.objects.get()
    assert (event.kind, event.platform) == (kind, "android")


def test_guest_can_report_installation() -> None:
    """✅ Гость принимается без user_id: приложение ставят с посадочной
    страницы, до входа — требование логина отсекло бы ровно тот случай,
    ради которого счётчик заведён."""
    response = APIClient().post(URL, {"kind": "pwa_installed"}, format="json")
    assert response.status_code == 204, response.content
    assert InstallEvent.objects.get().user_id is None


def test_authenticated_user_is_taken_from_token_not_from_body() -> None:
    """✅ У авторизованного установка связывается с аккаунтом — иначе она не
    складывается с остальной его жизнью (DAU). 🚫 Но `user_id` из ТЕЛА не
    принимается: иначе установку можно приписать чужому аккаунту."""
    client, user = _authorized()
    other = "00000000-0000-0000-0000-000000000009"
    response = client.post(URL, {"kind": "install_click", "user_id": other}, format="json")
    assert response.status_code == 204, response.content
    assert str(InstallEvent.objects.get().user_id) == str(user.id)  # type: ignore[attr-defined]


def test_rejects_unknown_kind() -> None:
    """🚫 Произвольный вид не принимается — иначе слой перестаёт быть узким
    и превращается в клиентский трекинг, от которого §9.4 отказывается."""
    response = APIClient().post(URL, {"kind": "scrolled_to_footer"}, format="json")
    assert response.status_code == 400
    assert not InstallEvent.objects.exists()


def test_rejects_unknown_platform() -> None:
    """🚫 Платформа — закрытый набор корзин, а не свободное поле: сюда нельзя
    прислать строку User-Agent под видом платформы."""
    response = APIClient().post(
        URL, {"kind": "pwa_installed", "platform": "Mozilla/5.0 (SM-S908B)"}, format="json"
    )
    assert response.status_code == 400
    assert not InstallEvent.objects.exists()


def test_ignores_extra_fields_that_would_be_personal_data() -> None:
    """✅ Лишние поля отбрасываются: ни UA, ни IP, ни отпечатка устройства
    клиент дослать не может — таких полей в модели нет вовсе (§1 п.3)."""
    response = APIClient().post(
        URL,
        {
            "kind": "standalone_open",
            "user_agent": "Mozilla/5.0",
            "ip": "203.0.113.7",
            "device_fingerprint": "abc123",
        },
        format="json",
    )
    assert response.status_code == 204, response.content
    stored = {f.name for f in InstallEvent._meta.get_fields()}
    assert not (stored & {"user_agent", "ip", "device_fingerprint", "phone", "session_id"})


@override_settings(ANALYTICS_INSTALL_RATE_LIMIT=3)
def test_rate_limit_closes_the_open_endpoint() -> None:
    """🚫 Анонимная ручка обязана иметь лимит: без него кто угодно зальёт
    витрину выдуманными установками."""
    client = APIClient()
    for _ in range(3):
        assert client.post(URL, {"kind": "install_click"}, format="json").status_code == 204
    blocked = client.post(URL, {"kind": "install_click"}, format="json")
    assert blocked.status_code == 429
    assert InstallEvent.objects.count() == 3


def test_defaults_are_the_least_claiming_ones() -> None:
    """✅ Без явных значений событие не утверждает лишнего: платформа
    «прочее», режим «браузер», источник «не определён»."""
    assert APIClient().post(URL, {"kind": "install_click"}, format="json").status_code == 204
    event = InstallEvent.objects.get()
    assert (event.platform, event.display_mode, event.source) == ("other", "browser", "unknown")
