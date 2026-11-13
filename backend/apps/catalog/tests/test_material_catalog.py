"""Э4.3 (docs/tasks/etap-4.md): сид Sphere/MaterialCatalogItem/
ChecklistTemplateItem (migration 0006) + selectors.recommended_checklist_template_items.

`education`, не `tutoring` — chore/sphere-dedup (apps.catalog.migrations.
0014_dedupe_tutoring_into_education) переименовала placeholder-код 0006
(`tutoring` → `education`, слит с кодом контентного трека П-03); эти тесты
идут ПОСЛЕ 0014/0015 (pytest-django прогоняет все миграции), поэтому
проверяют уже продедуплённое состояние."""

from __future__ import annotations

import pytest
from django.db import IntegrityError

from apps.catalog import selectors
from apps.catalog.models import ChecklistTemplateItem, MaterialCatalogItem, Sphere

pytestmark = pytest.mark.django_db

_SPHERE_CODES = {"renovation", "delivery", "education", "it", "household", "design", "other"}


def test_every_sphere_has_an_other_item():
    for code in _SPHERE_CODES:
        sphere = Sphere.objects.get(code=code)
        assert MaterialCatalogItem.objects.filter(sphere=sphere, code=f"other_{code}").exists()


def test_renovation_tile_has_template_checklist_items():
    tile = MaterialCatalogItem.objects.get(code="renovation_tile")
    items = ChecklistTemplateItem.objects.filter(catalog_item=tile)
    assert items.count() == 2
    assert all(item.required_evidence for item in items)


def test_recommended_checklist_template_items_by_catalog_item():
    tile = MaterialCatalogItem.objects.get(code="renovation_tile")
    recs = selectors.recommended_checklist_template_items(
        catalog_item_ids=[tile.id], sphere_id=None
    )
    assert recs.count() == 2


def test_recommended_checklist_template_items_by_sphere_excludes_other_catalog_items_templates():
    renovation = Sphere.objects.get(code="renovation")
    other = MaterialCatalogItem.objects.get(code="other_renovation")
    recs = selectors.recommended_checklist_template_items(
        catalog_item_ids=[other.id], sphere_id=renovation.id
    )
    descriptions = {r.description for r in recs}
    assert "После завершения работ помещение убрано от строительного мусора" in descriptions
    tile_checklist = "Плитка уложена без перепадов по высоте"
    assert tile_checklist not in descriptions


def test_recommended_checklist_template_items_empty_when_nothing_to_match():
    recs = selectors.recommended_checklist_template_items(catalog_item_ids=[], sphere_id=None)
    assert recs.count() == 0


def test_checklist_template_item_requires_catalog_item_or_sphere():
    with pytest.raises(IntegrityError):
        ChecklistTemplateItem.objects.create(
            description="x", measurable_criterion="y", required_evidence=[]
        )


def test_seeded_checklist_items_have_english_description():
    """✅ ГВ.5 (docs/tasks/global-wave.md, ADR-075): механизм — EN для
    чек-листов П-03 (минимальный текущий набор, 0006). description_i18n —
    рядом с description, не взамен (см. docstring модели)."""
    items = ChecklistTemplateItem.objects.all()
    assert items.exists()
    for item in items:
        assert item.description_i18n.get("en"), item.description
        assert item.description_i18n["ru"] == item.description
