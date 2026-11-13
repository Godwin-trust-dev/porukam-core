"""Use cases apps.l10n (Л.2, docs/tasks/l10n-wave.md п.3) — импорт языкового
пакета: идемпотентный, версионированный, частичный пакет валиден.

`import_pack` — единственная точка записи; вызывается из management-команды
`import_l10n_pack` (тонкая обёртка, вся логика здесь, не в Command.handle,
по образцу services.audit_vault.api.verify_chain)."""

from __future__ import annotations

import ast
import copy
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from django.db import transaction

from .models import Locale, LocalePack

# Namespace'ы, несущие переводимый текст (в отличие от полей шапки
# locale/name/rtl/quality/pack_version) — используются diff_pack_texts для
# сравнения версий пакета "по текстам", не по метаданным.
_TEXT_NAMESPACES = ("errors", "notifications", "catalog", "clauses", "legal", "ui")

# Namespace-ключи верхнего уровня, которые пакет МОЖЕТ нести (Л.2 п.2,
# l10n/README.md — схема). Ключи, начинающиеся с "_" (например "_note"),
# всегда разрешены и молча игнорируются как комментарий составителя пакета.
_KNOWN_NAMESPACES = {"errors", "notifications", "catalog", "clauses", "legal", "ui"}
_REQUIRED_HEADER_FIELDS = ("locale", "name", "rtl", "quality", "pack_version")


class PackValidationError(ValueError):
    """Пакет не соответствует формату l10n/README.md — отсутствует
    обязательное поле шапки, неизвестный namespace или неверный тип
    значения. Импорт не начинается (валидация — до любой записи в БД)."""


class StalePackError(ValueError):
    """`pack_version` файла меньше уже импортированного — операция,
    вероятно, по ошибке откатывает язык на старую версию; повторный импорт
    актуальной версии должен идти отдельным явным пакетом с новым
    pack_version, не понижением."""


class PackVersionConflictError(ValueError):
    """`pack_version` совпадает с уже импортированным, но содержимое
    отличается — версионирование пакета нарушено (тот же номер не может
    значить два разных содержимых). Бump pack_version в файле и повторить."""


@dataclass(frozen=True)
class ImportResult:
    locale_code: str
    pack_version: int
    status: Literal["created", "updated", "no_op"]
    locale_created: bool


def _require(condition: object, message: str) -> None:
    if not condition:
        raise PackValidationError(message)


def _validate_string_map(value: Any, *, path: str, allow_none: bool = False) -> None:
    _require(isinstance(value, dict), f"{path}: ожидался объект (dict)")
    for key, item in value.items():
        _require(isinstance(key, str) and key, f"{path}: ключ должен быть непустой строкой")
        if item is None:
            _require(allow_none, f"{path}.{key}: null не допускается в этом namespace")
        else:
            _require(isinstance(item, str), f"{path}.{key}: ожидалась строка")


def _validate_pack_shape(data: dict[str, Any]) -> None:
    _require(isinstance(data, dict), "пакет должен быть JSON-объектом")

    for field in _REQUIRED_HEADER_FIELDS:
        _require(field in data, f"отсутствует обязательное поле шапки: {field}")

    _require(isinstance(data["locale"], str) and data["locale"], "locale: непустая строка")
    _require(isinstance(data["name"], str) and data["name"], "name: непустая строка")
    _require(isinstance(data["rtl"], bool), "rtl: булево значение")
    _require(
        data["quality"] in Locale.Quality.values,
        f"quality: одно из {sorted(Locale.Quality.values)}",
    )
    _require(
        isinstance(data["pack_version"], int)
        and not isinstance(data["pack_version"], bool)
        and data["pack_version"] >= 1,
        "pack_version: целое число ≥ 1",
    )

    for key in data:
        if key in _REQUIRED_HEADER_FIELDS or key in _KNOWN_NAMESPACES or key.startswith("_"):
            continue
        raise PackValidationError(f"неизвестное поле пакета: {key}")

    if "errors" in data:
        _validate_string_map(data["errors"], path="errors")

    if "notifications" in data:
        notifications = data["notifications"]
        _require(isinstance(notifications, dict), "notifications: ожидался объект (dict)")
        for topic, entry in notifications.items():
            _require(isinstance(topic, str) and topic, "notifications: ключ-топик — строка")
            _require(isinstance(entry, dict), f"notifications.{topic}: ожидался объект")
            for field in ("subject", "body"):
                if field in entry:
                    _require(
                        isinstance(entry[field], str), f"notifications.{topic}.{field}: строка"
                    )

    if "catalog" in data:
        catalog = data["catalog"]
        _require(isinstance(catalog, dict), "catalog: ожидался объект (dict)")
        for sub_ns, mapping in catalog.items():
            _validate_string_map(mapping, path=f"catalog.{sub_ns}")

    if "clauses" in data:
        _validate_string_map(data["clauses"], path="clauses")

    if "legal" in data:
        legal = data["legal"]
        _require(isinstance(legal, dict), "legal: ожидался объект (dict)")
        for key, value in legal.items():
            if isinstance(value, dict):
                _validate_string_map(value, path=f"legal.{key}", allow_none=True)
            elif value is not None:
                _require(isinstance(value, str), f"legal.{key}: строка или null")

    if "ui" in data:
        _validate_string_map(data["ui"], path="ui")


