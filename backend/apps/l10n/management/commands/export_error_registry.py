"""feat/notifications-wiring: `export_error_registry [--output PATH]` —
выгружает JSON-реестр всех кодов application/problem+json с текущим RU
title и местом вызова (AST-сканирование, не рукописный список — вся логика
в apps.l10n.services.export_error_registry, тонкая обёртка команды, тот же
приём, что apps.catalog.management.commands.export_checklists_i18n) — для
патч-пакетов переводов namespace `errors` (l10n/README.md)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.l10n import services


class Command(BaseCommand):
    help = (
        "Экспортирует JSON-реестр кодов application/problem+json "
        "(code, текущий RU title(ы), файл:строка вызова) для патч-пакетов переводов."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--output",
            type=str,
            default=None,
            help="Путь к выходному JSON-файлу (по умолчанию — печать в stdout)",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        registry = services.export_error_registry(Path(settings.BASE_DIR))
        payload = json.dumps(registry, ensure_ascii=False, indent=2)

        output_path = options["output"]
        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(payload + "\n")
            self.stdout.write(
                self.style.SUCCESS(f"{len(registry)} кодов ошибок записано в {output_path}")
            )
        else:
            self.stdout.write(payload)
