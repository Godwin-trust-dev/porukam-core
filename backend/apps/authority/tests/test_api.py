import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.entities.providers import FakeEntityRegistryProvider

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


def _verify_esia(client: APIClient, *, full_name: str, tax_id: str) -> None:
    resp = client.get("/v1/auth/esia/authorize-url")
    assert resp.status_code == 200, resp.content
    state = resp.data["state"]
    callback = client.post(
        "/v1/auth/esia/callback", {"code": f"{full_name}|{tax_id}", "state": state}, format="json"
    )
    assert callback.status_code == 200, callback.content


def _claim_llc_as_director(client: APIClient) -> str:
    """Онбординг + авто-claim ООО директором — возвращает entity_id."""
    _verify_esia(
        client,
        full_name="Иван Петрович Директоров",
        tax_id=FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN,
    )
    resp = client.post(
        "/v1/business-entities",
        {"country": "RU", "tax_id": FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["claim_status"] == "claimed"
    return str(resp.data["id"])


def test_signing_authority_with_money_limit():
    """etap-3.md 3.5 приёмка: «выдать право подписи с лимитом 50 000 ₽ —
    валидация Money»."""
    client = APIClient()
    tokens = _login(client, "+79990920001")
    entity_id = _claim_llc_as_director(client)
    director = User.objects.get(phone="+79990920001")

    resp = client.post(
        f"/v1/business-entities/{entity_id}/signing-authorities",
        {
            "user_id": str(director.id),
            "basis": "registry_verified_director",
            "max_amount": {"amount": "50000.00", "currency": "RUB"},
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["max_amount"] == {"amount": "50000.00", "currency": "RUB"}
    assert tokens


def test_manual_review_signing_authority_for_llc_is_403():
    """etap-3.md 3.5 приёмка: «попытка выдать SigningAuthority через manual
    для ООО — 403»."""
    client = APIClient()
    _login(client, "+79990920002")
    entity_id = _claim_llc_as_director(client)
    director = User.objects.get(phone="+79990920002")

    resp = client.post(
        f"/v1/business-entities/{entity_id}/signing-authorities",
        {"user_id": str(director.id), "basis": "manual_review"},
        format="json",
    )
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "manual_review_not_allowed"


def test_representative_grant_list_and_revoke():
    client = APIClient()
    _login(client, "+79990920003")
    entity_id = _claim_llc_as_director(client)
    director = User.objects.get(phone="+79990920003")

    # Бутстрап: claim'нувший выдаёт САМ СЕБЕ первого представителя —
    # единственный способ получить manage_representatives и приглашать дальше.
    bootstrap = client.post(
        f"/v1/business-entities/{entity_id}/representatives",
        {"user_id": str(director.id), "role": "administrator"},
        format="json",
    )
    assert bootstrap.status_code == 201, bootstrap.content

    other = User.objects.create(trust_id="trust-authority-api-other", phone="+79990920004")
    grant = client.post(
        f"/v1/business-entities/{entity_id}/representatives",
        {"user_id": str(other.id), "role": "member"},
        format="json",
    )
    assert grant.status_code == 201, grant.content

    listing = client.get(f"/v1/business-entities/{entity_id}/representatives")
    assert listing.status_code == 200
    assert len(listing.data) == 2  # директор (бутстрап) + приглашённый

    revoke = client.delete(f"/v1/business-entities/{entity_id}/representatives/{grant.data['id']}")
    assert revoke.status_code == 204


def test_second_representative_grant_without_bootstrap_is_403():
    """Без самостоятельного бутстрапа приглашать третьих лиц нельзя — иначе
    любой аутентифицированный actor мог бы выдать себе права на чужое
    свежезаявленное юрлицо раньше claim'нувшего."""
    client = APIClient()
    _login(client, "+79990920005")
    entity_id = _claim_llc_as_director(client)

    other = User.objects.create(trust_id="trust-authority-api-other2", phone="+79990920006")
    resp = client.post(
        f"/v1/business-entities/{entity_id}/representatives",
        {"user_id": str(other.id), "role": "member"},
        format="json",
    )
    assert resp.status_code == 403, resp.content


def test_signing_authorities_requires_authentication():
    client = APIClient()
    resp = client.get(
        "/v1/business-entities/00000000-0000-0000-0000-000000000000/signing-authorities"
    )
    assert resp.status_code == 401
