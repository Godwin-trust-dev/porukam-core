"""Бэкфилл счётчиков репутации волны 2 (ADR-163 §7).

Почему команда, а не миграция данных: пересчёт ходит в СОСЕДНИЕ приложения
(apps.contracts / apps.milestones / apps.payments) через их публичные
selectors-фасады, а миграции обязаны работать на исторических состояниях
моделей (`apps.get_model`) и чужих фасадов не видят. К тому же прогон
тяжёлый и его нужно уметь сперва прокрутить вхолостую.

Почему команда, а не расширение подписчика: старые события новых полей не
несут (`due_at`, `payment_due_at`, `auto_accepted`, `total`), пересобрать
их из outbox нельзя — «не записанное тогда не восстановится» (ADR-076).
Это разовая миграция ДАННЫХ, а не рабочий путь чтения, и потому
единственное место в apps.reputation, где чтение чужих моделей через фасады
допускается вовсе.

Идемпотентность: все счётчики ПРИСВАИВАЮТСЯ (не инкрементируются), строки
`MilestoneFact` — `update_or_create` по `milestone_id`. Повторный прогон не
меняет результата, прерванный можно просто запустить заново.

    python manage.py reputation_backfill --dry-run
    python manage.py reputation_backfill
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandParser
from django.db import transaction

from apps.contracts import selectors as contracts_selectors
from apps.contracts.models import Contract
from apps.milestones import selectors as milestones_selectors
from apps.payments import selectors as payments_selectors

from ...models import DealFact, MilestoneFact
from ...subscriber import recompute_deal_counters


def _delivered_on_time(due_at: Any, submitted_at: Any) -> bool | None:
    """Та же семантика, что у подписчика: `None` — мерить нечего (нет
    дедлайна или сдачи), а не «просрочено»."""
    if due_at is None or submitted_at is None:
        return None
    return bool(submitted_at <= due_at)


def _payment_on_time(due_at: Any, confirmed_at: Any) -> bool | None:
    if due_at is None or confirmed_at is None:
        return None
    return bool(confirmed_at <= due_at)


class Command(BaseCommand):
    help = "Пересчитать счётчики репутации волны 2 по существующим договорам (идемпотентно)"

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="ничего не писать, только показать, что изменилось бы",
        )
        parser.add_argument(
            "--contract-id",
            default=None,
            help="пересчитать один договор (диагностика расхождения)",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        dry_run: bool = options["dry_run"]
        deals = DealFact.objects.all().order_by("created_at")
        if options["contract_id"]:
            deals = deals.filter(contract_id=options["contract_id"])

        total = deals.count()
        self.stdout.write(f"строк DealFact к пересчёту: {total}")
        done = 0
        skipped = 0
        for deal in deals.iterator():
            contract = Contract.objects.filter(pk=deal.contract_id).first()
            if contract is None:
                # Договор удалён/не существует — строка read-модели пережила
                # источник. Молча пропускаем: чинить это бэкфиллом нечем.
                skipped += 1
                continue
            if dry_run:
                self.stdout.write(f"[dry-run] {deal.contract_id}: {self._preview(contract)}")
                done += 1
                continue
            with transaction.atomic():
                self._backfill(deal, contract)
            done += 1
        self.stdout.write(
            self.style.SUCCESS(f"пересчитано: {done}, пропущено (нет договора): {skipped}")
        )

    def _preview(self, contract: Contract) -> str:
        rows = milestones_selectors.reputation_facts(contract)
        payments = payments_selectors.reputation_payment_facts(contract)
        with_due = sum(1 for r in rows if _delivered_on_time(r["due_at"], r["submitted_at"]))
        return f"листьев {len(rows)}, сдано в срок {with_due}, платежей {len(payments)}"

    def _backfill(self, deal: DealFact, contract: Contract) -> None:
        rows = milestones_selectors.reputation_facts(contract)
        payments = payments_selectors.reputation_payment_facts(contract)
        for row in rows:
            payment = payments.get(row["milestone_id"], {})
            MilestoneFact.objects.update_or_create(
                milestone_id=row["milestone_id"],
                defaults={
                    "contract_id": deal.contract_id,
                    "title": row["title"],
                    "sphere_code": row["sphere_code"],
                    "customer_profile_id": deal.customer_profile_id,
                    "contractor_profile_id": deal.contractor_profile_id,
                    "due_at": row["due_at"],
                    "submitted_at": row["submitted_at"],
                    "delivered_on_time": _delivered_on_time(row["due_at"], row["submitted_at"]),
                    "accepted_at": row["accepted_at"],
                    "auto_accepted": row["auto_accepted"],
                    "acceptance_prompt": row["acceptance_prompt"],
                    "payment_due_at": payment.get("due_at"),
                    "payment_confirmed_at": payment.get("confirmed_at"),
                    "payment_on_time": _payment_on_time(
                        payment.get("due_at"), payment.get("confirmed_at")
                    ),
                },
            )
        # `rejections`/`last_rejection_reason`/`disputes_opened` НЕ трогаем:
        # они накоплены событиями и восстановлению из состояния не подлежат
        # (отклонение — факт истории, а не поле этапа). Поэтому здесь
        # `update_or_create(defaults=...)` перечисляет поля поимённо, а не
        # пересоздаёт строку целиком.
        total = contracts_selectors.contract_total_money(contract)
        if total is not None:
            deal.total_amount = total.amount
            deal.total_currency = total.currency
        deal.payment_method = contract.payment_method or ""
        deal.payment_protected = contract.protected
        recompute_deal_counters(deal)
        deal.save()
