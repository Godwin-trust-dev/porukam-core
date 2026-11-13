"""apps.contracts.forms — П-16 (docs/tasks/etap-4-delta-p16.md): реестр схем
form_data по семи кодам Р1. Юнит-уровень движка валидации (без БД) — по
каждому типу: минимальный валидный набор проходит, каждая жёсткая валидация
ломается отдельным тестом (422 с полем), условные поля, неизвестный ключ,
предупреждения не блокируют сохранение."""

from __future__ import annotations

import pytest

from apps.contracts import forms
from apps.contracts.models import Contract

_C2C = Contract.DealType.C2C
_B2C = Contract.DealType.B2C


def _errors_by_field(exc: forms.FormValidationError) -> set[str]:
    return {e["field"] for e in exc.errors}


# --- пустой form_data валиден для любого типа (совместимость с Э4.1/Э4.2) --


@pytest.mark.parametrize(
    "code",
    [
        "services_individual",
        "services_business",
        "sale_personal",
        "sale_business",
        "rent_items",
        "rent_home",
        "loan_individuals",
    ],
)
def test_empty_form_data_is_valid_for_any_type(code: str):
    cleaned, warnings = forms.validate_form_data(code, {}, deal_type=_C2C)
    assert cleaned == {}
    assert warnings == []


def test_unknown_code_raises_schema_not_found():
    with pytest.raises(forms.FormSchemaNotFoundError):
        forms.get_form_schema("sale_vehicle")


# --- неизвестный ключ -------------------------------------------------------


def test_unknown_field_key_is_rejected():
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data(
            "services_individual", {"totally_made_up_field": "x"}, deal_type=_C2C
        )
    assert "totally_made_up_field" in _errors_by_field(excinfo.value)


# --- 🔧 УСЛУГА ---------------------------------------------------------------

_SERVICE_MINIMAL = {
    "sphere_code": "renovation",
    "work_description": "Поклейка обоев в гостиной",
    "location_type": "remote",
    "term_type": "relative_to_gate",
    "duration_days": 14,
    "price_type": "fixed",
}


@pytest.mark.parametrize("code", ["services_individual", "services_business"])
def test_service_minimal_valid_passes(code: str):
    cleaned, warnings = forms.validate_form_data(code, _SERVICE_MINIMAL, deal_type=_C2C)
    assert cleaned["schema_version"] == 1
    assert cleaned["warranty_period_days"] == 14
    assert cleaned["acceptance_window_hours"] == 72
    assert warnings == []


@pytest.mark.parametrize(
    "missing_key",
    ["sphere_code", "work_description", "term_type", "price_type"],
)
def test_service_missing_required_field_fails(missing_key: str):
    data = {k: v for k, v in _SERVICE_MINIMAL.items() if k != missing_key}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert missing_key in _errors_by_field(excinfo.value)


