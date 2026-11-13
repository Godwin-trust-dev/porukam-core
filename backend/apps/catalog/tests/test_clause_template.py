"""ClauseTemplate — GLOBAL-профиль конструктора (ГВ.5, docs/tasks/
global-wave.md, ADR-075)."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.catalog import selectors
from apps.catalog.models import ClauseTemplate

pytestmark = pytest.mark.django_db


def test_global_clauses_have_no_legal_anchors():
    """✅ ГВ.5: legal_anchors пустые для GLOBAL (юрсилу не заявляем)."""
    assert ClauseTemplate.objects.filter(country_code="GLOBAL").exists()
    for clause in ClauseTemplate.objects.filter(country_code="GLOBAL"):
        assert clause.legal_anchors == []


def test_global_clauses_have_neutral_english_text():
    for clause in ClauseTemplate.objects.filter(country_code="GLOBAL"):
        assert clause.text
        assert clause.country_code == "GLOBAL"


def test_assemble_clauses_returns_only_requested_blocks_for_country():
    """✅ ГВ.5: черновик договора в GLOBAL собирается из GLOBAL-блоков."""
    clauses = selectors.assemble_clauses(country_code="GLOBAL", block_codes=["K2", "V-GOODS"])
    assert {c.block_code for c in clauses} == {"K2", "V-GOODS"}
    for clause in clauses:
        assert clause.legal_anchors == []


def test_assemble_clauses_for_unknown_country_is_empty():
    """Пока RU-строки этой модели не заведены (отдельный трек, см.
    docstring модели) — assemble_clauses для RU намеренно пуст, не падает."""
    clauses = selectors.assemble_clauses(country_code="RU", block_codes=["K2"])
    assert list(clauses) == []


def test_assemble_clauses_ignores_block_codes_without_a_template():
    clauses = selectors.assemble_clauses(country_code="GLOBAL", block_codes=["K2", "no-such-block"])
    assert {c.block_code for c in clauses} == {"K2"}


def test_country_and_block_code_pair_is_unique():
    with pytest.raises(IntegrityError), transaction.atomic():
        ClauseTemplate.objects.create(country_code="GLOBAL", block_code="K2", text="dup")
