import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
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


def _onboard(client: APIClient, tax_id: str) -> dict:
    resp = client.post("/v1/business-entities", {"country": "RU", "tax_id": tax_id}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.data


def test_onboard_requires_authentication():
    client = APIClient()
    resp = client.post(
        "/v1/business-entities",
        {"country": "RU", "tax_id": FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN},
        format="json",
    )
    assert resp.status_code == 401


def test_onboard_unknown_tax_id_is_404():
    client = APIClient()
    _login(client, "+79990900001")
    resp = client.post(
        "/v1/business-entities", {"country": "RU", "tax_id": "no-such-inn"}, format="json"
    )
    assert resp.status_code == 404
    assert resp.data["code"] == "entity_not_found_in_registry"


def test_onboard_liquidated_entity_is_403():
    client = APIClient()
    _login(client, "+79990900002")
    resp = client.post(
        "/v1/business-entities",
        {"country": "RU", "tax_id": FakeEntityRegistryProvider.LIQUIDATED_INN},
        format="json",
    )
    assert resp.status_code == 403
    assert resp.data["code"] == "entity_liquidated"


def test_acceptance_own_sole_proprietor_auto_claim_grants_business_status():
    """✅ Приёмка (etap-3.md 3.4): онбординг ИП по фейк-ИНН → авто-claim →
    GET /users/me показывает has_business_status: true."""
    client = APIClient()
    _login(client, "+79990900003")
    _verify_esia(
        client, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )

    entity = _onboard(client, FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)
    assert entity["claim_status"] == "claimed"
    assert entity["claim_method"] == "owner_identity_match"

    me = client.get("/v1/users/me")
    assert me.status_code == 200
    assert me.data["has_business_status"] is True


def test_acceptance_foreign_llc_without_director_match_is_unclaimed_and_not_operable():
    """✅ Приёмка (etap-3.md 3.4): онбординг чужого ООО без совпадения ФИО →
    карточка unclaimed, попытка операции → 403 entity_not_operable."""
    client = APIClient()
    _login(client, "+79990900004")
    _verify_esia(client, full_name="Кто-то Другой", tax_id="000000000001")

    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)
    assert entity["claim_status"] == "unclaimed"

    resp = client.patch(
        f"/v1/business-entities/{entity['id']}", {"tax_regime_code": "ru_usn"}, format="json"
    )
    assert resp.status_code == 403
    assert resp["Content-Type"].startswith("application/problem+json")
    assert resp.data["code"] == "entity_not_operable"


def test_get_business_entity_detail():
    client = APIClient()
    _login(client, "+79990900005")
    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    resp = client.get(f"/v1/business-entities/{entity['id']}")
    assert resp.status_code == 200
    assert resp.data["name"] == 'ООО "Ромашка"'


def test_get_business_entity_detail_unknown_id_is_404():
    client = APIClient()
    _login(client, "+79990900006")
    resp = client.get("/v1/business-entities/00000000-0000-7000-8000-000000000000")
    assert resp.status_code == 404


def test_claim_methods_lists_all_with_availability():
    client = APIClient()
    _login(client, "+79990900007")
    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    resp = client.get(f"/v1/business-entities/{entity['id']}/claim-methods")
    assert resp.status_code == 200
    by_method = {row["method"]: row["available"] for row in resp.data}
    assert by_method["director_identity_match"] is True
    assert by_method["owner_identity_match"] is True
    assert by_method["manual_review"] is True
    assert by_method["notarized_poa"] is False


def test_claim_unimplemented_method_is_422():
    client = APIClient()
    _login(client, "+79990900008")
    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    resp = client.post(
        f"/v1/business-entities/{entity['id']}/claim",
        {"method": "notarized_poa", "proof": {}},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "claim_method_not_available"


def test_claim_manual_review_sets_pending():
    client = APIClient()
    _login(client, "+79990900009")
    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    resp = client.post(
        f"/v1/business-entities/{entity['id']}/claim",
        {"method": "manual_review", "proof": {"comment": "это моя компания"}},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["claim_status"] == "pending"


def test_claim_owner_identity_match_without_verification_is_422():
    client = APIClient()
    _login(client, "+79990900010")
    entity = _onboard(client, FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)

    resp = client.post(
        f"/v1/business-entities/{entity['id']}/claim",
        {"method": "owner_identity_match"},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "claim_method_not_satisfied"


def test_update_business_entity_by_claimant_succeeds():
    client = APIClient()
    _login(client, "+79990900011")
    _verify_esia(
        client, full_name="Пётр Кузнецов", tax_id=FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN
    )
    entity = _onboard(client, FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)

    resp = client.patch(
        f"/v1/business-entities/{entity['id']}",
        {"tax_regime_code": "ru_npd"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["tax_regime_code"] == "ru_npd"


def test_claim_dispute_by_registry_director_wins():
    onboarder = APIClient()
    _login(onboarder, "+79990900012")
    entity = _onboard(onboarder, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    director_client = APIClient()
    _login(director_client, "+79990900013")
    _verify_esia(director_client, full_name="Иван Петрович Директоров", tax_id="222222222222")

    resp = director_client.post(
        f"/v1/business-entities/{entity['id']}/claim/dispute", {"proof": {}}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["claim_status"] == "claimed"
    assert resp.data["claim_method"] == "director_identity_match"


def test_list_epochs_returns_initial_epoch():
    client = APIClient()
    _login(client, "+79990900014")
    entity = _onboard(client, FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)

    resp = client.get(f"/v1/business-entities/{entity['id']}/epochs")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["epoch_number"] == 1
