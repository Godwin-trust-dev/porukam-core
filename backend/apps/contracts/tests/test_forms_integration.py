"""apps.contracts.forms — П-16 (docs/tasks/etap-4-delta-p16.md): интеграция
схем form_data с существующими create/patch черновика (Э4.1) и новым
GET /contract-types/{code}/form-schema — через API и через services.py
напрямую там, где так проще собрать сценарий (смена типа, кросс-типовые
предупреждения)."""

from __future__ import annotations

import re

import pytest
from rest_framework.test import APIClient

from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.contracts import forms, services
from apps.contracts.models import Contract, ContractParty
from apps.entities.models import BusinessEntity
from apps.profiles.models import Profile

pytestmark = pytest.mark.django_db

_ROLE = ContractParty.Role
_ACTING_AS = ContractParty.ActingAs


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> User:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    return User.objects.get(phone=phone)


def _person_profile(user: User) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility=Profile.Visibility.LINK_AND_DEALS,
    )


def _user(suffix: str) -> User:
    return User.objects.create(
        trust_id=f"trust-contracts-forms-{suffix}", phone=f"+7999089{suffix}"
    )


@pytest.fixture
def customer() -> User:
    return _user("0001")


@pytest.fixture
def contractor() -> User:
    return _user("0002")


_LOAN_MINIMAL = {
    "amount": "50000",
    "repayment_type": "lump_sum",
    "due_date": "2027-01-01",
    "transfer_method": "platform",
}


# --- GET /contract-types/{code}/form-schema ---------------------------------


@pytest.mark.parametrize(
    ("code", "phone_suffix"),
    [
        ("services_individual", "0111"),
        ("services_business", "0112"),
        ("sale_personal", "0113"),
        ("sale_business", "0114"),
        ("rent_items", "0115"),
        ("rent_home", "0116"),
        ("loan_individuals", "0117"),
    ],
)
def test_form_schema_endpoint_returns_sections_for_all_seven_r1_codes(code: str, phone_suffix: str):
    client = APIClient()
    _login(client, f"+7999089{phone_suffix}")
    resp = client.get(f"/v1/contract-types/{code}/form-schema")
    assert resp.status_code == 200, resp.content
    assert resp.data["code"] == ("services" if code.startswith("services_") else code)
    assert len(resp.data["sections"]) > 0


def test_form_schema_endpoint_loan_default_shows_interest_free_below_100k():
    client = APIClient()
    _login(client, "+79990890102")
    resp = client.get("/v1/contract-types/loan_individuals/form-schema")
    assert resp.status_code == 200, resp.content
    interest_section = next(s for s in resp.data["sections"] if s["key"] == "interest")
    interest_field = next(f for f in interest_section["fields"] if f["key"] == "interest_type")
    assert interest_field["default"]["if_lte"] == "interest_free"


def test_form_schema_endpoint_rent_home_default_term_is_11_months():
    client = APIClient()
    _login(client, "+79990890103")
    resp = client.get("/v1/contract-types/rent_home/form-schema")
    term_section = next(s for s in resp.data["sections"] if s["key"] == "term")
    term_field = next(f for f in term_section["fields"] if f["key"] == "term_months")
    assert term_field["default"] == 11


def test_form_schema_endpoint_sale_default_inspection_window_is_24_hours():
    client = APIClient()
    _login(client, "+79990890104")
    resp = client.get("/v1/contract-types/sale_personal/form-schema")
    inspection_section = next(s for s in resp.data["sections"] if s["key"] == "inspection")
    hours_field = next(
        f for f in inspection_section["fields"] if f["key"] == "inspection_window_hours"
    )
    assert hours_field["default"] == 24


def test_form_schema_endpoint_excluded_type_is_403():
    client = APIClient()
    _login(client, "+79990890105")
    resp = client.get("/v1/contract-types/shares_securities/form-schema")
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "contract_type_excluded"


def test_form_schema_endpoint_not_yet_supported_type_is_409():
    client = APIClient()
    _login(client, "+79990890106")
    resp = client.get("/v1/contract-types/sale_vehicle/form-schema")
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "not_yet_supported"


def test_form_schema_endpoint_unknown_code_is_404():
    client = APIClient()
    _login(client, "+79990890107")
    resp = client.get("/v1/contract-types/does-not-exist/form-schema")
    assert resp.status_code == 404, resp.content


# --- создание/патч через API: 422 с полями, предупреждения в ответе --------


