"""apps.geo.constants — LOCALE_SCRIPT_RANGES (ADR-183, тай-брейк выбора
имени по родной письменности локали) и GENERIC_TERM_LOWERCASE/
normalize_generic_terms (ADR-183, доп. 12.09 — регистр родовых слов
регионов). Без БД."""

from __future__ import annotations

import re

from apps.geo.constants import (
    GENERIC_TERM_LOWERCASE,
    LOCALE_SCRIPT_RANGES,
    LOCALE_TO_GEONAMES_LANGS,
    normalize_generic_terms,
)


def test_locale_script_ranges_is_subset_of_known_locales():
    assert LOCALE_SCRIPT_RANGES.keys() <= LOCALE_TO_GEONAMES_LANGS.keys()


def test_latin_script_locales_have_no_range():
    # Локали с латинским письмом сознательно НЕ входят — тай-брейк для них
    # не применяется (services._select_best_names).
    for locale in ("en", "de", "fr", "es", "tr", "az", "uz", "vi", "pt-BR"):
        assert locale not in LOCALE_SCRIPT_RANGES


def test_cyrillic_locales_match_cyrillic_and_reject_latin():
    for locale in ("ru", "kk", "uk"):
        pattern = re.compile(f"[{LOCALE_SCRIPT_RANGES[locale]}]")
        assert pattern.search("Ставрополь")
        assert not pattern.search("Stavropol’")  # апостроф U+2019 — не кириллица
        assert not pattern.search("Stavropol")


def test_arabic_script_locales_match_arabic():
    for locale in ("ar", "fa", "ur"):
        pattern = re.compile(f"[{LOCALE_SCRIPT_RANGES[locale]}]")
        assert pattern.search("ستافروبول")
        assert not pattern.search("Stavropol")


def test_cjk_locales_match_han_and_kana():
    pattern = re.compile(f"[{LOCALE_SCRIPT_RANGES['zh-Hans']}]")
    assert pattern.search("斯塔夫罗波尔")
    assert not pattern.search("Stavropol")

    ja_pattern = re.compile(f"[{LOCALE_SCRIPT_RANGES['ja']}]")
    assert ja_pattern.search("スタヴロポリ")  # катакана


# --- normalize_generic_terms (ADR-183, доп. 12.09) ---


def test_generic_term_lowercase_is_subset_of_known_locales():
    assert GENERIC_TERM_LOWERCASE.keys() <= LOCALE_TO_GEONAMES_LANGS.keys()


def test_kray_lowercased_when_not_first_word():
    assert normalize_generic_terms("Ставропольский Край", "ru") == "Ставропольский край"


def test_oblast_lowercased_when_not_first_word():
    assert normalize_generic_terms("Амурская Область", "ru") == "Амурская область"


def test_okrug_lowercased_when_not_first_word():
    assert (
        normalize_generic_terms("Чукотский Автономный Округ", "ru") == "Чукотский автономный округ"
    )


def test_avtonomny_variants_lowercased():
    assert normalize_generic_terms("Ненецкий Автономный Округ", "ru") == "Ненецкий автономный округ"
    assert (
        normalize_generic_terms("Еврейская Автономная Область", "ru")
        == "Еврейская автономная область"
    )


def test_republic_never_touched_regardless_of_position():
    # "Республика" — НЕ родовое слово в списке (ADR-183): официальная
    # орфография капитализирует его в ЛЮБОЙ позиции.
    assert normalize_generic_terms("Республика Адыгея", "ru") == "Республика Адыгея"
    assert normalize_generic_terms("Чеченская Республика", "ru") == "Чеченская Республика"


def test_generic_term_as_first_word_not_touched():
    # Синтетический случай (в реальном RU-датасете родовое слово первым не
    # встретилось) — правило должно быть общим, не завязанным на конкретные
    # значения: первое слово никогда не трогается, даже если оно из списка.
    assert normalize_generic_terms("Край Такой-То", "ru") == "Край Такой-То"


def test_dash_suffix_after_generic_term_still_lowercased():
    # geonameid региона 127 (Ханты-Мансийский АО) в реальном источнике —
    # суффикс "–Югра" приклеен к "Округ" без пробела (тире, не дефис);
    # \b-граница обязана сработать и тут.
    assert (
        normalize_generic_terms("Ханты-Мансийский Автономный Округ–Югра", "ru")
        == "Ханты-Мансийский автономный округ–Югра"
    )


def test_unknown_locale_is_a_no_op():
    assert normalize_generic_terms("Amur Oblast", "en") == "Amur Oblast"


def test_empty_name_is_a_no_op():
    assert normalize_generic_terms("", "ru") == ""


def test_single_word_name_untouched():
    # Слово из списка — но оно единственное/первое в строке.
    assert normalize_generic_terms("Округ", "ru") == "Округ"
