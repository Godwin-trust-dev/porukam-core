"""apps.milestones.services — Э4.3 (docs/tasks/etap-4.md); ADR-153 —
востребованность шаблонных пунктов чек-листа."""

from __future__ import annotations

import importlib
from decimal import Decimal
from pathlib import Path

import pytest
from django.apps import apps as live_apps

from apps.catalog import selectors as catalog_selectors
from apps.catalog import services as catalog_services
from apps.catalog.models import ChecklistTemplatePickStat, Sphere
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.milestones import services
from apps.milestones.models import MAX_TREE_DEPTH, ChecklistItem, ContractMaterial, Milestone
from common.models import OutboxEvent
from common.money import Money

from ._helpers import make_contract, make_user

pytestmark = pytest.mark.django_db

_REPO_CHECKLISTS_DIR = Path(__file__).resolve().parents[4] / "docs" / "content" / "checklists"
_milestones_0008 = importlib.import_module(
    "apps.milestones.migrations.0008_backfill_checklist_pick_stats"
)


@pytest.fixture
def customer():
    return make_user("s001")


@pytest.fixture
def contractor():
    return make_user("s002")


@pytest.fixture
def contract(customer, contractor):
    return make_contract(customer=customer, contractor=contractor)


# --- дерево: создание, глубина, ветка/лист (приёмка Э4.3) --------------------


def test_create_root_leaf_with_amount(contract, customer):
    m = services.create_milestone(
        contract, user=customer, title="Этап 1", amount=Decimal("100.00"), currency="RUB"
    )
    assert m.amount == Decimal("100.00")
    assert m.parent_id is None


def test_build_floor_room_works_tree_and_branch_sum_computed(contract, customer):
    """Приёмка Э4.3: собрать дерево «этаж → комната → работы», сумма ветки
    вычисляется."""
    floor = services.create_milestone(contract, user=customer, title="Этаж 1")
    room = services.create_milestone(contract, user=customer, title="Комната 101", parent=floor)
    services.create_milestone(
        contract,
        user=customer,
        title="Поклейка обоев",
        parent=room,
        amount=Decimal("15000.00"),
        currency="RUB",
    )
    services.create_milestone(
        contract,
        user=customer,
        title="Укладка плитки",
        parent=room,
        amount=Decimal("25000.00"),
        currency="RUB",
    )

    total = services.total_leaf_amount(contract)
    assert total.amount == Decimal("40000.00")
    assert total.currency == "RUB"


def test_amount_on_branch_is_rejected_with_422_worthy_error(contract, customer):
    """Приёмка Э4.3: amount у ветки → 422 (маппится в api/views)."""
    branch = services.create_milestone(contract, user=customer, title="Ветка")
    services.create_milestone(contract, user=customer, title="Лист", parent=branch)
    with pytest.raises(services.MilestoneAmountGuardError):
        services.patch_milestone(branch, user=customer, amount=Decimal("1.00"), currency="RUB")


def test_cannot_add_child_under_leaf_with_amount(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="Лист", amount=Decimal("1.00"), currency="RUB"
    )
    with pytest.raises(services.MilestoneAmountGuardError):
        services.create_milestone(contract, user=customer, title="Ребёнок", parent=leaf)


def test_depth_7_is_forbidden(contract, customer):
    node = None
    for level in range(MAX_TREE_DEPTH):
        node = services.create_milestone(contract, user=customer, title=f"L{level}", parent=node)
    with pytest.raises(services.MilestoneDepthExceededError):
        services.create_milestone(contract, user=customer, title="L7", parent=node)


def test_parent_from_another_contract_is_rejected(contract, customer):
    other_contract = make_contract(customer=make_user("s003"), contractor=make_user("s004"))
    foreign_root = services.create_milestone(
        other_contract, user=other_contract.created_by, title="чужой корень"
    )
    with pytest.raises(services.MilestoneWrongContractError):
        services.create_milestone(contract, user=customer, title="x", parent=foreign_root)


def test_amount_requires_currency_pair(contract, customer):
    with pytest.raises(services.MoneyPairRequiredError):
        services.create_milestone(contract, user=customer, title="x", amount=Decimal("1.00"))


