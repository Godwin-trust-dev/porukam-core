"""ADR-130 (Э5): длительность категории дедлайна оплаты.

Данные, не константа в коде (CLAUDE.md; tech-spec.md §11 п.4 — «таблица
категорий с юристом»). 14 суток от выставления счёта: срок не юридический
(закон его не задаёт — это срок ПЛАТФОРМЫ, после которого она фиксирует
факт просрочки и уведомляет обе стороны), а операционный, поэтому выбран
заведомо мягким. Просрочка НЕ отменяет обязательство и не меняет статус
платежа — только помечает `Payment.overdue_at` и рождает `payment.overdue`.
"""

from __future__ import annotations

from datetime import timedelta

from django.db import migrations

DURATIONS = {"payment_settlement": timedelta(days=14)}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0004_seed_execution_kinds")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
