import re

import pytest
from django.apps import apps as django_apps
from django.conf import settings
from rest_framework.test import APIClient

from apps.accounts import services as accounts_services
from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.social import hashing
from apps.social import services as social_services
from apps.social.models import Consent

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


# --- handles (etap-3.md 3.3 приёмка) ----------------------------------------


def test_claim_handle_and_public_lookup_without_auth():
    client = APIClient()
    _login(client, "+79990820001")
    resp = client.post("/v1/users/me/handle", {"value": "ivan_master"}, format="json")
    assert resp.status_code == 200, resp.content

    anon = APIClient()
    resp = anon.get("/v1/handles/ivan_master")
    assert resp.status_code == 200, resp.content
    assert resp.data["handle"] == "ivan_master"
    assert "trust_id" not in resp.data


def test_public_handle_lookup_returns_profile_id_for_reputation_card():
    """ADR-093: `/@handle` — публичный маршрут карточки репутации, а сама
    карточка ключуется `profile_id` (`GET /reputation/profiles/{id}/card`).
    Без этого поля хендл не разрешается в profile_id ничем — фронт не может
    открыть карточку по ссылке-хендлу вообще."""
    client = APIClient()
    _login(client, "+79990820011")
    resp = client.post("/v1/users/me/handle", {"value": "kartochka"}, format="json")
    assert resp.status_code == 200, resp.content
    # person-профиль заводится при регистрации (apps.profiles.subscriber);
    # POST идемпотентен и возвращает уже существующий — apps.social НЕ имеет
    # права импортировать apps.profiles даже в тесте (import-linter).
    profile_id = client.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]

    anon = APIClient()
    resp = anon.get("/v1/handles/kartochka")
    assert resp.status_code == 200, resp.content
    assert resp.data["profile_id"] == str(profile_id)


def test_group_handle_has_no_profile_id():
    """Хендл объединения не разрешается в person-профиль — честный `null`,
    не выдуманный id (карточка репутации у объединений своя, вне ГВ.4)."""
    client = APIClient()
    _login(client, "+79990820012")
    resp = client.post(
        "/v1/groups",
        {"kind": "community", "name": "Сообщество", "handle": "brigada_x", "sphere_code": "it"},
        format="json",
    )
    assert resp.status_code == 201, resp.content

    anon = APIClient()
    resp = anon.get("/v1/handles/brigada_x")
    assert resp.status_code == 200, resp.content
    assert resp.data["kind"] == "group"
    assert resp.data["profile_id"] is None
    # ADR-117 §6: групповой хендл разрешается в карточку объединения.
    assert resp.data["group_id"] is not None
    assert resp.data["group_name"] == "Сообщество"


def test_public_handle_lookup_unknown_is_404():
    anon = APIClient()
    resp = anon.get("/v1/handles/nobody-here")
    assert resp.status_code == 404


def test_claim_handle_taken_is_409():
    client_a = APIClient()
    _login(client_a, "+79990820002")
    client_a.post("/v1/users/me/handle", {"value": "shared"}, format="json")

    client_b = APIClient()
    _login(client_b, "+79990820003")
    resp = client_b.post("/v1/users/me/handle", {"value": "shared"}, format="json")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "handle_taken"


# --- handle-поиск контрагента (GET /v1/handles?q=) ---------------------------


def test_handle_search_requires_authentication():
    resp = APIClient().get("/v1/handles", {"q": "iva"})
    assert resp.status_code == 401


def test_handle_search_returns_prefix_matches_in_wizard_shape():
    other = User.objects.create(trust_id="trust-api-search-1", phone="+79990830001")
    accounts_services.update_profile(other, full_name="Иван Мастеров")
    social_services.claim_handle(user=other, value="ivan_master")

    me = User.objects.create(trust_id="trust-api-search-me", phone="+79990830002")
    client = APIClient()
    client.force_authenticate(user=me)

    resp = client.get("/v1/handles", {"q": "@IVA"})

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == [
        {
            "user_id": str(other.id),
            "handle": "@ivan_master",
            "display_name": "Иван Мастеров",
            "kind": "person",
            "verification_level": "guest",
        }
    ]


def test_handle_search_does_not_return_self():
    me = User.objects.create(trust_id="trust-api-search-self", phone="+79990830003")
    social_services.claim_handle(user=me, value="ivan_self")
    client = APIClient()
    client.force_authenticate(user=me)

    resp = client.get("/v1/handles", {"q": "ivan"})

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


def test_handle_search_empty_query_is_empty_list_not_error():
    me = User.objects.create(trust_id="trust-api-search-empty", phone="+79990830004")
    client = APIClient()
    client.force_authenticate(user=me)

    for params in ({}, {"q": ""}, {"q": "i"}, {"q": "@"}):
        resp = client.get("/v1/handles", params)
        assert resp.status_code == 200, resp.content
        assert resp.data["results"] == []