def test_create_draft_loan_with_61_payment_schedule_is_422_with_field_error():
    customer_client = APIClient()
    _login(customer_client, "+79990890201")
    contractor_user = User.objects.create(trust_id="trust-contracts-forms-c1", phone="+79990890202")
    contractor_profile = _person_profile(contractor_user)
    schedule = [{"due_date": "2027-01-01", "amount": "820"} for _ in range(60)]
    schedule.append({"due_date": "2027-01-01", "amount": "1200"})

    resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "form_data": {
                "amount": "50000",
                "repayment_type": "schedule",
                "schedule": schedule,
                "transfer_method": "platform",
            },
        },
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "form_data_invalid"
    fields = {e["field"] for e in resp.data["context"]["errors"]}
    assert "schedule" in fields


def test_create_draft_sale_transport_company_without_address_is_422():
    customer_client = APIClient()
    _login(customer_client, "+79990890203")
    contractor_user = User.objects.create(trust_id="trust-contracts-forms-c2", phone="+79990890204")
    contractor_profile = _person_profile(contractor_user)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "sale_personal",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "form_data": {
                "category_code": "electronics",
                "item_name": "Смартфон",
                "item_description": "Новый, в коробке",
                "condition": "new",
                "identifiers": "IMEI 111222333444555",
                "price": "40000",
                "delivery_type": "transport_company",
                "delivery_deadline_type": "date",
                "delivery_date": "2026-09-10",
            },
        },
        format="json",
    )
    assert resp.status_code == 422, resp.content
    fields = {e["field"] for e in resp.data["context"]["errors"]}
    assert "delivery_address" in fields


def test_create_draft_with_cash_payment_returns_warning_but_saves():
    """Приёмка: «черновик с наличными → предупреждение в warnings, сохранение
    проходит»."""
    customer_client = APIClient()
    _login(customer_client, "+79990890205")
    contractor_user = User.objects.create(trust_id="trust-contracts-forms-c3", phone="+79990890206")
    contractor_profile = _person_profile(contractor_user)

    resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "payment_method": "cash",
            "form_data": _LOAN_MINIMAL,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert any(w["field"] == "payment_method" for w in resp.data["warnings"])
    assert resp.data["form_data"]["schema_version"] == 1
    # Отсмотр 2026-08-19: наружу — контракт фронта {field, code, message} с
    # ЧЕЛОВЕЧЕСКИМ текстом (раньше уходил {field, i18n_key}, и карточка
    # рисовала пустые буллеты «Замечаний»).
    cash_warning = next(w for w in resp.data["warnings"] if w["field"] == "payment_method")
    assert cash_warning["code"] == "contract_forms.cross.warning.no_evidence_base"
    assert "доказательная база" in cash_warning["message"]

    # Язык пользователя уважается (ADR-095: user.locale сильнее страны и
    # Accept-Language) — тот же черновик для en-пользователя приходит по-английски.
    User.objects.filter(phone="+79990890205").update(locale="en")
    resp_en = customer_client.get(f"/v1/contracts/{resp.data['id']}")
    assert resp_en.status_code == 200, resp_en.content
    warning_en = next(w for w in resp_en.data["warnings"] if w["field"] == "payment_method")
    assert "evidence base" in warning_en["message"]


def test_patch_draft_unknown_field_key_is_422():
    customer_client = APIClient()
    _login(customer_client, "+79990890207")
    contractor_user = User.objects.create(trust_id="trust-contracts-forms-c4", phone="+79990890208")
    contractor_profile = _person_profile(contractor_user)
    create_resp = customer_client.post(
        "/v1/contracts",
        {
            "contract_type_code": "loan_individuals",
            "my_role": "customer",
            "counterparty_profile_id": str(contractor_profile.id),
            "form_data": _LOAN_MINIMAL,
        },
        format="json",
    )
    contract_id = create_resp.data["id"]

    resp = customer_client.patch(
        f"/v1/contracts/{contract_id}",
        {"form_data": {**_LOAN_MINIMAL, "not_a_real_field": 1}},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    fields = {e["field"] for e in resp.data["context"]["errors"]}
    assert "not_a_real_field" in fields


# --- services.py: смена типа перевалидирует form_data по новой схеме -------


def test_patch_draft_type_change_revalidates_form_data_against_new_schema(
    customer: User, contractor: User
):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        form_data=_LOAN_MINIMAL,
    )
    assert contract.form_data["schema_version"] == 1

    # Займ -> Продажа: старый form_data ("amount"/"repayment_type"/...) не
    # проходит по новой схеме sale_personal — смена типа перевалидирует его.
    with pytest.raises(forms.FormValidationError) as excinfo:
        services.patch_draft(contract, user=customer, contract_type_code="sale_personal")
    fields = {e["field"] for e in excinfo.value.errors}
    assert "amount" in fields  # unknown_field для sale_personal


