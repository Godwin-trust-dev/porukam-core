"""manage.py migrate_profile_geo_to_work_areas — план 11.09 §4 (ADR-182).

Тонкая CLI-обёртка (CLAUDE.md: бизнес-логика не в командах) над
`apps.profiles.services.migrate_profile_geo_to_work_areas` — вся логика
переноса, правила и идемпотентность описаны там.

Почему ОТДЕЛЬНАЯ КОМАНДА, а не Django data-миграция: на проде порядок
выкатки — выкатка кода → миграции схемы (создают пустую таблицу
`profile_work_area`) → `manage.py import_geo` (наполняет справочник)
отдельным шагом ПОСЛЕ миграций. В момент прогона Django-миграций
`apps.geo` пуст — сопоставлять `Profile.city_name` со справочником
буквально не с чем. Эта команда запускается владельцем ВРУЧНУЮ, уже после
`import_geo`, когда сопоставление вообще возможно.

По умолчанию — ВХОЛОСТУЮ: печатает отчёт (сколько перенесётся в `world`,
сколько в конкретный город, что осталось неоднозначным/не найденным),
ничего не пишет. `--apply` — применить перенос по-настоящему. Повторный
запуск (с `--apply` или без) идемпотентен — уже перенесённые профили
(есть хотя бы одна `WorkArea`) пропускаются, вторых записей не плодит.

    python manage.py migrate_profile_geo_to_work_areas
    python manage.py migrate_profile_geo_to_work_areas --apply
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandParser

from apps.profiles import services


class Command(BaseCommand):
    help = (
        "Перенос Profile.city_name/works_remotely в WorkArea (план 11.09 §4, ADR-182). "
        "По умолчанию — вхолостую, ничего не пишет; --apply применяет перенос."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Применить перенос. Без флага — только отчёт, в БД ничего не пишется.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        apply_changes = bool(options["apply"])
        report = services.migrate_profile_geo_to_work_areas(apply=apply_changes)

        mode = "ПРИМЕНЕНО" if apply_changes else "ВХОЛОСТУЮ — БД не изменена (передайте --apply)"
        self.stdout.write(f"Режим: {mode}")
        self.stdout.write(f"  scope=world (works_remotely=True): {report.migrated_world}")
        self.stdout.write(f"  scope=city (город найден однозначно): {report.migrated_city}")
        self.stdout.write(f"  уже перенесены раньше, пропущены: {report.already_migrated}")

        if report.ambiguous:
            self.stdout.write(
                self.style.WARNING(
                    f"Неоднозначные совпадения ({len(report.ambiguous)}) — city_name НЕ тронут:"
                )
            )
            for row in report.ambiguous:
                candidates = ", ".join(row["candidates"])
                self.stdout.write(
                    f"  profile={row['profile_id']} city_name={row['city_name']!r} -> {candidates}"
                )

        if report.not_found:
            self.stdout.write(
                self.style.WARNING(
                    f"Не найдены в справочнике ({len(report.not_found)}) — city_name НЕ тронут:"
                )
            )
            for row in report.not_found:
                self.stdout.write(f"  profile={row['profile_id']} city_name={row['city_name']!r}")

        self.stdout.write(self.style.SUCCESS("Готово." if apply_changes else "Готово (вхолостую)."))