def _checksum(data: dict[str, Any]) -> str:
    """sha256 по содержимому пакета БЕЗ pack_version — версия сверяется
    отдельно (StalePackError/PackVersionConflictError); всё остальное
    (включая шапку name/rtl/quality) — часть версионируемого содержимого:
    правка любого из них без bump pack_version — конфликт версии."""
    payload = {key: value for key, value in data.items() if key != "pack_version"}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@transaction.atomic
def import_pack(data: dict[str, Any]) -> ImportResult:
    """Импорт языкового пакета (Л.2 п.3): идемпотентный (тот же
    pack_version + то же содержимое — no-op), версионированный (pack_version
    строго растёт), частичный (namespaces могут отсутствовать — фолбэк на
    EN в apps.l10n.selectors, не здесь). Автосоздаёт/обновляет `Locale` из
    шапки — `enabled` НЕ трогается при обновлении (True только при первом
    создании; включение/выключение языка — отдельный ручной рубильник,
    docstring Locale)."""
    _validate_pack_shape(data)

    locale_code = data["locale"]
    pack_version = data["pack_version"]
    checksum = _checksum(data)

    locale, locale_created = Locale.objects.get_or_create(
        code=locale_code,
        defaults={
            "name": data["name"],
            "rtl": data["rtl"],
            "quality": data["quality"],
            "enabled": True,
        },
    )
    if not locale_created:
        locale.name = data["name"]
        locale.rtl = data["rtl"]
        locale.quality = data["quality"]
        locale.save(update_fields=["name", "rtl", "quality", "updated_at"])

    existing = LocalePack.objects.filter(locale=locale).first()
    if existing is None:
        LocalePack.objects.create(
            locale=locale, pack_version=pack_version, checksum=checksum, content=data
        )
        return ImportResult(
            locale_code=locale_code,
            pack_version=pack_version,
            status="created",
            locale_created=locale_created,
        )

    if pack_version < existing.pack_version:
        raise StalePackError(
            f"{locale_code}: pack_version={pack_version} меньше уже импортированного "
            f"({existing.pack_version})"
        )

    if pack_version == existing.pack_version:
        if checksum == existing.checksum:
            return ImportResult(
                locale_code=locale_code,
                pack_version=pack_version,
                status="no_op",
                locale_created=locale_created,
            )
        raise PackVersionConflictError(
            f"{locale_code}: pack_version={pack_version} уже импортирован с другим "
            "содержимым — увеличьте pack_version"
        )

    existing.pack_version = pack_version
    existing.checksum = checksum
    existing.content = data
    existing.save(update_fields=["pack_version", "checksum", "content", "imported_at"])
    return ImportResult(
        locale_code=locale_code,
        pack_version=pack_version,
        status="updated",
        locale_created=locale_created,
    )


def _flatten_texts(content: dict[str, Any]) -> dict[str, str]:
    """Плоские `dotted.path` → текст по namespace'ам с переводимым
    содержимым (`_TEXT_NAMESPACES`) — не включает шапку (locale/name/rtl/
    quality/pack_version, это метаданные, не «текст»)."""
    flat: dict[str, str] = {}

    def walk(node: Any, path: list[str]) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, [*path, key])
        elif isinstance(node, str) and node:
            flat[".".join(path)] = node

    for namespace in _TEXT_NAMESPACES:
        if namespace in content:
            walk(content[namespace], [namespace])
    return flat