def test_service_onsite_requires_address():
    data = {**_SERVICE_MINIMAL, "location_type": "onsite"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert "location_address" in _errors_by_field(excinfo.value)

    data["location_address"] = "г. Москва, ул. Ленина, 1"
    cleaned, _warnings = forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert cleaned["location_address"] == "г. Москва, ул. Ленина, 1"


def test_service_dates_term_requires_start_and_end_in_order():
    data = {**_SERVICE_MINIMAL, "term_type": "dates"}
    del data["duration_days"]
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert {"start_date", "end_date"} <= _errors_by_field(excinfo.value)

    data["start_date"] = "2026-09-10"
    data["end_date"] = "2026-09-01"
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert "end_date" in _errors_by_field(excinfo.value)


def test_service_estimate_price_warns_but_saves():
    data = {**_SERVICE_MINIMAL, "price_type": "estimate"}
    cleaned, warnings = forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert cleaned["price_type"] == "estimate"
    assert any(w["field"] == "price_type" for w in warnings)


def test_service_milestone_section_is_marker_only_unknown_in_form_data():
    """Границы дельты: дерево этапов — не поле формы (Milestone, Э4.3)."""
    data = {**_SERVICE_MINIMAL, "milestones": [{"title": "Этап 1"}]}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("services_individual", data, deal_type=_C2C)
    assert "milestones" in _errors_by_field(excinfo.value)


# --- 📦 ПРОДАЖА ---------------------------------------------------------------

_SALE_MINIMAL_PICKUP = {
    "category_code": "furniture_interior",
    "item_name": "Диван угловой",
    "item_description": "Б/у диван в хорошем состоянии",
    "condition": "used",
    "condition_defects_description": "Небольшая потёртость подлокотника",
    "price": "15000",
    "delivery_type": "pickup",
    "delivery_deadline_type": "relative_to_payment",
    "delivery_days": 2,
}


@pytest.mark.parametrize("code", ["sale_personal", "sale_business"])
def test_sale_minimal_valid_pickup_passes(code: str):
    cleaned, _warnings = forms.validate_form_data(code, _SALE_MINIMAL_PICKUP, deal_type=_C2C)
    assert cleaned["schema_version"] == 1
    assert cleaned["inspection_window_hours"] == 24


# Расширение категорий товара (2026-08-25): продукты питания, животные,
# автозапчасти, стройматериалы, для дома, украшения, хендмейд, оборудование.
# Транспорт и недвижимость — НЕ категории (special-типы, catalog-v2.md).
_NEW_SALE_CATEGORY_CODES = (
    "food",
    "pets",
    "auto_parts",
    "building_materials",
    "household",
    "jewelry_watches",
    "handmade_collectibles",
    "business_equipment",
)


@pytest.mark.parametrize("category_code", _NEW_SALE_CATEGORY_CODES)
@pytest.mark.parametrize("code", ["sale_personal", "sale_business"])
def test_sale_new_category_codes_accepted(code: str, category_code: str):
    data = {**_SALE_MINIMAL_PICKUP, "category_code": category_code}
    cleaned, _warnings = forms.validate_form_data(code, data, deal_type=_C2C)
    assert cleaned["category_code"] == category_code
    # Идентификаторы обязательны только для электроники — новые категории их не требуют.
    assert "identifiers" not in cleaned


def test_sale_unknown_category_code_rejected():
    data = {**_SALE_MINIMAL_PICKUP, "category_code": "vehicles"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert "category_code" in _errors_by_field(excinfo.value)


def test_sale_category_codes_other_is_last_and_unique():
    assert forms.SALE_CATEGORY_CODES[-1] == "other"
    assert len(set(forms.SALE_CATEGORY_CODES)) == len(forms.SALE_CATEGORY_CODES)
    assert set(_NEW_SALE_CATEGORY_CODES) <= set(forms.SALE_CATEGORY_CODES)


def test_sale_household_plot_only_valid_for_sale_personal():
    data = {**_SALE_MINIMAL_PICKUP, "own_household_plot": True}
    cleaned, _warnings = forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert cleaned["own_household_plot"] is True

    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("sale_business", data, deal_type=_C2C)
    assert "own_household_plot" in _errors_by_field(excinfo.value)


def test_sale_used_without_defects_description_fails():
    data = dict(_SALE_MINIMAL_PICKUP)
    del data["condition_defects_description"]
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert "condition_defects_description" in _errors_by_field(excinfo.value)


def test_sale_electronics_requires_identifiers():
    data = {**_SALE_MINIMAL_PICKUP, "category_code": "electronics", "condition": "new"}
    del data["condition_defects_description"]
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert "identifiers" in _errors_by_field(excinfo.value)

    data["identifiers"] = "IMEI 123456789012345"
    cleaned, _warnings = forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert cleaned["identifiers"] == "IMEI 123456789012345"


def test_sale_pickup_does_not_require_delivery_address():
    """Приёмка: «самовывоз — адрес не требуется»."""
    cleaned, _warnings = forms.validate_form_data(
        "sale_personal", _SALE_MINIMAL_PICKUP, deal_type=_C2C
    )
    assert "delivery_address" not in cleaned


def test_sale_transport_company_without_address_fails():
    """Приёмка: «ТК без адреса → 422»."""
    data = {
        **_SALE_MINIMAL_PICKUP,
        "delivery_type": "transport_company",
        "delivery_deadline_type": "date",
        "delivery_date": "2026-09-01",
    }
    del data["delivery_days"]
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    fields = _errors_by_field(excinfo.value)
    assert "delivery_address" in fields
    assert "delivery_payer" in fields

    data["delivery_address"] = "г. Москва, склад ТК"
    data["delivery_payer"] = "buyer"
    cleaned, _warnings = forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert cleaned["delivery_address"] == "г. Москва, склад ТК"


def test_sale_used_without_photos_warns():
    cleaned, warnings = forms.validate_form_data(
        "sale_personal", _SALE_MINIMAL_PICKUP, deal_type=_C2C
    )
    assert any(w["field"] == "photos" for w in warnings)

    data = {**_SALE_MINIMAL_PICKUP, "photos": ["https://example.test/photo.jpg"]}
    _cleaned, warnings = forms.validate_form_data("sale_personal", data, deal_type=_C2C)
    assert not any(w["field"] == "photos" for w in warnings)


# --- 🏠 АРЕНДА → Вещи ---------------------------------------------------------

_RENT_ITEMS_MINIMAL = {
    "item_name": "Перфоратор Bosch",
    "item_identification": "с/н AB123456",
    "declared_value": "8000",
    "term_type": "daily",
    "start_date": "2026-09-01",
    "rent_amount": "500",
    "rent_period": "day",
    "handover_place": "г. Москва, ул. Ленина, 1",
    "return_place": "г. Москва, ул. Ленина, 1",
}


def test_rent_items_minimal_valid_passes():
    cleaned, _warnings = forms.validate_form_data("rent_items", _RENT_ITEMS_MINIMAL, deal_type=_C2C)
    assert cleaned["risk_transfer_enabled"] is True


@pytest.mark.parametrize(
    "missing_key",
    ["item_name", "item_identification", "declared_value", "rent_amount", "handover_place"],
)
def test_rent_items_missing_required_field_fails(missing_key: str):
    data = {k: v for k, v in _RENT_ITEMS_MINIMAL.items() if k != missing_key}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_items", data, deal_type=_C2C)
    assert missing_key in _errors_by_field(excinfo.value)


def test_rent_items_date_range_requires_end_date():
    data = {**_RENT_ITEMS_MINIMAL, "term_type": "date_range"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_items", data, deal_type=_C2C)
    assert "end_date" in _errors_by_field(excinfo.value)


def test_rent_items_b2c_non_refundable_deposit_is_blocked():
    data = {**_RENT_ITEMS_MINIMAL, "deposit_non_refundable": True}
    cleaned, _warnings = forms.validate_form_data("rent_items", data, deal_type=_C2C)
    assert cleaned["deposit_non_refundable"] is True  # C2C — не блокируется

    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_items", data, deal_type=_B2C)
    assert "deposit_non_refundable" in _errors_by_field(excinfo.value)


# --- 🏠 АРЕНДА → Жильё --------------------------------------------------------

_RENT_HOME_MINIMAL = {
    "address": "г. Москва, ул. Ленина, 1, кв. 2",
    "object_type": "apartment",
    "disposal_basis_type": "owner",
    "disposal_basis_document": "Выписка ЕГРН №123 от 01.01.2026",
    "rent_amount": "30000",
    "rent_payment_day": 5,
    "utilities_mode": "included",
    "occupants": ["Иванов Иван Иванович"],
}


def test_rent_home_minimal_valid_passes():
    cleaned, warnings = forms.validate_form_data("rent_home", _RENT_HOME_MINIMAL, deal_type=_C2C)
    # Обратная совместимость (отсмотр 2026-08-24): в сохранённых form_data
    # term_kind нет — дефолт long_term, term_months по-прежнему 11.
    assert cleaned["term_kind"] == "long_term"
    assert cleaned["term_months"] == 11
    assert any(w["field"] == "inventory_list" for w in warnings)
    assert any(w["field"] == "meter_readings" for w in warnings)


def test_rent_home_short_term_requires_days():
    data = {**_RENT_HOME_MINIMAL, "term_kind": "short_term"}
    with pytest.raises(forms.FormValidationError) as exc:
        forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert any(e["field"] == "term_days" and e["code"] == "required" for e in exc.value.errors)


def test_rent_home_short_term_with_days_valid_and_no_months_injected():
    data = {**_RENT_HOME_MINIMAL, "term_kind": "short_term", "term_days": 3}
    cleaned, _ = forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert cleaned["term_days"] == 3
    # Дефолт невидимого поля не подставляется — у краткосрочной аренды
    # не должно молча появляться term_months=11.
    assert "term_months" not in cleaned


def test_rent_home_short_term_one_day_allowed():
    data = {**_RENT_HOME_MINIMAL, "term_kind": "short_term", "term_days": 1}
    cleaned, _ = forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert cleaned["term_days"] == 1


def test_rent_home_long_term_months_still_optional():
    data = {**_RENT_HOME_MINIMAL, "term_kind": "long_term"}
    cleaned, _ = forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert cleaned["term_months"] == 11
    assert "term_days" not in cleaned


@pytest.mark.parametrize(
    "missing_key",
    [
        "address",
        "disposal_basis_type",
        "disposal_basis_document",
        "rent_amount",
        "rent_payment_day",
        "utilities_mode",
        "occupants",
    ],
)
def test_rent_home_missing_required_field_fails(missing_key: str):
    data = {k: v for k, v in _RENT_HOME_MINIMAL.items() if k != missing_key}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert missing_key in _errors_by_field(excinfo.value)


def test_rent_home_payment_day_out_of_range_fails():
    data = {**_RENT_HOME_MINIMAL, "rent_payment_day": 32}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert "rent_payment_day" in _errors_by_field(excinfo.value)


def test_rent_home_fixed_utilities_requires_amount():
    data = {**_RENT_HOME_MINIMAL, "utilities_mode": "fixed"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert "utilities_fixed_amount" in _errors_by_field(excinfo.value)


def test_rent_home_long_term_warns_about_registration():
    data = {**_RENT_HOME_MINIMAL, "term_months": 12}
    _cleaned, warnings = forms.validate_form_data("rent_home", data, deal_type=_C2C)
    assert any(w["field"] == "term_months" for w in warnings)


def test_rent_home_b2c_non_refundable_deposit_is_blocked():
    data = {**_RENT_HOME_MINIMAL, "deposit_non_refundable": True}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("rent_home", data, deal_type=_B2C)
    assert "deposit_non_refundable" in _errors_by_field(excinfo.value)


# --- 💰 ЗАЙМ -------------------------------------------------------------------

_LOAN_MINIMAL_LUMP_SUM = {
    "amount": "50000",
    "repayment_type": "lump_sum",
    "due_date": "2027-01-01",
    "transfer_method": "platform",
}


def test_loan_minimal_valid_lump_sum_passes():
    cleaned, _warnings = forms.validate_form_data(
        "loan_individuals", _LOAN_MINIMAL_LUMP_SUM, deal_type=_C2C
    )
    assert cleaned["interest_type"] == "interest_free"  # дефолт при сумме <= 100 тыс
    assert cleaned["early_repayment_allowed"] is True


def test_loan_interest_type_default_depends_on_amount():
    small = {**_LOAN_MINIMAL_LUMP_SUM, "amount": "100000"}
    cleaned, _warnings = forms.validate_form_data("loan_individuals", small, deal_type=_C2C)
    assert cleaned["interest_type"] == "interest_free"

    # Сумма выше порога -> дефолт "rate" -> ставка становится обязательной.
    big = {**_LOAN_MINIMAL_LUMP_SUM, "amount": "150000"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("loan_individuals", big, deal_type=_C2C)
    assert "interest_rate_percent" in _errors_by_field(excinfo.value)
    assert "total_interest_amount" in _errors_by_field(excinfo.value)

    big["interest_rate_percent"] = "10"
    big["total_interest_amount"] = "15000"
    cleaned, _warnings = forms.validate_form_data("loan_individuals", big, deal_type=_C2C)
    assert cleaned["interest_type"] == "rate"


def test_loan_usurious_rate_warns():
    data = {
        **_LOAN_MINIMAL_LUMP_SUM,
        "interest_type": "rate",
        "interest_rate_percent": "50",
        "total_interest_amount": "25000",
    }
    _cleaned, warnings = forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert any(w["field"] == "interest_rate_percent" for w in warnings)


def test_loan_off_platform_transfer_requires_confirmation_and_warns():
    data = {**_LOAN_MINIMAL_LUMP_SUM, "transfer_method": "off_platform"}
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert "transfer_confirmation_note" in _errors_by_field(excinfo.value)

    data["transfer_confirmation_note"] = "Расписка от 01.01.2026"
    _cleaned, warnings = forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert any(w["field"] == "transfer_method" for w in warnings)


def test_loan_schedule_required_when_repayment_type_is_schedule():
    data = {**_LOAN_MINIMAL_LUMP_SUM, "repayment_type": "schedule"}
    del data["due_date"]
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert "schedule" in _errors_by_field(excinfo.value)


def test_loan_schedule_over_60_payments_fails():
    """Приёмка: «график 61 платёж → 422»."""
    schedule = [{"due_date": "2027-01-01", "amount": "820"} for _ in range(60)]
    schedule.append({"due_date": "2027-01-01", "amount": "1200"})
    assert len(schedule) == 61
    data = {
        "amount": "50000",
        "repayment_type": "schedule",
        "schedule": schedule,
        "transfer_method": "platform",
    }
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert "schedule" in _errors_by_field(excinfo.value)
    assert any(e["code"] == "too_many_payments" for e in excinfo.value.errors)


def test_loan_schedule_sum_mismatch_fails():
    """Приёмка: «Σ графика ≠ сумма + проценты → 422»."""
    data = {
        "amount": "50000",
        "repayment_type": "schedule",
        "schedule": [
            {"due_date": "2026-10-01", "amount": "20000"},
            {"due_date": "2026-11-01", "amount": "20000"},
        ],  # 40000 != 50000
        "transfer_method": "platform",
    }
    with pytest.raises(forms.FormValidationError) as excinfo:
        forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert any(e["code"] == "sum_mismatch" for e in excinfo.value.errors)


def test_loan_schedule_sum_matches_amount_when_interest_free():
    data = {
        "amount": "50000",
        "repayment_type": "schedule",
        "schedule": [
            {"due_date": "2026-10-01", "amount": "25000"},
            {"due_date": "2026-11-01", "amount": "25000"},
        ],
        "transfer_method": "platform",
    }
    cleaned, _warnings = forms.validate_form_data("loan_individuals", data, deal_type=_C2C)
    assert cleaned["interest_type"] == "interest_free"


def test_loan_written_form_warning_above_10000():
    _cleaned, warnings = forms.validate_form_data(
        "loan_individuals", _LOAN_MINIMAL_LUMP_SUM, deal_type=_C2C
    )
    assert any(w["field"] == "amount" for w in warnings)


# --- GET .../form-schema: сериализация -------------------------------------


@pytest.mark.parametrize(
    "code",
    [
        "services_individual",
        "services_business",
        "sale_personal",
        "sale_business",
        "rent_items",
        "rent_home",
        "loan_individuals",
    ],
)
def test_serialize_schema_lists_sections_in_declared_order(code: str):
    schema = forms.get_form_schema(code)
    payload = forms.serialize_schema(schema)
    assert payload["code"] == schema.code
    # Версия — из самой схемы (rent_home ушёл на v2 переключателем срока,
    # 2026-08-24), тест проверяет согласованность, а не конкретное число.
    assert payload["schema_version"] == schema.version
    assert [s["key"] for s in payload["sections"]] == [s.key for s in schema.sections]


def test_serialize_schema_loan_interest_default_is_conditional():
    payload = forms.serialize_schema(forms.get_form_schema("loan_individuals"))
    interest_section = next(s for s in payload["sections"] if s["key"] == "interest")
    interest_type_field = next(f for f in interest_section["fields"] if f["key"] == "interest_type")
    assert interest_type_field["default"] == {
        "depends_on": "amount",
        "threshold": "100000",
        "if_lte": "interest_free",
        "if_gt": "rate",
    }


def test_serialize_schema_rent_home_term_default_is_11_months():
    payload = forms.serialize_schema(forms.get_form_schema("rent_home"))
    term_section = next(s for s in payload["sections"] if s["key"] == "term")
    term_months_field = next(f for f in term_section["fields"] if f["key"] == "term_months")
    assert term_months_field["default"] == 11


def test_serialize_schema_sale_inspection_window_default_is_24_hours():
    payload = forms.serialize_schema(forms.get_form_schema("sale_personal"))
    inspection_section = next(s for s in payload["sections"] if s["key"] == "inspection")
    hours_field = next(
        f for f in inspection_section["fields"] if f["key"] == "inspection_window_hours"
    )
    assert hours_field["default"] == 24


@pytest.mark.parametrize("code", ["sale_personal", "sale_business"])
def test_serialize_schema_sale_category_choices_match_codes(code: str):
    """Фронт строит select из тех же кодов — choices схемы = SALE_CATEGORY_CODES."""
    payload = forms.serialize_schema(forms.get_form_schema(code))
    category_section = next(s for s in payload["sections"] if s["key"] == "category")
    field = next(f for f in category_section["fields"] if f["key"] == "category_code")
    assert field["choices"] == list(forms.SALE_CATEGORY_CODES)
    assert "food" in field["choices"]
    assert field["choices"][-1] == "other"


def test_serialize_schema_marks_milestone_sections_as_external_entity():
    payload = forms.serialize_schema(forms.get_form_schema("services_individual"))
    milestones_section = next(s for s in payload["sections"] if s["key"] == "milestones")
    assert milestones_section["external_entity"] == "milestone"
    assert milestones_section["fields"] == []


# --- локализация предупреждений (отсмотр 2026-08-19) -------------------------


def test_localize_warning_maps_key_to_frontend_contract():
    w = {"field": "price_type", "i18n_key": "contract_forms.service.warning.estimate_price"}
    ru = forms.localize_warning(w, locale="ru")
    assert ru["field"] == "price_type"
    assert ru["code"] == "contract_forms.service.warning.estimate_price"
    assert "смете" in ru["message"]
    # Любой не-ru язык без своей записи — en (как error_texts).
    de = forms.localize_warning(w, locale="de")
    assert de["message"].startswith("Estimate-based")


def test_localize_warning_unknown_key_falls_back_to_key_not_empty():
    w = {"field": "x", "i18n_key": "contract_forms.some.new.warning"}
    out = forms.localize_warning(w, locale="ru")
    assert out["message"] == "contract_forms.some.new.warning"  # не пустой буллет


def test_warning_texts_have_both_ru_and_en():
    for key, texts in forms.WARNING_TEXTS.items():
        assert texts.get("ru") and texts.get("en"), key


def test_saved_form_data_revalidates_cleanly_roundtrip():
    """`schema_version` пишет сам validate_form_data — сохранённый form_data
    обязан проходить повторную валидацию (compute_form_warnings делает именно
    это). До правки round-trip падал unknown_field'ом, и схемные
    предупреждения молча глотались (отсмотр 2026-08-19)."""
    payload = {
        "sphere_code": "renovation",
        "work_description": "Поклейка обоев",
        "location_type": "remote",
        "term_type": "relative_to_gate",
        "duration_days": 5,
        "price_type": "estimate",
    }
    cleaned, first = forms.validate_form_data("services_individual", payload, deal_type=_C2C)
    assert cleaned["schema_version"] == 1
    cleaned2, second = forms.validate_form_data("services_individual", cleaned, deal_type=_C2C)
    assert cleaned2["schema_version"] == 1
    # Предупреждение о смете живо в ОБОИХ прогонах.
    assert any(w["i18n_key"].endswith("estimate_price") for w in first)
    assert any(w["i18n_key"].endswith("estimate_price") for w in second)
