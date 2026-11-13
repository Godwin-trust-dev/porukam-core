"""Приёмка ЭФ.3 (docs/tasks/fundament.md): «сделать несколько действий в dev
→ verify_chain через management-команду отвечает "цепочка целостна, N
записей"; испортить строку прямо в БД → команда показывает разрыв»."""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand

from services.audit_vault import api


class Command(BaseCommand):
    help = "Проверяет цепочку хешей Audit Vault (services.audit_vault.api.verify_chain)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--from", dest="seq_from", type=int, default=None)
        parser.add_argument("--to", dest="seq_to", type=int, default=None)

    def handle(self, *args: Any, **options: Any) -> None:
        result = api.verify_chain(seq_from=options["seq_from"], seq_to=options["seq_to"])
        if result.ok:
            self.stdout.write(
                self.style.SUCCESS(f"цепочка целостна, {result.entries_checked} записей")
            )
            return
        self.stdout.write(
            self.style.ERROR(
                f"разрыв цепочки на seq={result.first_broken_seq} "
                f"(проверено {result.entries_checked} записей)"
            )
        )