def diff_pack_texts(
    old: dict[str, Any] | None, new: dict[str, Any]
) -> dict[str, tuple[str | None, str | None]]:
    """`{dotted.path: (старый_текст|None, новый_текст|None)}` только для
    путей, где значение отличается. Используется management-командой для
    интерактивного подтверждения при реимпорте `ru` — единственной locale
    с уже ревьюленным вручную контентом (риск случайной перезаписи, чего
    нет у остальных locale, где пакет — единственный источник)."""
    old_flat = _flatten_texts(old) if old else {}
    new_flat = _flatten_texts(new)
    paths = set(old_flat) | set(new_flat)
    return {
        path: (old_flat.get(path), new_flat.get(path))
        for path in paths
        if old_flat.get(path) != new_flat.get(path)
    }


def apply_text_overrides(data: dict[str, Any], overrides: dict[str, str]) -> dict[str, Any]:
    """Копия `data` (deep copy — исходный словарь не мутируется) с
    точечно применёнными `overrides` по `dotted.path` — оператор решил
    оставить старый текст вместо пришедшего в новом пакете."""
    result = copy.deepcopy(data)
    for path, value in overrides.items():
        *parents, leaf = path.split(".")
        node = result
        for key in parents:
            node = node.setdefault(key, {})
        node[leaf] = value
    return result


# --- export_error_registry (feat/notifications-wiring) ---------------------
#
# `management.commands.export_error_registry` — JSON всех кодов
# application/problem+json (common/api/exceptions.py::problem_json_
# exception_handler) с текущим RU title и местом вызова, для патч-пакетов
# переводов (l10n/README.md — namespace `errors`). Источник правды —
# СЫРОЙ КОД (AST), не реестр вроде common/api/error_texts.py::
# ERROR_TITLES_EN (тот сам неполный по докстрингу, ЧТО и вызвало
# необходимость этой команды — см. отчёт-сверку chore/l10n-import PR) —
# статический анализ гарантирует, что список не устареет молча вместе с
# кодом, как устарел бы рукописный список.
#
# Два источника `code`, оба разбираются AST'ом, без импорта самих модулей
# (raise DomainAPIError(...) не должен исполниться, чтобы его найти):
#   1. `raise DomainAPIError(status_code=..., code="...", title="...")` —
#      прямые вызовы (apps/*/api/views.py, apps/*/permissions.py).
#   2. Модульные dict-константы вида `{ИсключениеТип: (status, "code",
#      "title")}` (приём apps.contracts/apps.milestones/apps.disputes/
#      apps.evidence — «_SERVICE_ERROR_STATUS», docstring problem.py) —
#      находится по форме (dict, значения — 3-элементные кортежи), не по
#      конкретному имени переменной (имя не гарантировано одинаковым).
# Плюс `common/api/exceptions.py::_STATUS_TO_CODE` — обобщённые коды по
# HTTP-статусу (title там = сам code, не текст, помечены generic=true).


@dataclass(frozen=True)
class ErrorSite:
    file: str
    line: int
    title: str


@dataclass(frozen=True)
class ErrorCodeEntry:
    code: str
    status_code: str | None
    generic: bool
    sites: list[ErrorSite]