def test_patch_draft_type_change_with_empty_form_data_stays_exempt(
    customer: User, contractor: User
):
    """Совместимость: черновик без form_data (Э4.1/Э4.2) меняет тип без
    ошибок — форма конструктора ещё не заполнялась."""
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        client_option="service",
        counterparty_profile_id=contractor_profile.id,
    )
    contract = services.patch_draft(contract, user=customer, contract_type_code="loan_individuals")
    assert contract.form_data == {}


def test_patch_draft_type_change_with_compatible_form_data_succeeds(
    customer: User, contractor: User
):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
        form_data=_LOAN_MINIMAL,
    )
    contract = services.patch_draft(
        contract,
        user=customer,
        contract_type_code="loan_individuals",
        form_data={**_LOAN_MINIMAL, "amount": "75000"},
    )
    assert contract.form_data["amount"] == "75000"


# --- кросс-типовые предупреждения (compute_form_warnings) ------------------


def test_cross_type_warning_tax_agent_when_business_customer_and_person_contractor(
    customer: User, contractor: User
):
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Заказчик",
        created_by=customer,
        claim_status=BusinessEntity.ClaimStatus.CLAIMED,
        claimed_by=customer,
    )
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        my_acting_as=_ACTING_AS.BUSINESS,
        my_entity_id=entity.id,
        contract_type_code="services_business",
        counterparty_profile_id=contractor_profile.id,
    )
    warnings = forms.compute_form_warnings(contract)
    assert any(w["field"] == "counterparty" for w in warnings)


def test_cross_type_warning_absent_when_both_parties_are_persons(customer: User, contractor: User):
    contractor_profile = Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=contractor, profile_visibility="link_and_deals"
    )
    contract = services.create_draft(
        user=customer,
        my_role=_ROLE.CUSTOMER,
        contract_type_code="loan_individuals",
        counterparty_profile_id=contractor_profile.id,
    )
    warnings = forms.compute_form_warnings(contract)
    assert not any(w["field"] == "counterparty" for w in warnings)


# --- sphere_code — живой каталог, не статичный список ------------------------
# Отсмотр 2026-08-19: на проде каталог сфер расширен полным деревом
# (catalog-v2 / l10n-импорт), а sphere_code валидировался по захардкоженному
# списку из 7 сфер — мастер «Суть» падал 422 form_data_invalid на любой
# «новой» сфере. Источник choices — apps.catalog.Sphere (choices_resolver).


def _service_essence(sphere_code: str) -> dict:
    return {
        "sphere_code": sphere_code,
        "work_description": "Поклейка обоев",
        "location_type": "remote",
        "term_type": "relative_to_gate",
        "duration_days": 5,
        "price_type": "estimate",
    }


def test_sphere_beyond_static_fallback_list_is_valid_when_in_catalog():
    from apps.catalog.models import Sphere

    assert "beauty" not in forms.SPHERE_CODES  # именно «новая» сфера
    Sphere.objects.create(code="beauty", name_i18n={"ru": "Красота"}, is_active=True)
    cleaned, warnings = forms.validate_form_data(
        "services_individual", _service_essence("beauty"), deal_type=Contract.DealType.C2C
    )
    assert cleaned["sphere_code"] == "beauty"
    # «оценка по смете» — предупреждение, не ошибка (она и вскрыла дефект).
    assert any(w["field"] == "price_type" for w in warnings)


def test_inactive_sphere_is_rejected_as_invalid_choice():
    from apps.catalog.models import Sphere

    Sphere.objects.create(code="ghost_sphere", name_i18n={"ru": "Призрак"}, is_active=False)
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data(
            "services_individual", _service_essence("ghost_sphere"), deal_type=Contract.DealType.C2C
        )
    assert any(
        e["field"] == "sphere_code" and e["code"] == "invalid_choice" for e in excinfo.value.errors
    )


def test_form_schema_serializes_live_sphere_choices():
    from apps.catalog.models import Sphere

    Sphere.objects.create(code="beauty", name_i18n={"ru": "Красота"}, is_active=True)
    schema = forms.serialize_schema(forms.get_form_schema("services_individual"))
    sphere_field = next(
        f for s in schema["sections"] for f in s["fields"] if f["key"] == "sphere_code"
    )
    assert "beauty" in sphere_field["choices"]
