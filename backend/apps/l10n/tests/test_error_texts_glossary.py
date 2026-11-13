"""feat/l10n-error-texts — глоссарная красная линия (claude/legal-global/
06_terminology-glossary_EN.md §1): платформа называет свой документ
**agreement**, не «contract» (в common-law «contract» читается как
юридически исполнимый инструмент, чего мы не заявляем, док 31). Стражник
на два источника EN-текста errors-неймспейса, которые реально доходят до
пользователя (common/api/exceptions.py::problem_json_exception_handler):
`l10n/packs/en.json` (пакет, приоритетный источник, apps.l10n.selectors.
get_error_title) и `common/api/error_texts.py::ERROR_TITLES_EN` (встроенный
фолбэк-реестр на случай отсутствия ключа в пакете).

Слово ищется по границе (`\\bcontract\\b`), не подстрокой — «contractor»
(исполнитель, легитимный термин, CLAUDE.md) не совпадает по границе слова
и не должен попадать в белый список как «легитимное вхождение»."""

from __future__ import annotations

import json
import re
from pathlib import Path

from common.api.error_texts import ERROR_TITLES_EN

_REPO_ROOT = Path(__file__).resolve().parents[4]
_EN_PACK = _REPO_ROOT / "l10n" / "packs" / "en.json"

_CONTRACT_WORD_RE = re.compile(r"\bcontract\b", re.IGNORECASE)

# Легитимные вхождения слова «contract» как отдельного слова (не «contractor»)
# — описательная фраза о внешнем мире, не о платформенном документе. Пусто:
# ни одно текущее значение не нуждается в исключении; новое легитимное
# вхождение добавляется сюда явно, с комментарием, а не глушит тест молча.
_WHITELIST: dict[str, str] = {}


def _en_pack_errors() -> dict[str, str]:
    with _EN_PACK.open(encoding="utf-8") as f:
        data = json.load(f)
    return data["errors"]


def test_en_pack_exists():
    assert _EN_PACK.is_file(), _EN_PACK


def test_en_pack_errors_values_do_not_say_contract():
    errors = _en_pack_errors()
    offenders = {
        key: text
        for key, text in errors.items()
        if key not in _WHITELIST and _CONTRACT_WORD_RE.search(text)
    }
    assert not offenders, (
        f"errors-неймспейс l10n/packs/en.json называет документ «contract» "
        f"в {len(offenders)} строк(е/ах) — глоссарий §1 требует «agreement»: {offenders}"
    )


def test_error_titles_en_registry_values_do_not_say_contract():
    offenders = {
        code: title
        for code, title in ERROR_TITLES_EN.items()
        if code not in _WHITELIST and _CONTRACT_WORD_RE.search(title)
    }
    assert not offenders, (
        f"common/api/error_texts.py::ERROR_TITLES_EN называет документ «contract» "
        f"в {len(offenders)} строк(е/ах) — глоссарий §1 требует «agreement»: {offenders}"
    )


def test_the_20_glossary_keys_now_say_agreement_in_en_pack():
    """Регрессия на конкретную правку (docs/tasks/Задача_feat_l10n-error-texts.md
    §2) — не только «нет contract», но и «есть agreement» там, где ожидается."""
    errors = _en_pack_errors()
    keys = [
        "counterparty_is_group",
        "self_dealing",
        "source_contract_not_accessible",
        "client_option_requires_code",
        "form_data_invalid",
        "draft_not_editable",
        "language_not_eligible",
        "not_initiator",
        "not_counterparty",
        "open_revisions",
        "leaf_sum_mismatch",
        "requisites_missing",
        "version_stale",
        "contract_not_signed",
        "amendment_change_target_not_found",
        "currency_mismatch",
        "milestone_wrong_contract",
        "loan_schedule_not_applicable",
        "gate_not_signed",
        "invalid_execution_transition",
    ]
    assert len(keys) == 20
    for key in keys:
        assert re.search(r"\bagreement\b", errors[key], re.IGNORECASE), (key, errors[key])


def test_counterparty_not_found_uses_ui_wording_not_legal_counterparty():
    """Глоссарий §3: «counterparty» — юрдокам, «the other party» — интерфейсу;
    ошибки — интерфейс."""
    errors = _en_pack_errors()
    assert errors["counterparty_not_found"] == "The other party was not found."


def test_key_names_are_untouched():
    """Постановка §2 п.4 — имена ключей и коды не менялись, только текст
    (27-язычные переводы и клиентский код завязаны на имена)."""
    errors = _en_pack_errors()
    assert "contract_not_signed" in errors
    assert "source_contract_not_accessible" in errors
    assert "milestone_wrong_contract" in errors
