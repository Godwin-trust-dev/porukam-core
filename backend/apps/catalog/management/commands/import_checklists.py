"""П-03 (ADR-081): `import_checklists [--dir PATH]` — идемпотентная,
версионированная, тонкая обёртка над apps.catalog.services.import_checklists
(вся логика — там, не здесь, по образцу apps.l10n.management.commands.
import_l10n_pack). Вызывается в деплой-пайплайне ПОСЛЕ `manage.py migrate`
(.github/workflows/deploy-staging.yml) — новые/изменённые CL-файлы
подхватываются на каждом релизе без ручного шага."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.catalog import services
from apps.catalog.checklist_markdown import ChecklistMarkdownError


def _default_checklists_dir() -> Path:
    # BASE_DIR = backend/ (config/settings/base.py) — контент лежит на
    # уровень выше, docs/content/checklists (репозиторий, не пакет бэкенда).
    return Path(settings.BASE_DIR).parent / "docs" / "content" / "checklists"


class Command(BaseCommand):
    help = (
        "Импортирует docs/content/checklists/CL-*_GLOBAL.md в "
        "ChecklistTemplateItem/MaterialCatalogItem (apps.catalog.services.import_checklists)."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--dir",
            type=str,
            default=None,
            help="Путь к docs/content/checklists (по умолчанию — вычисляется от BASE_DIR)",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        checklists_dir = Path(options["dir"]) if options["dir"] else _default_checklists_dir()
        if not checklists_dir.is_dir():
            raise CommandError(f"{checklists_dir}: каталог не найден")

        try:
            report = services.import_checklists(checklists_dir)
        except ChecklistMarkdownError as exc:
            raise CommandError(f"разметка не соответствует формату: {exc}") from exc

        if not report.spheres:
            raise CommandError(f"{checklists_dir}: не найдено ни одного CL-*_GLOBAL.md")

        for sphere in report.spheres:
            self.stdout.write(
                f"{sphere.sphere_code:14s} "
                f"пунктов: создано={sphere.items_created} новых_версий={sphere.items_new_version} "
                f"без_изменений={sphere.items_unchanged} | "
                f"материалов: создано={sphere.materials_created} "
                f"обновлено={sphere.materials_updated} без_изменений={sphere.materials_unchanged}"
            )
            for ref in sphere.unresolved_material_refs:
                self.stdout.write(
                    self.style.WARNING(
                        f"  {sphere.sphere_code}: неразрешённая ссылка материала — {ref}"
                    )
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"Готово: {len(report.spheres)} сфер · "
                f"пунктов создано {report.total_items_created}, "
                f"новых версий {report.total_items_new_version}, "
                f"без изменений {report.total_items_unchanged} · "
                f"материалов создано {report.total_materials_created}"
            )
        )
