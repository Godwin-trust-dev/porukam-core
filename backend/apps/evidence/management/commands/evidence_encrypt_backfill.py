"""`manage.py evidence_encrypt_backfill` (ADR-136 п.2): перешифрование
оригиналов, загруженных ДО ADR-136 открытыми байтами. Сознательно НЕ
data-миграция: терабайты объектов в S3 не место транзакции `migrate`
(долгий деплой, невозможный откат). Идемпотентно (строки с
`encryption_key_ref` пропускаются), по батчам, можно прерывать и
перезапускать.

Под WORM (`WORM_MODE=object_lock|bucket_lock`) старый объект перезаписать
или удалить нельзя — шифротекст пишется под НОВЫМ ключом
(`evidence/<id>/enc/<file>`), открытый остаётся до lifecycle-правила
бакета. `--delete-plaintext` — только в `WORM_MODE=none` (иначе отказ)."""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from apps.evidence import services
from apps.evidence.models import Evidence
from apps.evidence.storage import build_evidence_object_store
from common import worm


class Command(BaseCommand):
    help = "Перешифровать RU-оригиналы доказательств, загруженные до ADR-136 (идемпотентно)"

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--batch-size", type=int, default=100)
        parser.add_argument("--limit", type=int, default=None, help="максимум объектов за запуск")
        parser.add_argument(
            "--delete-plaintext",
            action="store_true",
            help="удалить открытый объект после перешифрования (только WORM_MODE=none)",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args: Any, **options: Any) -> None:
        delete_plaintext: bool = options["delete_plaintext"]
        if delete_plaintext and worm.resolve_worm_mode() is not worm.WormMode.NONE:
            raise CommandError("--delete-plaintext допустим только при WORM_MODE=none")
        store = build_evidence_object_store()
        batch_size: int = options["batch_size"]
        limit: int | None = options["limit"]
        dry_run: bool = options["dry_run"]

        pending = (
            Evidence.objects.filter(
                storage_mode__in=[Evidence.StorageMode.RU, Evidence.StorageMode.SERVER],
                encryption_key_ref="",
            )
            .exclude(s3_object_key="")
            .exclude(retention_state=Evidence.RetentionState.SHREDDED)
            .order_by("created_at")
        )
        total = pending.count()
        self.stdout.write(f"к перешифрованию: {total}")
        done = skipped = 0
        while True:
            # Каждый успешный шаг убирает строку из выборки (encryption_key_ref
            # проставлен) — поэтому всегда берём «первые N», без offset.
            batch = list(pending[:batch_size])
            if not batch:
                break
            progressed = False
            for evidence in batch:
                if limit is not None and done >= limit:
                    self.stdout.write(f"достигнут --limit={limit}")
                    self._report(done, skipped)
                    return
                if dry_run:
                    self.stdout.write(f"[dry-run] {evidence.id} {evidence.s3_object_key}")
                    done += 1
                    continue
                if services.encrypt_legacy_original(
                    evidence, object_store=store, delete_plaintext=delete_plaintext
                ):
                    done += 1
                    progressed = True
                else:
                    skipped += 1
            if dry_run or not progressed:
                # dry-run ничего не меняет — второй круг дал бы тот же батч;
                # без прогресса (все пропущены по хешу) — тоже выходим.
                break
        self._report(done, skipped)

    def _report(self, done: int, skipped: int) -> None:
        self.stdout.write(self.style.SUCCESS(f"перешифровано: {done}, пропущено: {skipped}"))
