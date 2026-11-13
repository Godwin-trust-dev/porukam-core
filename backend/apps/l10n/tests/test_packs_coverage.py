"""Полнота языковых пакетов (ADR-095) — стражник против «тихого EN-фолбэка».

Фолбэк-цепочка `запрошенный язык -> en` (apps.l10n.selectors) спроектирована
как ЗАЩИТА, а не как норма: она не даёт пустого экрана, но ценой того, что
человек, выбравший немецкий, читает английский текст и никакой ошибки при
этом нигде не возникает. Именно так 27 из 29 языков жили без половины
уведомлений — конвейер контент-волн просто не заводил эти ключи, и заметить
это можно было только глазами.

Поэтому проверяется не «перевод хороший» (машинный перевод оценивает
человек, l10n/README.md), а «ключ физически есть в КАЖДОМ пакете» — то, что
проверяемо и что молча деградировало.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from django.conf import settings

_REPO_ROOT = Path(__file__).resolve().parents[4]
_PACKS_DIR = _REPO_ROOT / "l10n" / "packs"

_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def _packs() -> dict[str, Any]:
    return {
        p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(_PACKS_DIR.glob("*.json"))
    }


_PACKS = _packs()
_LOCALES = sorted(_PACKS)
# Коды шаблонов, которые ищутся в пакете по ключу `notifications.<код>`
# (apps.notifications.selectors.render_body). Берём из настроек, а не списком
# здесь: новый топик в любом из двух реестров обязан сразу же требовать
# переводов, иначе тест снова начнёт «проходить» на неполном наборе.


def _template_codes(registry: dict[str, Any]) -> set[str]:
    """Строка — код как есть; словарь `дискриминатор -> код` (apps.
    notifications.subscriber._resolve_template_code) — все его непустые
    значения (`None` = «уведомления по этому варианту нет», кода не даёт)."""
    codes: set[str] = set()
    for spec in registry.values():
        if isinstance(spec, str):
            codes.add(spec)
        else:
            codes.update(code for code in spec.values() if code)
    return codes


# ОБА реестра ADR-126/ADR-178: у события может быть до двух аудиторий —
# адресат (NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES, ADR-178: получатель
# ЗАВЕДОМО НЕ актор) и стороны договора кроме актора
# (NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES). Топик, живущий ТОЛЬКО во втором
# реестре (`payment.created`, `evidence.archived`, ADR-155
# `milestone.material_handed_over`), адресуется живому человеку так же, как
# любой другой, — пропуск его ключа в пакете даёт тот же тихий EN-фолбэк.
# Пока тест смотрел на один реестр, `milestone.material_handed_over` появился
# только в ru/en и в 27 языках был не виден.
_TOPIC_TEMPLATE_CODES = sorted(
    _template_codes(settings.NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES)
    | _template_codes(settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES)
)
# ADR-156: `contract.materials_changed` — единственный код, которого нет ни в
# одном реестре топик->шаблон: карточка размещается не по событию, а по
# ЗАКРЫТИЮ окна схлопывания правок материалов (свип
# apps.notifications.tasks.sweep_materials_change_digests). Из-под стражника
# он из-за этого выпадал бы — дописываем явно. Строкой, а не импортом
# `apps.notifications.models.MATERIALS_CHANGED_TEMPLATE`: apps.l10n — нижний
# слой, импорт продуктового приложения запрещён import-linter'ом; расхождение
# ловит тест apps/notifications/tests/test_materials_changed.py, который
# берёт код из самой константы.
_TOPIC_TEMPLATE_CODES = sorted({*_TOPIC_TEMPLATE_CODES, "contract.materials_changed"})


def test_packs_dir_has_every_registered_locale():
    """Реестр языков фронта и пакеты бэкенда — один и тот же список
    (зеркало web/tests/localePacks.test.ts со стороны бэкенда)."""
    assert len(_LOCALES) >= 29, _LOCALES


@pytest.mark.parametrize("code", _TOPIC_TEMPLATE_CODES)
def test_every_notification_topic_is_translated_everywhere(code: str):
    """Уведомление — юридически значимый канал (domain-model.md §17). Язык
    письма выбирает получатель (ADR-095), поэтому пропуск ключа означает
    английское письмо человеку, который английского не выбирал."""
    missing = [
        locale
        for locale in _LOCALES
        if not (
            isinstance(_PACKS[locale].get("notifications", {}).get(code), dict)
            and _PACKS[locale]["notifications"][code].get("subject")
            and _PACKS[locale]["notifications"][code].get("body")
        )
    ]
    assert not missing, f"notifications.{code} нет в пакетах: {', '.join(missing)}"


@pytest.mark.parametrize("code", _TOPIC_TEMPLATE_CODES)
def test_notification_placeholders_match_en_canon(code: str):
    """Набор `{placeholder}` обязан совпадать с EN-каноном: лишний
    плейсхолдер отрендерится буквально (так в пакетах ar/fa/he жил
    `{sender_name}`, которого нет ни в одном payload бэкенда), недостающий —
    молча съест данные события."""
    canon = _PLACEHOLDER_RE.findall(_PACKS["en"]["notifications"][code]["body"])
    for locale in _LOCALES:
        body = _PACKS[locale]["notifications"][code]["body"]
        assert sorted(_PLACEHOLDER_RE.findall(body)) == sorted(canon), (
            f"{locale}: notifications.{code}.body — плейсхолдеры разошлись с en"
        )


def test_error_titles_have_no_holes_relative_to_en():
    """`errors` — заголовок problem+json, который видит человек при каждом
    отказе. EN-пакет здесь канон: ключ, который есть в нём и отсутствует в
    другом языке, — ровно тот тихий фолбэк, ради которого написан тест."""
    canon = {code for code, text in _PACKS["en"]["errors"].items() if text}
    holes = {
        locale: sorted(canon - {c for c, t in _PACKS[locale].get("errors", {}).items() if t})
        for locale in _LOCALES
    }
    holes = {locale: codes for locale, codes in holes.items() if codes}
    assert not holes, f"errors без перевода: {holes}"
