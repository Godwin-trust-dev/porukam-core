import pytest

from apps.catalog.models import ContractTypeCatalogItem, Sphere

pytestmark = pytest.mark.django_db

_R1_CODES = {
    "services_individual",
    "services_business",
    "sale_personal",
    "sale_business",
    "rent_items",
    "rent_home",
    "loan_individuals",
}
_EXCLUDED_CODES = {"shares_securities", "crypto_dfa", "employment", "loan_matching"}
_SPECIAL_R2_CODES = {"sale_vehicle", "sale_real_estate", "gift_registered"}
_PLAIN_R2_CODES = {"gift_movable", "barter_personal", "gratuitous_help"}


def test_r1_catalog_is_exactly_seven_codes_visible_and_active():
    """docs/catalog-v2.md §2: ровно семь кодов Р1, не скрыты, активны."""
    visible_r1 = ContractTypeCatalogItem.objects.filter(
        available_from=ContractTypeCatalogItem.Release.R1
    )
    assert set(visible_r1.values_list("code", flat=True)) == _R1_CODES
    assert not visible_r1.filter(is_hidden=True).exists()
    assert not visible_r1.filter(is_active=False).exists()
    assert not visible_r1.filter(client_option__isnull=True).exists()


def test_excluded_codes_hidden_and_unchanged():
    """docs/catalog-v2.md §4: excluded — как было (скрыт, без изменений)."""
    excluded = ContractTypeCatalogItem.objects.filter(
        default_segment=ContractTypeCatalogItem.Segment.EXCLUDED
    )
    assert set(excluded.values_list("code", flat=True)) == _EXCLUDED_CODES
    assert all(item.is_hidden for item in excluded)
    assert all(item.client_option is None for item in excluded)


def test_special_types_are_hidden_r2_with_special_handling():
    """docs/catalog-v2.md §3: продажа/дарение авто/недвижимости — special, Р2 hidden."""
    items = ContractTypeCatalogItem.objects.filter(code__in=_SPECIAL_R2_CODES)
    assert items.count() == len(_SPECIAL_R2_CODES)
    for item in items:
        assert item.needs_special_handling is True
        assert item.is_hidden is True
        assert item.available_from == ContractTypeCatalogItem.Release.R2
        assert item.default_segment == ContractTypeCatalogItem.Segment.SPECIAL


def test_rent_moved_out_of_special_into_standard():
    """docs/catalog-v2.md §0 п.3: аренда — из special в стандартные договоры."""
    for code in ("rent_items", "rent_home"):
        item = ContractTypeCatalogItem.objects.get(code=code)
        assert item.needs_special_handling is False
        assert item.requires_service_flag is True
        assert item.available_from == ContractTypeCatalogItem.Release.R1


def test_gift_barter_help_deferred_but_not_special():
    """docs/catalog-v2.md §3: дарение/мена/безвозмездная помощь — просто Р2
    hidden (не special), коды сохранены."""
    for code in _PLAIN_R2_CODES:
        item = ContractTypeCatalogItem.objects.get(code=code)
        assert item.available_from == ContractTypeCatalogItem.Release.R2
        assert item.is_hidden is True
        assert item.needs_special_handling is False
        assert item.default_segment == ContractTypeCatalogItem.Segment.FREE_C2C


def test_sale_business_requires_smz_own_production_flag():
    assert ContractTypeCatalogItem.objects.get(code="sale_business").smz_own_production_only
    assert not ContractTypeCatalogItem.objects.get(code="sale_personal").smz_own_production_only


def test_needs_official_clarification_matches_boundary_positions():
    """docs/catalog-v2.md §6: систематичность продаж/займов, аренда жилья,
    дистанционная продажа — открытые вопросы."""
    flagged = {"sale_personal", "sale_business", "rent_home", "loan_individuals"}
    for code in _R1_CODES:
        item = ContractTypeCatalogItem.objects.get(code=code)
        assert item.needs_official_clarification == (code in flagged), code


# --- name_i18n EN (ГВ.5, docs/tasks/global-wave.md, ADR-075) ---------------


def test_all_r1_contract_types_have_english_names():
    """✅ ГВ.5: механизм — EN для 7 типов клиентского дерева Р1."""
    for code in _R1_CODES:
        item = ContractTypeCatalogItem.objects.get(code=code)
        assert item.name_i18n.get("en"), code
        assert item.name_i18n["ru"]  # RU не затёрт добавлением EN


def test_all_current_spheres_have_english_names():
    for sphere in Sphere.objects.all():
        assert sphere.name_i18n.get("en"), sphere.code
        assert sphere.name_i18n["ru"]
