"""tech-spec.md §6.6; docs/catalog-v2.md §7 п.6 — тесты compute_segment;
ADR-153 — фасад востребованности пунктов чек-листа."""

from pathlib import Path

import pytest
from django.db import transaction

from apps.catalog import selectors, services
from apps.catalog.models import ChecklistTemplatePickStat, ContractTypeCatalogItem

pytestmark = pytest.mark.django_db

_REPO_CHECKLISTS_DIR = Path(__file__).resolve().parents[4] / "docs" / "content" / "checklists"

_EXCLUDED_CODES = ["shares_securities", "crypto_dfa", "employment", "loan_matching"]
_NOT_YET_SUPPORTED_CODES = ["sale_vehicle", "sale_real_estate", "gift_registered"]


# --- Р-1 (обязательный тест CLAUDE.md): представитель чужого ООО ---------


def test_representative_of_foreign_llc_personal_service_is_free_c2c():
    """Представитель чужого ООО оказывает услугу ЛИЧНО как физлицо: чужое
    директорство/представительство НЕ даёт business-статус (CLAUDE.md,
    apps.entities.services — has_business_status остаётся False), поэтому
    ветка «Услуга» резолвится в services_individual и сегмент — free_c2c."""
    code = services.resolve_service_contract_type_code(
        contractor_acting_as="person",
        contractor_has_business_status=False,
    )
    assert code == "services_individual"
    assert services.compute_segment(code) == ContractTypeCatalogItem.Segment.FREE_C2C


def test_own_smz_contractor_resolves_to_services_business():
    code = services.resolve_service_contract_type_code(
        contractor_acting_as="person",
        contractor_has_business_status=True,
    )
    assert code == "services_business"
    assert services.compute_segment(code) == ContractTypeCatalogItem.Segment.PAID_BUSINESS


def test_entity_acting_as_business_resolves_to_services_business():
    code = services.resolve_service_contract_type_code(contractor_acting_as="business")
    assert code == "services_business"


# --- excluded → запрет ----------------------------------------------------


@pytest.mark.parametrize("code", _EXCLUDED_CODES)
def test_excluded_type_creation_is_forbidden(code):
    with pytest.raises(services.ContractTypeExcludedError):
        services.compute_segment(code)


# --- авто/недвижимость → 409 not_yet_supported -----------------------------


@pytest.mark.parametrize("code", _NOT_YET_SUPPORTED_CODES)
def test_special_r2_types_are_not_yet_supported(code):
    with pytest.raises(services.ContractTypeNotYetSupportedError):
        services.compute_segment(code)


# --- rent_*: сегмент по статусу арендодателя (requires_service_flag) ------


@pytest.mark.parametrize("code", ["rent_items", "rent_home"])
def test_rent_segment_follows_lessor_business_status(code):
    assert (
        services.compute_segment(code, contractor_acting_as="person")
        == ContractTypeCatalogItem.Segment.FREE_C2C
    )
    assert (
        services.compute_segment(code, contractor_has_business_status=True)
        == ContractTypeCatalogItem.Segment.PAID_BUSINESS
    )


# --- типы, уже расщеплённые по статусу в клиентском дереве ----------------


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("sale_personal", ContractTypeCatalogItem.Segment.FREE_C2C),
        ("sale_business", ContractTypeCatalogItem.Segment.PAID_BUSINESS),
        ("loan_individuals", ContractTypeCatalogItem.Segment.FREE_C2C),
    ],
)
def test_static_segment_ignores_actor_status(code, expected):
    assert services.compute_segment(code) == expected
    assert (
        services.compute_segment(code, contractor_has_business_status=True) == expected
    )  # статус не влияет — код уже расщеплён по статусу продавца


# --- СМЗ-продавец → фильтр собственного производства (ст. 4 ФЗ-422) ------


def test_smz_seller_cannot_resell_someone_elses_goods():
    with pytest.raises(services.SmzOwnProductionRequiredError):
        services.assert_smz_own_production(
            "sale_business", seller_tax_regime="npd", is_own_production=False
        )


def test_smz_seller_of_own_production_is_allowed():
    services.assert_smz_own_production(
        "sale_business", seller_tax_regime="npd", is_own_production=True
    )


def test_non_smz_business_seller_is_not_restricted():
    services.assert_smz_own_production(
        "sale_business", seller_tax_regime="usn", is_own_production=False
    )


def test_sale_personal_has_no_smz_own_production_restriction():
    services.assert_smz_own_production(
        "sale_personal", seller_tax_regime="npd", is_own_production=False
    )


# --- record_checklist_pick (ADR-153) -----------------------------------------


@pytest.fixture
def imported():
    """Реальный контент CL-*_GLOBAL.md — `slug`/`category` заполняет только
    `import_checklists` (ADR-081), сид-миграция 0006 их не трогает."""
    return services.import_checklists(_REPO_CHECKLISTS_DIR)


@pytest.fixture
def template(imported):
    item = selectors.list_checklist_recommendations(
        sphere_code="renovation", work_type="turnkey"
    ).first()
    assert item is not None
    return item


def test_record_checklist_pick_creates_stat_row_on_first_pick(template):
    picked = services.record_checklist_pick(description=template.description)
    assert picked is not None
    assert picked.slug == template.slug
    stat = ChecklistTemplatePickStat.objects.get(slug=template.slug)
    assert stat.pick_count == 1
    assert stat.last_picked_at is not None


def test_record_checklist_pick_increments_existing_stat(template):
    for _ in range(3):
        services.record_checklist_pick(description=template.description)
    assert ChecklistTemplatePickStat.objects.get(slug=template.slug).pick_count == 3
    assert ChecklistTemplatePickStat.objects.count() == 1


def test_record_checklist_pick_uses_f_expression_not_read_modify_write(template):
    """Инкремент атомарен: значение считает БД (`F()`), а не питон по
    прочитанному ранее объекту — «устаревшая» копия строки в памяти
    вызывающего кода счётчик не откатывает."""
    services.record_checklist_pick(description=template.description)
    stale = ChecklistTemplatePickStat.objects.get(slug=template.slug)
    ChecklistTemplatePickStat.objects.filter(slug=template.slug).update(pick_count=41)

    services.record_checklist_pick(description=template.description)

    assert stale.pick_count == 1  # копия в памяти не обновлялась
    assert ChecklistTemplatePickStat.objects.get(slug=template.slug).pick_count == 42


def test_record_checklist_pick_ignores_own_text(imported):
    assert services.record_checklist_pick(description="Сам придумал критерий") is None
    assert not ChecklistTemplatePickStat.objects.exists()


def test_record_checklist_pick_rolls_back_with_transaction(template):
    """Пик живёт в транзакции вызывающей стороны: откат создания пункта
    чек-листа откатывает и счётчик."""
    with pytest.raises(RuntimeError), transaction.atomic():
        services.record_checklist_pick(description=template.description)
        raise RuntimeError("создание пункта не удалось")
    assert not ChecklistTemplatePickStat.objects.filter(slug=template.slug).exists()
