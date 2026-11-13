"""Read-слой apps.l10n — справочник locale + фолбэк-чтение текста из
импортированных пакетов (Л.2 п.4: «фолбэк-цепочка запрошенный язык → en на
всех точках выдачи текстов — ГВ.5 механизм расширить, не дублировать»).

`get_pack_text`/`get_error_title`/… НЕ спускаются до `ru` — RU-контур
остаётся на своём отдельном, не тронутом этой веткой механизме
(name_i18n/body_i18n `.get(locale, "ru")`, common/i18n.py); здесь фолбэк
только `запрошенный → en`, как явно требует постановка."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from django.db.models import QuerySet

from .models import Locale, LocalePack


def list_enabled_locales() -> QuerySet[Locale]:
    """GET /v1/locales (Л.2 п.1) — активные языки с качеством, для бейджа
    beta на фронте (quality=machine)."""
    return Locale.objects.filter(enabled=True).order_by("code")


def is_locale_enabled(code: str) -> bool:
    """common/i18n.py::_parse_accept_language — код из Accept-Language
    считается поддерживаемым, только если для него есть включённый Locale
    (built-in ru/en — отдельно, common.i18n.SUPPORTED_LOCALES)."""
    return Locale.objects.filter(code=code, enabled=True).exists()


def match_enabled_locale(tag: str) -> str | None:
    """BCP-47-тег -> код включённого `Locale` (ADR-095).

    Заменяет прежнее огрубление «взять всё до дефиса» (common/i18n.py), из-за
    которого `pt-BR` превращался в `pt`, не находился среди `Locale.code`
    (там код ПАКЕТА, то есть ровно `pt-BR`) и молча падал в русский дефолт —
    для двух из 29 языков (`pt-BR`, `zh-Hans`) правило «текст на языке
    человека» не выполнялось вообще.

    Порядок сопоставления — сужение, потом расширение, оба шага нужны:
      1. точное совпадение без учёта регистра (`pt-br` -> `pt-BR`) — браузеры
         и клиенты пишут регион как попало, BCP-47 регистронезависим;
      2. отбрасывание правых субтегов (`de-DE` -> `de`) — классический
         RFC 4647 lookup: региональный вариант читается языком без региона;
      3. единственный региональный вариант при запросе примарной подгруппы
         (`pt` -> `pt-BR`, `zh` -> `zh-Hans`) — обратное направление шага 2.
         Только если такой вариант ОДИН: при двух (`pt-BR`/`pt-PT`) выбор за
         человека делать нельзя, честнее отдать фолбэк.

    `None` — под тег нет включённого языка; вызывающая сторона решает свой
    фолбэк (built-in пара ru/en, DEFAULT_LOCALE и т. п.)."""
    normalized = tag.strip()
    if not normalized:
        return None

    enabled = list(Locale.objects.filter(enabled=True).values_list("code", flat=True))
    by_lower = {code.lower(): code for code in enabled}

    candidate = normalized.lower()
    if candidate in by_lower:
        return by_lower[candidate]

    while "-" in candidate:
        candidate = candidate.rsplit("-", 1)[0]
        if candidate in by_lower:
            return by_lower[candidate]

    prefix = f"{candidate}-"
    variants = [code for code in enabled if code.lower().startswith(prefix)]
    if len(variants) == 1:
        return variants[0]
    return None


_REVIEWED_OR_BETTER = (Locale.Quality.CANONICAL, Locale.Quality.REVIEWED)


def is_reviewed_or_better(code: str) -> bool:
    """quality >= reviewed (Л.1, docs/tasks/l10n-wave.md, уточнение к доку 32
    v1.2, финал, ADR-078): официальный язык договора — либо общий язык
    интерфейса обеих сторон, либо явный override через PATCH черновика —
    годится только при quality >= reviewed. `machine` (beta), выключенный
    или несуществующий Locale — False; вызывающая сторона
    (apps.contracts.services._resolve_official_language/patch_draft) решает
    свой фолбэк/ошибку."""
    return Locale.objects.filter(code=code, enabled=True, quality__in=_REVIEWED_OR_BETTER).exists()


# Язык, который юридически главный при расхождении переводов (решение владельца
# 17.08.2026, docs/tasks/Задача_feat_l10n-launch-surfaces.md §3 «Authoritative
# → EN»; совпадает с EN-каноном ADR-079 и с целью фолбэк-цепочки ниже — это
# один и тот же факт, а не два независимых).
AUTHORITATIVE_LOCALE = "en"


def _fallback_chain(locale: str) -> Iterable[str]:
    """locale → en (Л.2 п.4). en сам себе фолбэк (список из одного)."""
    if locale == "en":
        return ("en",)
    return (locale, "en")


def _pack_content(locale_code: str) -> dict[str, Any] | None:
    pack = LocalePack.objects.filter(locale_id=locale_code).first()
    return pack.content if pack else None


def _dig(content: dict[str, Any], *keys: str) -> object | None:
    node: object = content
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def get_pack_text(namespace: str, key: str, *, locale: str) -> str | None:
    """Текст `namespace.key` (например `errors.otp_invalid_code`,
    `catalog.spheres.design`, `clauses.K2@1`) с фолбэком locale → en по
    импортированным пакетам. `None`, если ни в одном пакете цепочки нет
    непустой строки по этому ключу — вызывающая сторона решает свой
    дальнейший фолбэк (built-in EN-реестр, RU-текст и т.п.)."""
    for candidate in _fallback_chain(locale):
        content = _pack_content(candidate)
        if content is None:
            continue
        value = _dig(content, namespace, key)
        if isinstance(value, str) and value:
            return value
    return None


def get_error_title(code: str, *, locale: str) -> str | None:
    """`errors.<code>` — заголовок application/problem+json
    (common/api/exceptions.py::problem_json_exception_handler)."""
    return get_pack_text("errors", code, locale=locale)


def get_notification_text(topic: str, *, locale: str) -> dict[str, str] | None:
    """`notifications.<topic>` целиком ({"subject", "body"}) с фолбэком
    locale → en; частично заполненная запись (только subject или только
    body) отдаётся как есть — вызывающая сторона решает, чем закрыть
    недостающее поле (например body_i18n RU-контура)."""
    for candidate in _fallback_chain(locale):
        content = _pack_content(candidate)
        if content is None:
            continue
        entry = _dig(content, "notifications", topic)
        if isinstance(entry, dict) and entry:
            return {k: v for k, v in entry.items() if isinstance(v, str)}
    return None


def get_catalog_text(sub_namespace: str, code: str, *, locale: str) -> str | None:
    """`catalog.<sub_namespace>.<code>` (`spheres`/`contract_types`/… —
    состав по факту сгенерированных пакетов, l10n/README.md)."""
    for candidate in _fallback_chain(locale):
        content = _pack_content(candidate)
        if content is None:
            continue
        value = _dig(content, "catalog", sub_namespace, code)
        if isinstance(value, str) and value:
            return value
    return None


def get_catalog_map(sub_namespace: str, *, locale: str) -> dict[str, str]:
    """Весь `catalog.<sub_namespace>` одним словарём `{code: текст}` с
    фолбэком locale → en НА УРОВНЕ КЛЮЧА (en-значения, перекрытые значениями
    запрошенного языка). Для справочных выдач списком (`GET /spheres`,
    `GET /work-types`, ADR-097) — `get_catalog_text` в цикле делал бы по
    2 запроса к `LocalePack` на каждый код; здесь — не больше двух на весь
    список. Пустой словарь — пакеты не импортированы: вызывающая сторона
    решает свой фолбэк (name_i18n, код)."""
    result: dict[str, str] = {}
    for candidate in reversed(tuple(_fallback_chain(locale))):
        content = _pack_content(candidate)
        if content is None:
            continue
        mapping = _dig(content, "catalog", sub_namespace)
        if not isinstance(mapping, dict):
            continue
        result.update(
            {key: value for key, value in mapping.items() if isinstance(value, str) and value}
        )
    return result


def get_ui_map(prefix: str, *, locale: str) -> dict[str, str]:
    """`ui.<prefix>*` одним словарём `{ключ: текст}` с фолбэком locale → en на
    уровне ключа — тот же приём, что `get_catalog_map`, для выдач списком
    (хроника договора: `ui.timeline.<kind>`, ADR-134 — иначе по 2 запроса к
    `LocalePack` на каждый элемент ленты). Пустой словарь — пакеты не
    импортированы; вызывающая сторона решает свой фолбэк (ключ как есть)."""
    result: dict[str, str] = {}
    for candidate in reversed(tuple(_fallback_chain(locale))):
        content = _pack_content(candidate)
        if content is None:
            continue
        mapping = _dig(content, "ui")
        if not isinstance(mapping, dict):
            continue
        result.update(
            {
                key: value
                for key, value in mapping.items()
                if key.startswith(prefix) and isinstance(value, str) and value
            }
        )
    return result


def get_clause_text(block_id: str, template_version: int | str, *, locale: str) -> str | None:
    """`clauses.<block_id>@<template_version>` (Л.2 п.2) — переводы
    ClauseTemplate; ключ строковый, без FK на apps.contracts/apps.catalog
    (нижний слой ни от кого не зависит) — сверка block_id/version с
    реальным ClauseTemplate остаётся за вызывающей стороной."""
    return get_pack_text("clauses", f"{block_id}@{template_version}", locale=locale)


@dataclass(frozen=True)
class LegalDocument:
    """Юр-документ платформы (Privacy Policy / Terms of Service) на языке
    пользователя — `GET /v1/legal/<doc>`, docs/tasks/
    Задача_feat_l10n-launch-surfaces.md §B.

    `locale` — язык, на котором текст РЕАЛЬНО нашёлся (не запрошенный): при
    честном исполнении правила «каждое слово на языке пользователя» он
    совпадает с запрошенным, но фолбэк на `en` остаётся защитой (§3
    постановки), и вызывающая сторона должна знать, что сработал именно он —
    иначе интерфейс покажет английский текст, утверждая, что он на языке
    пользователя.

    `quality` — `Locale.Quality` того же фактического языка: основание для
    тихой пометки «машинный перевод» на документе."""

    key: str
    locale: str
    body: str
    notice: str | None
    quality: str


def get_legal_document(key: str, *, locale: str) -> LegalDocument | None:
    """`legal.<key>` (`privacy`/`tos`) как ДОКУМЕНТ: текст + оговорка об
    основной версии (`legal.document_notice` того же пакета) + фактический
    язык и его quality. Та же фолбэк-цепочка, что `get_legal_text`
    (запрошенный → en), но с ответом на вопрос «какой язык ответил» —
    `get_legal_text` его теряет, а документу он нужен (см. docstring
    LegalDocument).

    Оговорка берётся из ТОГО ЖЕ пакета, что тело: разноязычная пара
    («текст по-английски, оговорка по-испански») хуже отсутствия оговорки —
    поэтому `None`, если в пакете-источнике её нет."""
    for candidate in _fallback_chain(locale):
        content = _pack_content(candidate)
        if content is None:
            continue
        body = _dig(content, "legal", key)
        if not (isinstance(body, str) and body):
            continue
        notice = _dig(content, "legal", "document_notice")
        quality = Locale.objects.filter(code=candidate).values_list("quality", flat=True).first()
        return LegalDocument(
            key=key,
            locale=candidate,
            body=body,
            notice=notice if isinstance(notice, str) and notice else None,
            quality=quality or Locale.Quality.MACHINE,
        )
    return None


def get_legal_text(key: str, *, locale: str) -> str | None:
    """`legal.<key>` (плоские ключи, например `disclaimer`) или
    `legal.<group>.<key>` через точку в `key` (например
    `consents.pd_processing`) — юртексты заполняются только после Ю-23,
    до тех пор ключи пусты (`null` в пакете) — это валидно, возвращается
    None, как и для отсутствующего ключа."""
    parts = ["legal", *key.split(".")]
    for candidate in _fallback_chain(locale):
        content = _pack_content(candidate)
        if content is None:
            continue
        value = _dig(content, *parts)
        if isinstance(value, str) and value:
            return value
    return None