def test_currency_must_be_active(contract, customer):
    """GBP не заведена в справочнике вовсе — не активна ни в одном контуре.

    USD сюда больше не годится (ГВ.1, docs/tasks/global-wave.md): её
    активировала сид-миграция apps.catalog/0007_seed_usd_eur для GLOBAL-контура.
    """
    with pytest.raises(services.CurrencyNotActiveError):
        services.create_milestone(
            contract, user=customer, title="x", amount=Decimal("1.00"), currency="GBP"
        )


def test_not_a_party_cannot_create_milestone(contract):
    stranger = make_user("s005")
    with pytest.raises(contracts_services.NotAPartyError):
        services.create_milestone(contract, user=stranger, title="x")


def test_structure_not_editable_after_signing(contract, customer):
    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.StructureNotEditableError):
        services.create_milestone(contract, user=customer, title="x")


def test_adding_child_under_leaf_content_without_amount_is_rejected(contract, customer):
    leaf = services.create_milestone(contract, user=customer, title="лист")
    services.create_checklist_item(
        leaf, user=customer, description="d", measurable_criterion="c", required_evidence=[]
    )
    with pytest.raises(services.MilestoneHasLeafContentError):
        services.create_milestone(contract, user=customer, title="ребёнок", parent=leaf)


# --- удаление этапа (ADR-101) -------------------------------------------------


def test_delete_leaf_removes_it_and_its_checklist(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount="10.00", currency="RUB"
    )
    services.create_checklist_item(
        leaf, user=customer, description="d", measurable_criterion="c", required_evidence=[]
    )
    services.delete_milestone(leaf, user=customer)
    assert not Milestone.objects.filter(pk=leaf.pk).exists()
    assert not ChecklistItem.objects.filter(milestone_id=leaf.pk).exists()


def test_delete_branch_cascades_to_subtree(contract, customer):
    branch = services.create_milestone(contract, user=customer, title="ветка")
    child = services.create_milestone(contract, user=customer, title="ребёнок", parent=branch)
    services.delete_milestone(branch, user=customer)
    assert not Milestone.objects.filter(pk__in=[branch.pk, child.pk]).exists()


def test_delete_by_counterparty_allowed_while_under_review(contract, customer, contractor):
    leaf = services.create_milestone(contract, user=customer, title="лист")
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    services.delete_milestone(leaf, user=contractor)
    assert not Milestone.objects.filter(pk=leaf.pk).exists()


def test_delete_by_stranger_is_rejected(contract, customer):
    leaf = services.create_milestone(contract, user=customer, title="лист")
    stranger = make_user("s006")
    with pytest.raises(contracts_services.NotAPartyError):
        services.delete_milestone(leaf, user=stranger)
    assert Milestone.objects.filter(pk=leaf.pk).exists()


def test_delete_not_editable_after_signing(contract, customer):
    leaf = services.create_milestone(contract, user=customer, title="лист")
    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.StructureNotEditableError):
        services.delete_milestone(leaf, user=customer)
    assert Milestone.objects.filter(pk=leaf.pk).exists()


# --- чек-лист и материалы: только на листе -----------------------------------


def test_checklist_item_on_branch_is_rejected(contract, customer):
    branch = services.create_milestone(contract, user=customer, title="ветка")
    services.create_milestone(contract, user=customer, title="лист", parent=branch)
    with pytest.raises(services.MilestoneNotLeafError):
        services.create_checklist_item(
            branch, user=customer, description="d", measurable_criterion="c", required_evidence=[]
        )


def test_material_on_branch_is_rejected(contract, customer):
    branch = services.create_milestone(contract, user=customer, title="ветка")
    services.create_milestone(contract, user=customer, title="лист", parent=branch)
    with pytest.raises(services.MilestoneNotLeafError):
        services.create_material(
            branch,
            user=customer,
            catalog_item_code="other_renovation",
            description="d",
            source=ContractMaterial.Source.CUSTOMER,
            unit_price=Decimal("0"),
            unit_price_currency="RUB",
        )


def test_material_requires_positive_price_for_contractor(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.MaterialPriceRequiredError):
        services.create_material(
            leaf,
            user=customer,
            catalog_item_code="other_renovation",
            description="плитка",
            source=ContractMaterial.Source.CONTRACTOR,
            unit_price=Decimal("0"),
            unit_price_currency="RUB",
        )


