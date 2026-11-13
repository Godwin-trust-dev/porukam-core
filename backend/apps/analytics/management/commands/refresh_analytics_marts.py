"""Ручной пересчёт витрин аналитики: `python manage.py refresh_analytics_marts`.

Нужен там, где Celery beat не поднят (локальный стенд, разовый пересчёт
после правки логики витрины) — и как первый прогон после миграции, чтобы
эндпоинты не отдавали пустоту до наступления ближайшего часа.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandParser

from apps.analytics import services


class Command(BaseCommand):
    help = "Пересчитать витрины аналитики (docs/tasks/marketing-metrics.md §8.3)"

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--mart",
            action="append",
            choices=list(services.MART_ORDER),
            help="пересчитать только указанные витрины (по умолчанию — все, по порядку)",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        marts = tuple(options.get("mart") or ()) or None
        failed = False
        for result in services.refresh_marts(marts):
            if result.ok:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"{result.mart}: {result.rows} строк за {result.duration_ms} мс"
                    )
                )
            else:
                failed = True
                self.stderr.write(self.style.ERROR(f"{result.mart}: {result.error}"))
        if failed:
            raise SystemExit(1)
