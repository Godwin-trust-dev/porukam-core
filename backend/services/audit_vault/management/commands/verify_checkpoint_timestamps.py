"""Офлайн-проверка меток RFC 3161 на чекпойнте против архивной цепочки
(ADR-135) и экспорт пакета для внешней проверки `openssl ts -verify`
(README сервиса). Сети не требует. Набор файлов метки — один на команду и
доказательный пакет сделки: `services.audit_vault.export` (ADR-139)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from services.audit_vault import api
from services.audit_vault import checkpoint as checkpoint_module
from services.audit_vault import export as vault_export
from services.audit_vault.models import AuditCheckpoint


class Command(BaseCommand):
    help = (
        "Офлайн-проверка меток TSA чекпойнта (ADR-135); "
        "--export-dir — пакет для openssl ts -verify."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--id", type=int, default=None, help="id чекпойнта (по умолчанию — последний)"
        )
        parser.add_argument("--export-dir", default=None)

    def handle(self, *args: Any, **options: Any) -> None:
        if options["id"] is not None:
            checkpoint = AuditCheckpoint.objects.filter(pk=options["id"]).first()
        else:
            checkpoint = AuditCheckpoint.objects.order_by("-seq_to").first()
        if checkpoint is None:
            raise CommandError("чекпойнт не найден")

        result = checkpoint_module.verify_checkpoint_timestamps(checkpoint)
        self.stdout.write(
            f"checkpoint #{checkpoint.pk} [{checkpoint.seq_from}, {checkpoint.seq_to}] "
            f"root={checkpoint.digest} status={checkpoint.tsa_status}"
        )
        for check in result.checks:
            if check.ok:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"  OK   {check.tsa} genTime={check.gen_time} signer={check.signer}"
                    )
                )
            else:
                self.stdout.write(
                    self.style.ERROR(f"  FAIL {check.tsa}: {'; '.join(check.errors)}")
                )
        verdict = f"валидных меток {result.valid}, кворум {result.quorum}"
        self.stdout.write(self.style.SUCCESS(verdict) if result.ok else self.style.ERROR(verdict))

        if options["export_dir"]:
            written = vault_export.export_checkpoint_to_dir(
                api.checkpoint_info(checkpoint), Path(options["export_dir"])
            )
            self.stdout.write(f"экспортировано {len(written)} файлов в {options['export_dir']}")
        if not result.ok:
            raise CommandError("метки чекпойнта не подтверждены")