def _unparse(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except (SyntaxError, ValueError):  # pragma: no cover — защитный фолбэк, не ожидается
        return None


def _literal_str(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _scan_direct_raises(tree: ast.Module, rel_path: str) -> dict[str, list[ErrorSite]]:
    """`raise DomainAPIError(status_code=..., code="...", title="...")` —
    ищем и `raise DomainAPIError(...)`, и голый `DomainAPIError(...)`
    (некоторые вызовы возвращают исключение переменной перед raise)."""
    found: dict[str, list[ErrorSite]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name != "DomainAPIError":
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        code = _literal_str(kwargs.get("code"))
        title = _literal_str(kwargs.get("title"))
        if code is None or title is None:
            continue
        found.setdefault(code, []).append(ErrorSite(file=rel_path, line=node.lineno, title=title))
    return found


def _scan_status_dicts(tree: ast.Module, rel_path: str) -> dict[str, list[ErrorSite]]:
    """Модульные dict-константы `{Тип: (status, "code", "title")}` —
    распознаётся по ФОРМЕ (значения — 3-элементные кортежи, второй и
    третий элемент — строковые литералы), не по имени переменной.
    `AnnAssign`, не `Assign` — реальное объявление несёт тип-аннотацию
    (`_SERVICE_ERROR_STATUS: dict[type[Exception], tuple[int, str, str]] =
    {...}`, apps/contracts/api/views.py и аналоги в apps.milestones/
    apps.disputes/apps.evidence)."""
    found: dict[str, list[ErrorSite]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)) or not isinstance(
            node.value, ast.Dict
        ):
            continue
        for value in node.value.values:
            if not isinstance(value, ast.Tuple) or len(value.elts) != 3:
                continue
            entry_code = _literal_str(value.elts[1])
            entry_title = _literal_str(value.elts[2])
            if entry_code is None or entry_title is None:
                continue
            found.setdefault(entry_code, []).append(
                ErrorSite(file=rel_path, line=value.lineno, title=entry_title)
            )
    return found


def _scan_direct_raise_status_codes(tree: ast.Module) -> dict[str, str | None]:
    """`status_code=` тех же прямых `raise DomainAPIError(...)`, что
    `_scan_direct_raises` — отдельным проходом (для dict-формы
    `_SERVICE_ERROR_STATUS` первый элемент кортежа не восстанавливаем,
    контекст файла и так очевиден, второй полный обход того не стоит)."""
    found: dict[str, str | None] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name != "DomainAPIError":
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        code = _literal_str(kwargs.get("code"))
        if code is not None and code not in found:
            found[code] = _unparse(kwargs.get("status_code"))
    return found


def _scan_generic_status_to_code(exceptions_path: Path) -> dict[int, str]:
    """`common/api/exceptions.py::_STATUS_TO_CODE` — обобщённые коды по
    HTTP-статусу (без собственного title — используется код как есть)."""
    if not exceptions_path.exists():
        return {}
    tree = ast.parse(exceptions_path.read_text(encoding="utf-8"), filename=str(exceptions_path))
    status_to_code: dict[int, str] = {}
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Dict)
            and any(isinstance(t, ast.Name) and t.id == "_STATUS_TO_CODE" for t in node.targets)
        ):
            continue
        for key, value in zip(node.value.keys, node.value.values, strict=True):
            entry_code = _literal_str(value)
            if isinstance(key, ast.Constant) and isinstance(key.value, int) and entry_code:
                status_to_code[key.value] = entry_code
    return status_to_code


def export_error_registry(base_dir: Path | str) -> list[dict[str, object]]:
    """Реестр всех кодов application/problem+json — сканирует
    `apps/*/api/views.py`, `apps/*/permissions.py` (DomainAPIError) и
    `common/api/exceptions.py` (`_STATUS_TO_CODE`, обобщённый фолбэк по
    HTTP-статусу — без собственного title, `generic=true`, `sites=[]`).
    Один code может встречаться в НЕСКОЛЬКИХ местах с РАЗНЫМ RU title
    (common/api/error_texts.py докстринг: «Один код может обслуживать
    разные RU title в разных вызовах») — `sites` несёт их все, не первый
    попавшийся."""
    base = Path(base_dir)
    by_code: dict[str, list[ErrorSite]] = {}
    status_by_code: dict[str, str | None] = {}

    candidates = [*base.glob("apps/*/api/views.py"), *base.glob("apps/*/permissions.py")]
    for path in candidates:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        rel_path = str(path.relative_to(base))
        for code, sites in _scan_direct_raises(tree, rel_path).items():
            by_code.setdefault(code, []).extend(sites)
        for code, sites in _scan_status_dicts(tree, rel_path).items():
            by_code.setdefault(code, []).extend(sites)
        for code, status_code in _scan_direct_raise_status_codes(tree).items():
            status_by_code.setdefault(code, status_code)

    status_to_code = _scan_generic_status_to_code(base / "common" / "api" / "exceptions.py")

    entries = [
        ErrorCodeEntry(
            code=code,
            status_code=status_by_code.get(code),
            generic=False,
            sites=sorted(sites, key=lambda s: (s.file, s.line)),
        )
        for code, sites in by_code.items()
    ]
    known_codes = set(by_code)
    for status_num, generic_code in status_to_code.items():
        if generic_code in known_codes:
            continue
        entries.append(
            ErrorCodeEntry(code=generic_code, status_code=str(status_num), generic=True, sites=[])
        )
    entries.append(ErrorCodeEntry(code="error", status_code=None, generic=True, sites=[]))

    return [asdict(entry) for entry in sorted(entries, key=lambda e: e.code)]
