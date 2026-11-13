"""Сид длительностей по категориям, зафиксированных в tech-spec.md §2.5/§11
п.4 (приёмка 48 ч, окно выгрузки доказательств 72 ч, потолок спора 30 дней).
Финальные значения — предмет согласования с юристом; здесь — уже
задокументированные в спеке параметры, не догадки."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    # tech-spec.md §7 (`POST /milestones/{id}/submit`), §6.3: окно приёмки
    # этапа, отсчёт от размещения уведомления в ЛК (ADR-057).
    "milestone_acceptance": timedelta(hours=48),
    # tech-spec.md §5.2.10 (`POST /evidence/batches`), §2.5: окно выгрузки
    # офлайн-доказательств, параметр категории.
    "evidence_upload_window": timedelta(hours=72),
    # tech-spec.md §6.3, §11: потолок спора — принятые листья оплачиваются,
    # спорный закрывается по истечении.
    "dispute_cap": timedelta(days=30),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0001_initial")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