def test_material_unknown_catalog_item_code(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.MaterialCatalogItemNotFoundError):
        services.create_material(
            leaf,
            user=customer,
            catalog_item_code="does_not_exist",
            description="x",
            source=ContractMaterial.Source.CUSTOMER,
            unit_price=Decimal("0"),
            unit_price_currency="RUB",
        )


def test_material_created_with_real_catalog_item(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("100.00"), currency="RUB"
    )
    material = services.create_material(
        leaf,
        user=customer,
        catalog_item_code="renovation_tile",
        description="Кафель 30х30",
        source=ContractMaterial.Source.CONTRACTOR,
        unit_price=Decimal("500.00"),
        unit_price_currency="RUB",
        quantity=Decimal("10"),
        unit="м2",
    )
    assert material.catalog_item.code == "renovation_tile"


# --- рекомендации чек-листа по материалам (ADR-047) --------------------------


def test_recommend_checklist_items_by_material_and_sphere(contract, customer):
    renovation = Sphere.objects.get(code="renovation")
    branch = services.create_milestone(
        contract, user=customer, title="Этаж 1", sphere_code=renovation.code
    )
    room = services.create_milestone(contract, user=customer, title="Комната", parent=branch)
    leaf = services.create_milestone(
        contract, user=customer, title="Плитка", parent=room, amount=Decimal("1"), currency="RUB"
    )
    services.create_material(
        leaf,
        user=customer,
        catalog_item_code="renovation_tile",
        description="Кафель",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
    )
    recs = services.recommend_checklist_items(leaf)
    descriptions = {r["description"] for r in recs}
    assert "Плитка уложена без перепадов по высоте" in descriptions
    assert "После завершения работ помещение убрано от строительного мусора" in descriptions


def test_recommend_checklist_items_empty_without_materials_or_sphere(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("1"), currency="RUB"
    )
    assert services.recommend_checklist_items(leaf) == []


# --- сервис проверки «сумма листьев = сумма договора» (для Э4.4) ------------


def test_assert_leaf_sum_matches_ok(contract, customer):
    services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("100.00"), currency="RUB"
    )
    services.assert_leaf_sum_matches(contract, Money("100.00", "RUB"))


def test_assert_leaf_sum_matches_mismatch(contract, customer):
    services.create_milestone(
        contract, user=customer, title="лист", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.LeafSumMismatchError):
        services.assert_leaf_sum_matches(contract, Money("999.00", "RUB"))


# --- Займ: график возврата как этапы-листья (приёмка Э4.3) -------------------


def test_materialize_loan_schedule_creates_leaves(customer, contractor):
    contract = make_contract(
        customer=customer,
        contractor=contractor,
        contract_type_code="loan_individuals",
        form_data={
            "amount": "100000",
            "interest_type": "interest_free",
            "repayment_type": "schedule",
            "schedule": [
                {"due_date": "2026-09-01", "amount": "50000"},
                {"due_date": "2026-10-01", "amount": "50000"},
            ],
            "transfer_method": "platform",
        },
    )
    milestones = services.materialize_loan_schedule(contract, user=customer, currency="RUB")
    assert len(milestones) == 2
    assert all(m.parent_id is None for m in milestones)
    assert {m.amount for m in milestones} == {Decimal("50000.00")}
    total = services.total_leaf_amount(contract)
    assert total.amount == Decimal("100000.00")


def test_materialize_loan_schedule_wrong_contract_type(contract, customer):
    with pytest.raises(services.LoanScheduleNotApplicableError):
        services.materialize_loan_schedule(contract, user=customer, currency="RUB")


def test_materialize_loan_schedule_lump_sum_not_applicable(customer, contractor):
    contract = make_contract(
        customer=customer,
        contractor=contractor,
        contract_type_code="loan_individuals",
        form_data={
            "amount": "5000",
            "interest_type": "interest_free",
            "repayment_type": "lump_sum",
            "due_date": "2026-12-01",
            "transfer_method": "platform",
        },
    )
    with pytest.raises(services.LoanScheduleNotApplicableError):
        services.materialize_loan_schedule(contract, user=customer, currency="RUB")


# --- пункт чек-листа: правка и удаление до подписания (мастер, 2026-08-25) ---


def _leaf_with_item(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="лист", amount="10.00", currency="RUB"
    )
    item = services.create_checklist_item(
        leaf,
        user=customer,
        description="плитка без пустот",
        measurable_criterion="простукивание",
        required_evidence=["photo"],
    )
    return leaf, item


