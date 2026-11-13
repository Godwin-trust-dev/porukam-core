"""docs/tasks/l10n-wave.md §Л.2 п.3, ✅ приёмка: импорт тестового пакета
es → идемпотентность, версионирование, частичный пакет валиден."""

from __future__ import annotations

import pytest

from apps.l10n import services
from apps.l10n.models import Locale, LocalePack

pytestmark = pytest.mark.django_db


def _pack(**overrides: object) -> dict:
    base: dict = {
        "locale": "es",
        "name": "Español",
        "rtl": False,
        "quality": "machine",
        "pack_version": 1,
        "errors": {"otp_invalid_code": "Código incorrecto"},
        "notifications": {
            "contract.signed": {"subject": "Contrato firmado", "body": "Ambas partes firmaron."}
        },
        "catalog": {"spheres": {"design": "Diseño"}},
        "clauses": {"K2@1": "Texto del bloque K2"},
        "legal": {"disclaimer": None, "consents": {"pd_processing": None}},
    }
    base.update(overrides)
    return base


# --- import_pack: creación / idempotencia / versionado ---------------------


def test_import_pack_creates_locale_and_pack():
    result = services.import_pack(_pack())

    assert result.status == "created"
    assert result.locale_created is True
    locale = Locale.objects.get(code="es")
    assert locale.name == "Español"
    assert locale.quality == "machine"
    assert locale.enabled is True

    stored = LocalePack.objects.get(locale=locale)
    assert stored.pack_version == 1
    assert stored.content["errors"]["otp_invalid_code"] == "Código incorrecto"


def test_reimporting_identical_pack_is_a_no_op():
    services.import_pack(_pack())
    checksum_before = LocalePack.objects.get(locale_id="es").checksum

    result = services.import_pack(_pack())

    assert result.status == "no_op"
    assert LocalePack.objects.get(locale_id="es").checksum == checksum_before
    assert LocalePack.objects.filter(locale_id="es").count() == 1


def test_reimport_does_not_reset_enabled_flag_toggled_manually():
    services.import_pack(_pack())
    Locale.objects.filter(code="es").update(enabled=False)

    services.import_pack(_pack(pack_version=2, errors={"otp_invalid_code": "Nuevo texto"}))

    assert Locale.objects.get(code="es").enabled is False


def test_higher_pack_version_updates_content():
    services.import_pack(_pack())

    result = services.import_pack(_pack(pack_version=2, name="Español (actualizado)"))

    assert result.status == "updated"
    locale = Locale.objects.get(code="es")
    assert locale.name == "Español (actualizado)"
    assert LocalePack.objects.get(locale=locale).pack_version == 2


def test_stale_pack_version_is_rejected():
    services.import_pack(_pack(pack_version=5))

    with pytest.raises(services.StalePackError):
        services.import_pack(_pack(pack_version=3))


def test_same_version_different_content_is_a_conflict():
    services.import_pack(_pack(pack_version=1))

    with pytest.raises(services.PackVersionConflictError):
        services.import_pack(_pack(pack_version=1, name="Español (otro)"))


def test_partial_pack_without_optional_namespaces_is_valid():
    minimal = {
        "locale": "es",
        "name": "Español",
        "rtl": False,
        "quality": "machine",
        "pack_version": 1,
    }
    result = services.import_pack(minimal)
    assert result.status == "created"
    assert LocalePack.objects.get(locale_id="es").content == minimal


def test_import_pack_is_a_deep_copy_of_input():
    """Мутация словаря вызывающей стороной после import_pack не должна
    менять то, что уже сохранено в БД."""
    pack = _pack()
    services.import_pack(pack)
    pack["errors"]["otp_invalid_code"] = "mutado"

    stored = LocalePack.objects.get(locale_id="es")
    assert stored.content["errors"]["otp_invalid_code"] != "mutado"


# --- валидация формата -----------------------------------------------------


@pytest.mark.parametrize("field", ["locale", "name", "rtl", "quality", "pack_version"])
def test_missing_required_header_field_is_rejected(field: str):
    pack = _pack()
    del pack[field]
    with pytest.raises(services.PackValidationError):
        services.import_pack(pack)


def test_unknown_quality_is_rejected():
    with pytest.raises(services.PackValidationError):
        services.import_pack(_pack(quality="excellent"))


def test_unknown_top_level_namespace_is_rejected():
    with pytest.raises(services.PackValidationError):
        services.import_pack(_pack(marketing={"slogan": "…"}))


def test_underscore_prefixed_keys_are_ignored_as_comments():
    result = services.import_pack(_pack(_note="черновик, не для прода"))
    assert result.status == "created"


def test_non_string_error_value_is_rejected():
    with pytest.raises(services.PackValidationError):
        services.import_pack(_pack(errors={"otp_invalid_code": 42}))


def test_pack_version_zero_is_rejected():
    with pytest.raises(services.PackValidationError):
        services.import_pack(_pack(pack_version=0))
