"""П-03 (ADR-081): `export_checklists_i18n [--output PATH]` — выгружает все
актуальные пункты чек-листов в набор ключей `catalog.checklists.<slug>` для
переводческого конвейера (тонкая обёртка над apps.catalog.services.
export_checklists_i18n — вся логика там же, где import_checklists)."""

from __future__ import annotations

import json
from typing import Any

from django.core.management.base import BaseCommand

from apps.catalog import services


class Command(BaseCommand):
    help = (
        "Экспортирует актуальные пункты чек-листов в JSON-набор ключей "
        "catalog.checklists.<slug> → текст (RU) для переводческого конвейера."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--output",
            type=str,
            default=None,
            help="Путь к выходному JSON-файлу (по умолчанию — печать в stdout)",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        keys = services.export_checklists_i18n()
        payload = json.dumps(keys, ensure_ascii=False, indent=2, sort_keys=True)

        output_path = options["output"]
        if output_path:
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(payload + "\n")
            self.stdout.write(self.style.SUCCESS(f"{len(keys)} ключей записано в {output_path}"))
        else:
            self.stdout.write(payload)
