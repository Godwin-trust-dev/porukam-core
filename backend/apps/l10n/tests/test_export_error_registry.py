"""feat/notifications-wiring: services.export_error_registry — сканирует
реальный backend/, не фикстуру, поэтому тесты проверяют ИНВАРИАНТЫ формы
результата (не хардкодят число кодов — оно меняется с кодовой базой, тем и
ценна команда, см. её докстринг), плюс несколько конкретных кодов, которые
не должны исчезнуть незаметно."""

from __future__ import annotations

from pathlib import Path

from django.conf import settings

from apps.l10n import services


def _registry() -> list[dict[str, object]]:
    return services.export_error_registry(Path(settings.BASE_DIR))


def test_registry_is_sorted_and_deduplicated_by_code() -> None:
    registry = _registry()
    codes = [entry["code"] for entry in registry]
    assert codes == sorted(codes)
    assert len(codes) == len(set(codes))


def test_direct_raise_code_is_found_with_title_and_site() -> None:
    registry = _registry()
    by_code = {entry["code"]: entry for entry in registry}
    assert "otp_invalid_code" in by_code
    entry = by_code["otp_invalid_code"]
    assert entry["generic"] is False
    assert entry["sites"]
    assert any(site["file"].endswith("api/views.py") for site in entry["sites"])
    assert all(isinstance(site["title"], str) and site["title"] for site in entry["sites"])


def test_service_error_status_dict_form_is_found() -> None:
    """`_SERVICE_ERROR_STATUS`-приём (apps.contracts/apps.milestones/
    apps.disputes/apps.evidence) — код, который существует ТОЛЬКО в этой
    форме (не в прямом `raise DomainAPIError(...)`), должен находиться:
    регрессионный тест на баг AnnAssign vs Assign (см. коммит)."""
    registry = _registry()
    by_code = {entry["code"]: entry for entry in registry}
    assert "milestone_depth_exceeded" in by_code
    assert by_code["milestone_depth_exceeded"]["sites"]


def test_code_with_multiple_distinct_titles_keeps_all_sites() -> None:
    """permission_denied — один code, много разных RU title по месту
    вызова (common/api/error_texts.py докстринг) — sites несёт их все."""
    registry = _registry()
    by_code = {entry["code"]: entry for entry in registry}
    entry = by_code["permission_denied"]
    titles = {site["title"] for site in entry["sites"]}
    assert len(titles) > 1
    assert len(entry["sites"]) > len(titles)  # некоторые title повторяются в нескольких файлах


def test_generic_status_fallback_codes_present_without_sites() -> None:
    """`rate_limited`/`conflict`/`error` — только обобщённый фолбэк по
    HTTP-статусу (common/api/exceptions.py::_STATUS_TO_CODE), ни разу не
    поднимаются как `DomainAPIError(code=...)` напрямую — в отличие от,
    например, `not_found`, который есть И как фолбэк-код, И как явный
    `code="not_found"` в apps.social/apps.contracts/... (тогда generic
    остаётся False — уже покрыт прямым raise, см. export_error_registry)."""
    registry = _registry()
    by_code = {entry["code"]: entry for entry in registry}
    for code in ("rate_limited", "conflict", "error"):
        assert by_code[code]["generic"] is True
        assert by_code[code]["sites"] == []
