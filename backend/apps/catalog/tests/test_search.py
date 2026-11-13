"""apps.catalog.search (ADR-097) — чистые функции ранжирования, без БД.

Кейсы — прямо из замечаний отсмотра: запрос из плейсхолдера («ремонт кухни»)
обязан находить сферу, опечатка не должна давать пустоту, совпадение по
имени категории должно поднимать её сферу."""

from __future__ import annotations

from apps.catalog.search import (
    SphereCandidate,
    damerau_levenshtein,
    normalize,
    rank_spheres,
    tokenize,
)

RENOVATION = SphereCandidate(
    code="renovation",
    names=("Ремонт и строительство", "Renovation & construction"),
    category_names=("Сантехника и водоснабжение", "Комплексный ремонт под ключ"),
)
APPLIANCE = SphereCandidate(
    code="appliance",
    names=("Ремонт техники",),
    category_names=("Климатическая техника",),
)
DESIGN = SphereCandidate(
    code="design",
    names=("Дизайн",),
    category_names=("Графический дизайн",),
)
ALL = [RENOVATION, APPLIANCE, DESIGN]


# --- нормализация ---------------------------------------------------------


def test_normalize_lowercases_yo_and_strips_punctuation():
    assert normalize("Пошив и ремонт одежды, обуви!") == "пошив и ремонт одежды обуви"
    assert normalize("Съёмка") == "съемка"


def test_tokenize_splits_on_non_alnum():
    assert tokenize("UX/UI-дизайн") == ["ux", "ui", "дизайн"]


# --- расстояние -----------------------------------------------------------


def test_damerau_substitution_and_transposition_cost_one():
    assert damerau_levenshtein("римонт", "ремонт", cutoff=2) == 1  # замена и→е
    assert damerau_levenshtein("рмеонт", "ремонт", cutoff=2) == 1  # перестановка соседей


def test_damerau_cutoff_caps_result():
    assert damerau_levenshtein("плитка", "водоснабжение", cutoff=2) == 3  # cutoff + 1


# --- ранжирование ---------------------------------------------------------


def test_prefix_query_finds_all_matching_names():
    codes = rank_spheres("рем", ALL)
    assert set(codes) == {"renovation", "appliance"}


def test_typo_query_finds_spheres():
    codes = rank_spheres("римонт", ALL)
    assert "renovation" in codes and "appliance" in codes
    assert "design" not in codes


def test_extra_word_does_not_kill_match():
    """Запрос из плейсхолдера UI: «ремонт кухни» — слова «кухни» нет ни в
    одном имени, но сфера всё равно должна найтись по слову «ремонт»."""
    assert "renovation" in rank_spheres("ремонт кухни", ALL)


def test_full_name_phrase_ranks_exact_sphere_first():
    assert rank_spheres("ремонт и строительство", ALL)[0] == "renovation"


def test_category_label_pulls_its_sphere():
    codes = rank_spheres("сантехника", ALL)
    assert codes == ["renovation"]


def test_name_match_ranks_above_category_only_match():
    by_name = SphereCandidate(code="by-name", names=("Дизайн",))
    by_category = SphereCandidate(code="by-category", names=("Медиа",), category_names=("Дизайн",))
    assert rank_spheres("дизайн", [by_category, by_name]) == ["by-name", "by-category"]


def test_more_matched_tokens_rank_higher():
    codes = rank_spheres("ремонт техники", ALL)
    assert codes[0] == "appliance"  # оба слова, у renovation — одно


def test_empty_and_unmatched_queries_return_empty():
    assert rank_spheres("   ", ALL) == []
    assert rank_spheres("zzzzz", ALL) == []


def test_short_tokens_get_no_typo_tolerance():
    assert rank_spheres("рм", ALL) == []  # 2 символа: ни префикс, ни опечатка


def test_two_char_token_is_not_a_substring_match():
    """«no» не должен находить «Re-no-vation» — подстрока только с 3 символов
    (регресс test_spheres_q_no_match_is_empty_not_error)."""
    assert rank_spheres("zzzzz-no-such-sphere", ALL) == []
