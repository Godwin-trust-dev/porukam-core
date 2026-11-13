"""manage.py geo_name_audit — аудит покрытия отображаемых имён геосправочника
на заданной локали (ADR-183).

Владелец прогоняет её на проде после каждого прогона `import_geo`, чтобы
увидеть ФАКТАМИ (не гадая по коду): сколько городов/регионов остаются без
имени нужной локали (показываются латиницей — фолбэк `name_i18n[locale]` →
`name` → `name_latin`, `api/serializers.py`) и сколько показываются
разговорным/коротким именем (services._names_by_locale_with_fallback —
фолбэк, когда полной формы для локали нет вовсе).

ТОЛЬКО ЧТЕНИЕ (CLAUDE.md: бизнес-логика не в командах) — вся логика в
`apps.geo.selectors.audit_region_name_coverage`/`audit_city_name_coverage`,
здесь — разбор аргументов и печать отчёта человеку. Регионы печатаются
ПЕРВЫМИ (владелец 12.09: главный дефект был именно в регионах — «Пятигорск
как город есть, проблема была со Ставропольский край»)."""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from apps.geo import selectors
from apps.geo.selectors import LocaleCoverageReport


class Command(BaseCommand):
    help = (
        "Аудит покрытия отображаемых имён геосправочника (ADR-183): по каждой "
        "стране — сколько регионов/городов остаются латиницей (нет имени "
        "локали) и сколько показываются разговорным/коротким именем "
        "(фолбэк), плюс примеры. Регионы — первыми."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--locale",
            default="ru",
            help="Код локали (BCP-47, как в apps.geo.constants.LOCALE_TO_GEONAMES_LANGS). "
            "По умолчанию 'ru'.",
        )
        parser.add_argument(
            "--countries",
            default=None,
            help="Коды ISO 3166-1 alpha-2 через запятую (например RU,KZ,BY). "
            "По умолчанию — весь справочник (все страны, что реально загружены).",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=20,
            help="Сколько примеров каждой категории печатать (по умолчанию 20).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        locale = str(options["locale"]).strip()
        if not locale:
            raise CommandError("--locale: пустое значение")
        limit = int(options["limit"])
        if limit < 0:
            raise CommandError("--limit: должно быть ≥ 0")
        countries = self._parse_countries(options["countries"])

        self.stdout.write(
            self.style.MIGRATE_HEADING(f"Аудит имён геосправочника — локаль {locale!r}")
        )

        region_report = selectors.audit_region_name_coverage(
            locale=locale, countries=countries, limit=limit
        )
        self._print_report(region_report)

        city_report = selectors.audit_city_name_coverage(
            locale=locale, countries=countries, limit=limit
        )
        self._print_report(city_report)

    @staticmethod
    def _parse_countries(raw: object) -> frozenset[str] | None:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None
        codes = {chunk.strip().upper() for chunk in text.split(",") if chunk.strip()}
        return frozenset(codes) if codes else None

    def _print_report(self, report: LocaleCoverageReport) -> None:
        kind_plural = "регионы" if report.kind == "регион" else "города"
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(f"--- {kind_plural.upper()} ---"))

        if report.total == 0:
            self.stdout.write(
                self.style.WARNING("Нет данных (справочник пуст или страны не найдены).")
            )
            return

        self.stdout.write(
            f"Всего: {report.total}; "
            f"латиницей: {report.latin_fallback_total} "
            f"({self._pct(report.latin_fallback_total, report.total)}); "
            f"разговорным/коротким: {report.colloquial_or_short_total} "
            f"({self._pct(report.colloquial_or_short_total, report.total)})"
        )

        problem_rows = [
            row for row in report.by_country if row.latin_fallback or row.colloquial_or_short
        ]
        if problem_rows:
            self.stdout.write("По странам (только с проблемами):")
            for row in problem_rows:
                self.stdout.write(
                    f"  {row.country}: всего={row.total} "
                    f"латиница={row.latin_fallback} ({self._pct(row.latin_fallback, row.total)}) "
                    f"разг/кор={row.colloquial_or_short} "
                    f"({self._pct(row.colloquial_or_short, row.total)})"
                )
        else:
            self.stdout.write(
                self.style.SUCCESS("Проблем по странам нет — все показываются полной формой.")
            )

        if report.latin_examples:
            self.stdout.write(f"Примеры «латиница, имени {report.locale!r} нет»:")
            for ex in report.latin_examples:
                self.stdout.write(f"  {ex.country}: {ex.name_latin}")

        if report.colloquial_examples:
            self.stdout.write("Примеры «разговорное/короткое имя (полной формы нет)»:")
            for ex in report.colloquial_examples:
                self.stdout.write(f"  {ex.country}: {ex.name_latin} → {ex.shown_name!r}")

    @staticmethod
    def _pct(part: int, total: int) -> str:
        if total == 0:
            return "0.0%"
        return f"{100 * part / total:.1f}%"