def test_handle_search_honours_limit_and_bad_limit_falls_back():
    for ix in range(3):
        user = User.objects.create(trust_id=f"trust-api-search-lim-{ix}", phone=f"+7999083100{ix}")
        social_services.claim_handle(user=user, value=f"ivan_lim_{ix}")

    me = User.objects.create(trust_id="trust-api-search-lim-me", phone="+79990831009")
    client = APIClient()
    client.force_authenticate(user=me)

    assert len(client.get("/v1/handles", {"q": "ivan", "limit": "2"}).data["results"]) == 2
    # limit-мусор не 400: поиск-подсказка не должна ломаться от кривого параметра.
    resp = client.get("/v1/handles", {"q": "ivan", "limit": "не-число"})
    assert resp.status_code == 200, resp.content
    assert len(resp.data["results"]) == 3


def test_handle_search_business_kind_and_missing_name():
    other = User.objects.create(
        trust_id="trust-api-search-biz", phone="+79990832001", has_business_status=True
    )
    social_services.claim_handle(user=other, value="ivan_biz")

    me = User.objects.create(trust_id="trust-api-search-biz-me", phone="+79990832002")
    client = APIClient()
    client.force_authenticate(user=me)

    resp = client.get("/v1/handles", {"q": "ivan"})

    assert resp.status_code == 200, resp.content
    entry = resp.data["results"][0]
    assert entry["kind"] == "business"
    # ФИО не заполнено — пустая строка, не null (фронт покажет хендл).
    assert entry["display_name"] == ""


def test_handle_search_never_exposes_private_fields():
    other = User.objects.create(
        trust_id="trust-api-search-private",
        phone="+79990833001",
        email="ivan@example.test",
    )
    social_services.claim_handle(user=other, value="ivan_private")

    me = User.objects.create(trust_id="trust-api-search-private-me", phone="+79990833002")
    client = APIClient()
    client.force_authenticate(user=me)

    resp = client.get("/v1/handles", {"q": "ivan"})

    body = resp.content.decode()
    assert "trust-api-search-private" not in body
    assert "+79990833001" not in body
    assert "ivan@example.test" not in body


# --- contacts privacy --------------------------------------------------------


def test_contacts_list_requires_authentication():
    resp = APIClient().get("/v1/users/me/contacts")
    assert resp.status_code == 401


def test_someone_elses_contact_is_404_not_403():
    owner_client = APIClient()
    _login(owner_client, "+79990820004")
    other = User.objects.create(trust_id="trust-social-api-other", phone="+79990820005")

    created = owner_client.post(
        "/v1/users/me/contacts", {"target_user_id": str(other.id)}, format="json"
    )
    assert created.status_code == 201, created.content

    intruder_client = APIClient()
    _login(intruder_client, "+79990820006")
    resp = intruder_client.delete(f"/v1/users/me/contacts/{created.data['id']}")
    assert resp.status_code == 404


def test_contacts_list_row_carries_handle_name_and_profile_id():
    """Отсмотр 2026-08-22 «пустой справочник»: строка справочника несёт
    хендл (с «@»), ФИО контрагента и profile_id карточки репутации; без
    хендла/имени — null/""."""
    owner_client = APIClient()
    _login(owner_client, "+79990820014")
    other_client = APIClient()
    _login(other_client, "+79990820015")
    other = User.objects.get(phone="+79990820015")
    social_services.claim_handle(user=other, value="contact_row_15")
    accounts_services.update_profile(other, full_name="Контакт Пятнадцатый")

    created = owner_client.post(
        "/v1/users/me/contacts", {"target_handle": "contact_row_15"}, format="json"
    )
    assert created.status_code == 201, created.content

    rows = owner_client.get("/v1/users/me/contacts").data
    assert len(rows) == 1
    row = rows[0]
    assert row["target_handle"] == "@contact_row_15"
    assert row["target_display_name"] == "Контакт Пятнадцатый"
    assert str(row["target_user"]) == str(other.id)
    assert "target_profile_id" in row


def test_contacts_row_carries_counterparty_avatar():
    """ADR-173 (владелец 08.09): фото контрагента и в справочнике контактов.
    Видимость решает apps.profiles (ADR-103) — deals_only без завершённой
    сделки остаётся null, строка рисует инициалы."""
    owner_client = APIClient()
    _login(owner_client, "+79990820016")
    other_client = APIClient()
    _login(other_client, "+79990820017")
    other = User.objects.get(phone="+79990820017")
    social_services.claim_handle(user=other, value="contact_row_16")
    # Профиль — через apps.get_model: apps.social (и его тесты) не имеет
    # права импортировать apps.profiles (import-linter, «social зависит
    # только от accounts»), сериализатор ходит туда settings-селектором.
    profile_model = django_apps.get_model("profiles", "Profile")
    profile = profile_model.objects.create(
        kind="person",
        owner_user=other,
        profile_visibility="public",
        avatar_visibility="deals_only",
        avatar_key="avatars/contact/0198ee00",
    )
    created = owner_client.post(
        "/v1/users/me/contacts", {"target_handle": "contact_row_16"}, format="json"
    )
    assert created.status_code == 201, created.content

    row = owner_client.get("/v1/users/me/contacts").data[0]
    assert row["target_avatar_url"] is None

    profile.avatar_visibility = "public"
    profile.save(update_fields=["avatar_visibility"])
    row = owner_client.get("/v1/users/me/contacts").data[0]
    assert str(profile.id) in row["target_avatar_url"]