def test_patch_checklist_item_updates_fields_and_publishes_event(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    updated = services.patch_checklist_item(
        item, user=customer, description="швы затёрты", required_evidence=[], order=3
    )
    updated.refresh_from_db()
    assert updated.description == "швы затёрты"
    assert updated.measurable_criterion == "простукивание"  # None — «не менять»
    assert updated.required_evidence == []
    assert updated.order == 3
    event = OutboxEvent.objects.get(topic="milestone.checklist_item_updated")
    assert event.subject["id"] == str(item.milestone_id)
    assert event.subject["contract_id"] == str(contract.id)
    assert event.payload["checklist_item_id"] == str(item.id)
    assert set(event.payload["fields"]) == {"description", "required_evidence", "order"}


def test_patch_checklist_item_without_changes_publishes_nothing(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    services.patch_checklist_item(item, user=customer)
    assert not OutboxEvent.objects.filter(topic="milestone.checklist_item_updated").exists()


def test_patch_checklist_item_by_counterparty_allowed_while_under_review(
    contract, customer, contractor
):
    _, item = _leaf_with_item(contract, customer)
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    services.patch_checklist_item(item, user=contractor, description="иначе")
    item.refresh_from_db()
    assert item.description == "иначе"


def test_patch_checklist_item_by_stranger_is_rejected(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    with pytest.raises(contracts_services.NotAPartyError):
        services.patch_checklist_item(item, user=make_user("s007"), description="x")
    item.refresh_from_db()
    assert item.description == "плитка без пустот"


def test_patch_checklist_item_not_editable_after_signing(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.StructureNotEditableError):
        services.patch_checklist_item(item, user=customer, description="x")
    item.refresh_from_db()
    assert item.description == "плитка без пустот"


def test_delete_checklist_item_removes_it_and_publishes_event(contract, customer):
    leaf, item = _leaf_with_item(contract, customer)
    item_id = item.id  # Django обнуляет pk экземпляра после delete()
    services.delete_checklist_item(item, user=customer)
    assert not ChecklistItem.objects.filter(pk=item_id).exists()
    assert Milestone.objects.filter(pk=leaf.pk).exists()
    event = OutboxEvent.objects.get(topic="milestone.checklist_item_removed")
    assert event.subject == {
        "type": "milestone",
        "id": str(leaf.id),
        "contract_id": str(contract.id),
    }
    assert event.payload == {"checklist_item_id": str(item_id)}
    assert event.actor == {"user_id": str(customer.id)}


def test_delete_checklist_item_by_counterparty_allowed_while_under_review(
    contract, customer, contractor
):
    _, item = _leaf_with_item(contract, customer)
    item_id = item.id
    contract.negotiation_status = Contract.NegotiationStatus.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    services.delete_checklist_item(item, user=contractor)
    assert not ChecklistItem.objects.filter(pk=item_id).exists()


def test_delete_checklist_item_by_stranger_is_rejected(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    with pytest.raises(contracts_services.NotAPartyError):
        services.delete_checklist_item(item, user=make_user("s008"))
    assert ChecklistItem.objects.filter(pk=item.pk).exists()


def test_delete_checklist_item_not_editable_after_signing(contract, customer):
    _, item = _leaf_with_item(contract, customer)
    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.StructureNotEditableError):
        services.delete_checklist_item(item, user=customer)
    assert ChecklistItem.objects.filter(pk=item.pk).exists()


# --- востребованность пунктов чек-листа (ADR-153) ----------------------------


@pytest.fixture
def imported_checklists():
    """Реальный контент CL-*_GLOBAL.md: `slug`/`category`/`is_default`
    заполняет только `import_checklists` (ADR-081), сид 0006 — нет."""
    return catalog_services.import_checklists(_REPO_CHECKLISTS_DIR)


def _recommended_description(sphere_code: str = "renovation", work_type: str = "turnkey") -> str:
    item = catalog_selectors.list_checklist_recommendations(
        sphere_code=sphere_code, work_type=work_type
    ).first()
    assert item is not None
    return item.description


def test_checklist_item_from_recommendation_bumps_pick_count(
    contract, customer, imported_checklists
):
    """Приёмка ADR-153: пункт, взятый из подсказки, поднимает её в выдаче."""
    renovation = Sphere.objects.get(code="renovation")
    leaf = services.create_milestone(
        contract,
        user=customer,
        title="Ремонт",
        sphere_code=renovation.code,
        amount=Decimal("1"),
        currency="RUB",
    )
    description = _recommended_description()

    item = services.create_checklist_item(
        leaf,
        user=customer,
        description=description,
        measurable_criterion=description,
        required_evidence=[],
    )

    assert item.source_template is not None
    assert item.source_template.description == description
    stat = ChecklistTemplatePickStat.objects.get(slug=item.source_template.slug)
    assert stat.pick_count == 1


def test_checklist_item_with_own_text_does_not_bump_anything(
    contract, customer, imported_checklists
):
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    item = services.create_checklist_item(
        leaf,
        user=customer,
        description="Забор покрашен в мой любимый цвет",
        measurable_criterion="Цвет RAL 6018",
        required_evidence=[],
    )
    assert item.source_template_id is None
    assert not ChecklistTemplatePickStat.objects.exists()


def test_repeated_checklist_item_counts_as_second_pick(contract, customer, imported_checklists):
    """`POST .../checklist-items` не денежный и не подписной —
    `Idempotency-Key` на нём нет; повтор создаёт ВТОРОЙ пункт чек-листа, и
    это честно второй пик (ADR-153 «Идемпотентность»)."""
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    description = _recommended_description()
    for _ in range(2):
        services.create_checklist_item(
            leaf,
            user=customer,
            description=description,
            measurable_criterion=description,
            required_evidence=[],
        )
    assert ChecklistItem.objects.filter(milestone=leaf).count() == 2
    assert ChecklistTemplatePickStat.objects.get().pick_count == 2


def test_rejected_checklist_item_does_not_bump_pick_count(contract, customer, imported_checklists):
    """Гейт редактируемости срабатывает раньше пика — отказ не оставляет
    следа в статистике."""
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    contract.negotiation_status = Contract.NegotiationStatus.SIGNED
    contract.save(update_fields=["negotiation_status"])
    with pytest.raises(services.StructureNotEditableError):
        services.create_checklist_item(
            leaf,
            user=customer,
            description=_recommended_description(),
            measurable_criterion="x",
            required_evidence=[],
        )
    assert not ChecklistTemplatePickStat.objects.exists()


def test_patching_checklist_item_to_recommendation_text_does_not_bump(
    contract, customer, imported_checklists
):
    """`source_template` фиксирует ПРОИСХОЖДЕНИЕ пункта, не текущее
    совпадение текста: правка формулировки счётчик не двигает."""
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    item = services.create_checklist_item(
        leaf, user=customer, description="своё", measurable_criterion="своё", required_evidence=[]
    )
    services.patch_checklist_item(item, user=customer, description=_recommended_description())
    item.refresh_from_db()
    assert item.source_template_id is None
    assert not ChecklistTemplatePickStat.objects.exists()


def test_backfill_migration_counts_existing_items_by_text(contract, customer, imported_checklists):
    """Бэкфилл (`milestones.0008_backfill_checklist_pick_stats`) — на
    ссылках, накопленных ДО раскатки ветки: `source_template` у них нет,
    единственный след происхождения — текст. Функция миграции вызывается
    напрямую (тот же приём, что `test_sphere_dedupe_migration.py`)."""
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    description = _recommended_description()
    for _ in range(2):
        ChecklistItem.objects.create(
            milestone=leaf, description=description, measurable_criterion=description
        )
    ChecklistItem.objects.create(
        milestone=leaf, description="Свой критерий", measurable_criterion="Свой критерий"
    )
    assert not ChecklistTemplatePickStat.objects.exists()

    _milestones_0008.backfill(live_apps, None)

    stat = ChecklistTemplatePickStat.objects.get()
    assert stat.pick_count == 2
    assert (
        stat.slug
        == ChecklistItem.objects.filter(description=description).first().source_template.slug
    )
    assert ChecklistItem.objects.get(description="Свой критерий").source_template_id is None


def test_backfill_migration_is_idempotent_on_rerun(contract, customer, imported_checklists):
    """Повторный прогон (пересоздание контейнера, повтор migrate) не
    удваивает счётчик: считаются только пункты БЕЗ `source_template`, а
    вставка строки статистики идёт с `ignore_conflicts`."""
    leaf = services.create_milestone(
        contract, user=customer, title="Ремонт", amount=Decimal("1"), currency="RUB"
    )
    description = _recommended_description()
    ChecklistItem.objects.create(
        milestone=leaf, description=description, measurable_criterion=description
    )

    _milestones_0008.backfill(live_apps, None)
    _milestones_0008.backfill(live_apps, None)

    assert ChecklistTemplatePickStat.objects.get().pick_count == 1


# --- ADR-157: правка предшественника («условие старта») ----------------------


def test_patch_milestone_sets_and_clears_depends_on(contract, customer):
    """`depends_on` — единственное поле `patch_milestone`, у которого `None`
    это ЗНАЧЕНИЕ («условия старта нет»), а «не менять» несёт часовой UNSET."""
    first = services.create_milestone(
        contract, user=customer, title="Демонтаж", amount=Decimal("100.00"), currency="RUB"
    )
    second = services.create_milestone(
        contract, user=customer, title="Отделка", amount=Decimal("200.00"), currency="RUB"
    )

    services.patch_milestone(second, user=customer, depends_on=first)
    second.refresh_from_db()
    assert second.depends_on_id == first.id

    services.patch_milestone(second, user=customer, depends_on=None)
    second.refresh_from_db()
    assert second.depends_on_id is None


def test_patch_milestone_without_depends_on_keeps_it(contract, customer):
    first = services.create_milestone(
        contract, user=customer, title="Демонтаж", amount=Decimal("100.00"), currency="RUB"
    )
    second = services.create_milestone(
        contract,
        user=customer,
        title="Отделка",
        amount=Decimal("200.00"),
        currency="RUB",
        depends_on=first,
    )
    services.patch_milestone(second, user=customer, title="Отделка стен")
    second.refresh_from_db()
    assert second.depends_on_id == first.id


def test_patch_milestone_self_dependency_is_rejected(contract, customer):
    leaf = services.create_milestone(
        contract, user=customer, title="Этап", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.MilestoneDependsOnInvalidError):
        services.patch_milestone(leaf, user=customer, depends_on=leaf)


def test_patch_milestone_dependency_on_foreign_contract_is_rejected(contract, customer):
    other = make_contract(customer=make_user("s901"), contractor=make_user("s902"))
    foreign = services.create_milestone(
        other, user=other.created_by, title="Чужой", amount=Decimal("1.00"), currency="RUB"
    )
    leaf = services.create_milestone(
        contract, user=customer, title="Этап", amount=Decimal("100.00"), currency="RUB"
    )
    with pytest.raises(services.MilestoneDependsOnInvalidError):
        services.patch_milestone(leaf, user=customer, depends_on=foreign)


def test_patch_milestone_dependency_cycle_is_rejected(contract, customer):
    first = services.create_milestone(
        contract, user=customer, title="Первый", amount=Decimal("100.00"), currency="RUB"
    )
    second = services.create_milestone(
        contract,
        user=customer,
        title="Второй",
        amount=Decimal("200.00"),
        currency="RUB",
        depends_on=first,
    )
    with pytest.raises(services.MilestoneDependsOnInvalidError):
        services.patch_milestone(first, user=customer, depends_on=second)


def test_material_events_carry_milestone_title(contract, customer):
    """ADR-156/157: событие материала самодостаточно — по `milestone_title`
    строится и текст уведомления, и подпись хроники договора."""
    leaf = services.create_milestone(
        contract, user=customer, title="Работа", amount=Decimal("100.00"), currency="RUB"
    )
    material = services.create_material(
        leaf,
        user=customer,
        catalog_item_code="other_renovation",
        description="Плитка",
        source=ContractMaterial.Source.CUSTOMER,
        unit_price=Decimal("10.00"),
        unit_price_currency="RUB",
    )
    services.patch_material(material, user=customer, quantity=Decimal("2"))
    services.delete_material(material, user=customer)

    topics = (
        "milestone.material_added",
        "milestone.material_updated",
        "milestone.material_removed",
    )
    for topic in topics:
        event = OutboxEvent.objects.filter(topic=topic).order_by("-event_id").first()
        assert event is not None, topic
        assert event.payload["milestone_title"] == "Работа", topic
