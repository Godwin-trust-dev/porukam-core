import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.entities.providers import FakeEntityRegistryProvider
from apps.profiles.models import Profile
from common import relay

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


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
    relay.deliver_due_events()  # account.logged_in -> person-профиль создан
    return resp.data


def _verify_esia(client: APIClient, *, full_name: str, tax_id: str) -> None:
    resp = client.get("/v1/auth/esia/authorize-url")
    assert resp.status_code == 200, resp.content
    state = resp.data["state"]
    callback = client.post(
        "/v1/auth/esia/callback", {"code": f"{full_name}|{tax_id}", "state": state}, format="json"
    )
    assert callback.status_code == 200, callback.content


def test_profile_create_person_is_idempotent():
    client = APIClient()
    _login(client, "+79990860001")
    first = client.post("/v1/profiles", {"kind": "person"}, format="json")
    second = client.post("/v1/profiles", {"kind": "person"}, format="json")
    assert first.status_code == 200, first.content
    assert second.status_code == 200, second.content
    assert first.data["id"] == second.data["id"]


def test_profile_detail_accessible_without_auth_even_when_link_and_deals():
    """Дельта §2 тест 5: link_and_deals недоступен в каталоге, но доступен
    по прямой ссылке."""
    client = APIClient()
    _login(client, "+79990860002")
    profile_id = client.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]
    client.patch(
        f"/v1/profiles/{profile_id}", {"profile_visibility": "link_and_deals"}, format="json"
    )

    anon = APIClient()
    resp = anon.get(f"/v1/profiles/{profile_id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["profile_visibility"] == "link_and_deals"


def test_profile_patch_requires_ownership():
    owner = APIClient()
    _login(owner, "+79990860003")
    profile_id = owner.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]

    intruder = APIClient()
    _login(intruder, "+79990860004")
    resp = intruder.patch(f"/v1/profiles/{profile_id}", {"city_name": "Захват"}, format="json")
    assert resp.status_code == 403, resp.content


def test_business_profile_visibility_patch_is_conflict():
    """Дельта §2 тест 4 на HTTP-уровне: 409 при попытке снять публичность у
    бизнес-профиля."""
    client = APIClient()
    _login(client, "+79990860009")
    _verify_esia(
        client,
        full_name="Иван Петрович Директоров",
        tax_id=FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
    )
    onboard = client.post(
        "/v1/business-entities",
        {"country": "RU", "tax_id": FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN},
        format="json",
    )
    assert onboard.status_code == 201, onboard.content
    entity_id = onboard.data["id"]
    relay.deliver_due_events()  # entity.claimed -> business-профиль создан

    profile = Profile.objects.get(kind=Profile.Kind.BUSINESS, owner_entity_id=entity_id)
    resp = client.patch(
        f"/v1/profiles/{profile.id}", {"profile_visibility": "link_and_deals"}, format="json"
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "profile_visibility_locked"


def test_portfolio_project_create_list_and_publish():
    client = APIClient()
    _login(client, "+79990860005")
    profile_id = client.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]

    created = client.post(
        f"/v1/profiles/{profile_id}/portfolio/projects",
        {
            "title": "Ремонт кухни",
            "sphere": "renovation",
            "location_label": "Москва",
            "completed_at": "2026-05-01",
        },
        format="json",
    )
    assert created.status_code == 201, created.content

    listing = client.get(f"/v1/profiles/{profile_id}/portfolio/projects")
    assert listing.status_code == 200
    assert len(listing.data) == 1

    published = client.post(f"/v1/portfolio/projects/{created.data['id']}/publish")
    assert published.status_code == 200, published.content
    assert published.data["is_published"] is True


def test_portfolio_project_create_requires_ownership():
    owner = APIClient()
    _login(owner, "+79990860006")
    profile_id = owner.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]

    intruder = APIClient()
    _login(intruder, "+79990860007")
    resp = intruder.post(
        f"/v1/profiles/{profile_id}/portfolio/projects",
        {"title": "Захват", "sphere": "it", "completed_at": "2026-01-01"},
        format="json",
    )
    assert resp.status_code == 403, resp.content


def test_catalog_visibility_reflected_in_users_me():
    """etap-3.md 3.5 приёмка (доп. проверка на стыке с 3.3): смена
    profile_public отражается в собственном профиле немедленно."""
    client = APIClient()
    _login(client, "+79990860008")
    client.post(
        "/v1/users/me/privacy-consents",
        {"pd_processing": True, "profile_public": True, "phone_discoverability": False},
        format="json",
    )
    relay.deliver_due_events()

    me = client.get("/v1/users/me")
    person_profile = next(p for p in me.data["profiles"] if p["kind"] == "person")
    assert person_profile["profile_visibility"] == "public"