# --- phonebook (etap-3.md 3.3 приёмка + дельта §1.5) -------------------------


def test_phonebook_upload_raw_number_is_422():
    client = APIClient()
    _login(client, "+79990820007")
    resp = client.post(
        "/v1/users/me/phonebook",
        {"hashes": ["+79990000000"], "algorithm": hashing.ALGORITHM, "salt_ref": hashing.SALT_REF},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_phonebook_hash"


def test_phonebook_upload_valid_hash_of_discoverable_user_matches():
    finder = APIClient()
    _login(finder, "+79990820008")

    target_client = APIClient()
    target_tokens = _login(target_client, "+79990820009")
    target = User.objects.get(phone="+79990820009")
    target_client.post(
        "/v1/users/me/privacy-consents",
        {"pd_processing": True, "profile_public": True, "phone_discoverability": True},
        format="json",
    )
    assert target_tokens

    resp = finder.post(
        "/v1/users/me/phonebook",
        {
            "hashes": [hashing.phone_hash(target.phone)],
            "algorithm": hashing.ALGORITHM,
            "salt_ref": hashing.SALT_REF,
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert [m["user_id"] for m in resp.data] == [str(target.id)]


# --- privacy-consents (docs/tasks/etap-3-delta-adr059.md §1.1, §2 тест 2) ----


def test_privacy_consents_requires_all_three_fields():
    client = APIClient()
    _login(client, "+79990820010")
    resp = client.post(
        "/v1/users/me/privacy-consents",
        {"pd_processing": True, "profile_public": True},
        format="json",
    )
    assert resp.status_code == 400, resp.content


def test_privacy_consents_without_pd_processing_is_422():
    client = APIClient()
    _login(client, "+79990820011")
    resp = client.post(
        "/v1/users/me/privacy-consents",
        {"pd_processing": False, "profile_public": True, "phone_discoverability": True},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "pd_processing_consent_required"


def test_privacy_consents_completes_registration_step():
    client = APIClient()
    _login(client, "+79990820012")
    resp = client.post(
        "/v1/users/me/privacy-consents",
        {"pd_processing": True, "profile_public": False, "phone_discoverability": False},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["completed"] is True
    assert resp.data["profile_public"] is False


# --- privacy-consents-global (ГВ.2, docs/tasks/global-wave.md, ADR-071) -----


def _google_login(client: APIClient, *, sub: str, email: str) -> dict:
    resp = client.get("/v1/auth/google/authorize-url")
    state = resp.data["state"]
    resp = client.post(
        "/v1/auth/google/callback", {"code": f"{sub}|{email}", "state": state}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return resp.data


def test_global_privacy_consents_requires_all_four_fields():
    client = APIClient()
    _google_login(client, sub="privacy-sub-001", email="p1@example.test")
    resp = client.post(
        "/v1/users/me/privacy-consents-global",
        {"pd_processing": True, "profile_public": True, "phone_discoverability": True},
        format="json",
    )
    assert resp.status_code == 400, resp.content


def test_global_privacy_consents_without_pd_processing_is_422():
    client = APIClient()
    _google_login(client, sub="privacy-sub-002", email="p2@example.test")
    resp = client.post(
        "/v1/users/me/privacy-consents-global",
        {
            "pd_processing": False,
            "profile_public": True,
            "phone_discoverability": True,
            "reputation_history_basis": True,
        },
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "pd_processing_consent_required"


def test_global_privacy_consents_step_returns_four_english_consents():
    """✅ ГВ.2 приёмка: «шаг согласий отдаёт 4 согласия EN»."""
    client = APIClient()
    _google_login(client, sub="privacy-sub-003", email="p3@example.test")
    resp = client.post(
        "/v1/users/me/privacy-consents-global",
        {
            "pd_processing": True,
            "profile_public": False,
            "phone_discoverability": False,
            "reputation_history_basis": True,
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["completed"] is True
    assert set(resp.data.keys()) == {
        "pd_processing",
        "profile_public",
        "phone_discoverability",
        "reputation_history_basis",
        "completed",
    }
    assert resp.data["reputation_history_basis"] is True

    consent = Consent.objects.filter(consent_type=Consent.ConsentType.PD_PROCESSING).latest(
        "granted_at"
    )
    assert consent.text_version == settings.CONSENT_TEXT_VERSIONS["pd_processing"]["en"]
