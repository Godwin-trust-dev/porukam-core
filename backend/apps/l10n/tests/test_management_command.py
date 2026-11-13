"""✅ приёмка Л.2: `import_l10n_pack <file>` — импорт тестового пакета es →
GET /v1/locales отдаёт es (beta); повторный импорт — no-op."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from django.core.management import CommandError, call_command
from rest_framework.test import APIClient

from apps.l10n.management.commands.import_l10n_pack import Command
from apps.l10n.models import Locale, LocalePack

pytestmark = pytest.mark.django_db

_REPO_ROOT = Path(__file__).resolve().parents[4]
_ES_PACK = _REPO_ROOT / "l10n" / "packs" / "es.json"


def _write_pack(tmp_path: Path, name: str, pack: dict) -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    return path


_RU_V1 = {
    "locale": "ru",
    "name": "Русский",
    "rtl": False,
    "quality": "reviewed",
    "pack_version": 1,
    "errors": {"otp_invalid_code": "Неверный код", "rate_limited": "Слишком часто"},
}
_RU_V2 = {
    "locale": "ru",
    "name": "Русский",
    "rtl": False,
    "quality": "reviewed",
    "pack_version": 2,
    "errors": {
        "otp_invalid_code": "Код неверен",  # реальный конфликт — было в v1, другой текст
        "rate_limited": "Слишком часто",  # без изменений — не конфликт
        "new_key": "Новый текст",  # добавлен — не конфликт (нечего оставить старым)
    },
}


def test_repo_es_pack_exists():
    """Сверка окружения теста, не самого механизма — если файл переехал,
    остальные тесты этого модуля надо смотреть отдельно, а не молча падать
    на FileNotFoundError с непонятной трассировкой."""
    assert _ES_PACK.is_file(), _ES_PACK


def test_import_real_es_pack_creates_beta_locale():
    out = io.StringIO()
    call_command("import_l10n_pack", str(_ES_PACK), stdout=out)

    assert "es" in out.getvalue()
    locale = Locale.objects.get(code="es")
    assert locale.quality == Locale.Quality.MACHINE
    assert locale.enabled is True

    client = APIClient()
    resp = client.get("/v1/locales")
    by_code = {row["code"]: row for row in resp.data}
    assert by_code["es"]["quality"] == "machine"


def test_reimporting_same_file_is_a_no_op():
    call_command("import_l10n_pack", str(_ES_PACK), stdout=io.StringIO())
    pack_count_before = LocalePack.objects.filter(locale_id="es").count()

    out = io.StringIO()
    call_command("import_l10n_pack", str(_ES_PACK), stdout=out)

    assert "без изменений" in out.getvalue()
    assert LocalePack.objects.filter(locale_id="es").count() == pack_count_before == 1


def test_missing_file_raises_command_error():
    with pytest.raises(CommandError):
        call_command("import_l10n_pack", "/no/such/pack.json", stdout=io.StringIO())


def test_invalid_json_raises_command_error(tmp_path):
    bad = tmp_path / "broken.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(CommandError):
        call_command("import_l10n_pack", str(bad), stdout=io.StringIO())


def test_pack_missing_required_field_raises_command_error(tmp_path):
    pack = tmp_path / "es.json"
    pack.write_text(
        json.dumps({"name": "Español", "rtl": False, "quality": "machine", "pack_version": 1}),
        encoding="utf-8",
    )
    with pytest.raises(CommandError):
        call_command("import_l10n_pack", str(pack), stdout=io.StringIO())


# --- реимпорт ru: diff + «что оставить» -------------------------------


def test_ru_first_import_does_not_prompt(monkeypatch, tmp_path):
    """Нечего сравнивать (ru ещё не импортировался пакетом — сид миграции
    заводит только Locale, не LocalePack) — прогон без единого вопроса."""

    def _boom(self, prompt):
        raise AssertionError("не должно спрашивать при первом импорте ru")

    monkeypatch.setattr(Command, "_ask", _boom)
    path = _write_pack(tmp_path, "ru.json", _RU_V1)

    call_command("import_l10n_pack", str(path), stdout=io.StringIO())

    content = LocalePack.objects.get(locale_id="ru").content
    assert content["errors"]["otp_invalid_code"] == "Неверный код"


def test_ru_reimport_prints_diff_and_asks_only_real_conflicts(monkeypatch, tmp_path):
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru1.json", _RU_V1)), stdout=io.StringIO()
    )

    asked_paths: list[str] = []

    def _record_and_keep_new(self, prompt):
        asked_paths.append(prompt)
        return "n"

    monkeypatch.setattr(Command, "_ask", _record_and_keep_new)
    out = io.StringIO()
    call_command("import_l10n_pack", str(_write_pack(tmp_path, "ru2.json", _RU_V2)), stdout=out)

    assert len(asked_paths) == 1  # только otp_invalid_code — реальный конфликт
    assert "отличий от текущего пакета" in out.getvalue()


def test_ru_reimport_keeps_old_text_when_operator_chooses_old(monkeypatch, tmp_path):
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru1.json", _RU_V1)), stdout=io.StringIO()
    )
    monkeypatch.setattr(Command, "_ask", lambda self, prompt: "o")

    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru2.json", _RU_V2)), stdout=io.StringIO()
    )

    content = LocalePack.objects.get(locale_id="ru").content
    assert content["errors"]["otp_invalid_code"] == "Неверный код"  # оставили старое
    assert content["errors"]["rate_limited"] == "Слишком часто"  # без изменений
    assert content["errors"]["new_key"] == "Новый текст"  # добавленный ключ — без вопроса
    assert content["pack_version"] == 2  # версия пакета всё равно обновилась


def test_ru_reimport_keeps_new_text_when_operator_chooses_new(monkeypatch, tmp_path):
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru1.json", _RU_V1)), stdout=io.StringIO()
    )
    monkeypatch.setattr(Command, "_ask", lambda self, prompt: "n")

    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru2.json", _RU_V2)), stdout=io.StringIO()
    )

    content = LocalePack.objects.get(locale_id="ru").content
    assert content["errors"]["otp_invalid_code"] == "Код неверен"


def test_ru_reimport_yes_flag_skips_prompt_and_keeps_new(monkeypatch, tmp_path):
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "ru1.json", _RU_V1)), stdout=io.StringIO()
    )

    def _boom(self, prompt):
        raise AssertionError("--yes не должно спрашивать")

    monkeypatch.setattr(Command, "_ask", _boom)
    call_command(
        "import_l10n_pack",
        str(_write_pack(tmp_path, "ru2.json", _RU_V2)),
        "--yes",
        stdout=io.StringIO(),
    )

    content = LocalePack.objects.get(locale_id="ru").content
    assert content["errors"]["otp_invalid_code"] == "Код неверен"


def test_non_ru_locale_reimport_never_prompts(monkeypatch, tmp_path):
    def _boom(self, prompt):
        raise AssertionError("diff/prompt — только для ru")

    monkeypatch.setattr(Command, "_ask", _boom)

    es_v1 = {**_RU_V1, "locale": "es", "name": "Español", "quality": "machine"}
    es_v2 = {**_RU_V2, "locale": "es", "name": "Español", "quality": "machine"}
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "es1.json", es_v1)), stdout=io.StringIO()
    )
    call_command(
        "import_l10n_pack", str(_write_pack(tmp_path, "es2.json", es_v2)), stdout=io.StringIO()
    )

    content = LocalePack.objects.get(locale_id="es").content
    assert content["errors"]["otp_invalid_code"] == "Код неверен"
