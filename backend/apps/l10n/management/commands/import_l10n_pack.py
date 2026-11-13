"""Л.2 п.3 (docs/tasks/l10n-wave.md): `import_l10n_pack <file>` —
идемпотентная, версионированная, тонкая обёртка над apps.l10n.services.
import_pack (вся логика — там, не здесь, по образцу
services.audit_vault.management.commands.verify_audit_chain).

Реимпорт `ru` — особый случай: это единственная locale с уже ревьюленным
вручную контентом (RU-контур), случайная перезапись пакетом — риск,
которого нет у остальных locale (там пакет — единственный источник).
Перед импортом пакета с `locale: "ru"`, если для ru уже есть импортированный
пакет, команда печатает diff по текстам (`services.diff_pack_texts`) и для
каждого РЕАЛЬНОГО конфликта (текст был и там, и там, и отличается —
не для добавленных/удалённых ключей, там оставить нечего) спрашивает,
что оставить. `--yes` — не спрашивать, оставить текст из нового пакета
(для неинтерактивных прогонов)."""

from __future__ import annotations

import json
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from apps.l10n import services
from apps.l10n.models import LocalePack


class Command(BaseCommand):
    help = "Импортирует языковой пакет l10n/packs/<code>.json (apps.l10n.services.import_pack)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("pack_file", type=str, help="Путь к JSON-файлу пакета")
        parser.add_argument(
            "--yes",
            "-y",
            action="store_true",
            help="Не спрашивать при конфликте текстов ru — оставлять текст из нового пакета",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        path = options["pack_file"]
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except OSError as exc:
            raise CommandError(f"не удалось прочитать {path}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise CommandError(f"{path}: невалидный JSON — {exc}") from exc

        if isinstance(data, dict) and data.get("locale") == "ru":
            data = self._resolve_ru_conflicts(data, auto_yes=options["yes"])

        try:
            result = services.import_pack(data)
        except services.PackValidationError as exc:
            raise CommandError(f"{path}: пакет не прошёл валидацию — {exc}") from exc
        except (services.StalePackError, services.PackVersionConflictError) as exc:
            raise CommandError(str(exc)) from exc

        messages = {
            "created": "язык {locale} создан, пакет версии {version} импортирован",
            "updated": "язык {locale} обновлён до пакета версии {version}",
            "no_op": "{locale}: пакет версии {version} уже импортирован — без изменений",
        }
        message = messages[result.status].format(
            locale=result.locale_code, version=result.pack_version
        )
        self.stdout.write(self.style.SUCCESS(message))

    def _resolve_ru_conflicts(self, data: dict[str, Any], *, auto_yes: bool) -> dict[str, Any]:
        existing = LocalePack.objects.filter(locale_id="ru").first()
        if existing is None:
            return data

        diff = services.diff_pack_texts(existing.content, data)
        if not diff:
            return data

        self.stdout.write(self.style.WARNING(f"ru: {len(diff)} отличий от текущего пакета"))
        overrides: dict[str, str] = {}
        for text_path, (old_text, new_text) in sorted(diff.items()):
            self.stdout.write(f"  {text_path}:")
            self.stdout.write(f"    - {old_text!r}")
            self.stdout.write(f"    + {new_text!r}")

            # Реальный конфликт — только когда текст был по обе стороны
            # (и отличается). Добавленный (old_text is None) или снятый
            # (new_text is None) ключ оставить «старым» нечем — просто
            # информация в diff, без вопроса.
            if old_text is None or new_text is None:
                continue
            if auto_yes:
                continue
            answer = self._ask("    оставить [o]старое / [n]новое? [n] ").strip().lower()
            if answer in ("o", "old", "старое"):
                overrides[text_path] = old_text

        if not overrides:
            return data
        return services.apply_text_overrides(data, overrides)

    def _ask(self, prompt: str) -> str:
        return input(prompt)
