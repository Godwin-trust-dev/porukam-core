"""Сид длительностей Э6 (ADR-136 + ADR-137 «Сроки хранения документов
сделки», решение владельца 26.08):

- `evidence_upload_window` — окно выгрузки ADR-053 (72 ч, «параметр
  категории договора»); дедлайна по нему НЕ заводится — по нему
  `apps.evidence.services.compute_lateness` считает `lateness`;
- `evidence_hot_retention` — горячее хранение оригиналов с даты окончания
  сделки (3 месяца = 90 дней) -> архив;
- `evidence_archive_retention` — архив до уничтожения ключей оригиналов
  (ADR-137: до 1 ГОДА от окончания, не 3 лет ADR-036);
- `evidence_retention_notice` — «скачайте себе» обеим сторонам за 10 дней
  до уничтожения (производный дедлайн: `archive − notice`);
- `evidence_dispute_pause_cap` — жёсткий предел продления при споре
  (ADR-137: не более 6 месяцев после завершения спора).

ДАННЫЕ в DeadlineKindConfig, правка без релиза кода; те же значения отдаёт
публичный `GET /v1/evidence/retention-policy` (ADR-137 требование 9)."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    "evidence_upload_window": timedelta(hours=72),
    "evidence_hot_retention": timedelta(days=90),
    "evidence_archive_retention": timedelta(days=365),
    "evidence_retention_notice": timedelta(days=10),
    "evidence_dispute_pause_cap": timedelta(days=180),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0008_seed_contract_idle_kinds")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
