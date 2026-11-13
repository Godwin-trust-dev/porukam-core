"""Сид длительностей ADR-138 (автозакрытие сделок без движения, ADR-137
требование 8 и «Ранее открытые вопросы» п.2 — решение владельца 26.08).

`contract_idle` — срок без движения по договору в исполнении, по истечении
которого договор закрывается автоматически: 3 месяца (90 суток). Отсчёт —
от последнего движения (`Contract.last_activity_at`), переносится при
каждом движении (`apps.deadlines.services.reschedule_deadline`).
Предупреждение сторонам за две недели — серия напоминаний
`ReminderPointConfig(kind="contract_idle")` (apps.notifications), точка
которой задана ДОЛЕЙ интервала (76/90): при изменении длительности здесь
точку серии нужно пересчитать, чтобы предупреждение осталось за 14 суток.

`contract_idle_retry` — отсрочка, если в момент срабатывания у договора
есть незавершённые действия сторон (этап на приёмке или принятый, но не
оплаченный): 14 суток, после чего проверка повторяется. Сторонам в момент
отсрочки размещается уведомление `contract.idle_blocked` — оно же служит
предупреждением за две недели для следующей попытки.

Оба значения — данные, не константы кода (CLAUDE.md), как у соседних
сидов: правка срока не требует релиза."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    "contract_idle": timedelta(days=90),
    "contract_idle_retry": timedelta(days=14),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0007_seed_warranty_claim_acceptance")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
