"""Сид длительностей Э4.6 (docs/tasks/etap-4.md): исполнение договора.

`milestone_material_notice` — окно оспаривания уведомления о проблеме с
материалами (ADR-019, «симметрично приёмке» — та же длительность, что
`milestone_acceptance`, уже зафиксированная миграцией 0002). `contract_
warranty` — гарантийный период (ADR-029: «по согласованию сторон, платформа
подсказывает» — JurisdictionConfig.warranty_recommendation ещё не заведён,
domain-model.md §12); оба значения, как и `signature_request_expiry`
(миграция 0003), — предмет согласования с юристом (tech-spec.md §11 п.4),
не догадки «в вакууме»."""

from datetime import timedelta

from django.db import migrations

DURATIONS = {
    "milestone_material_notice": timedelta(hours=48),
    "contract_warranty": timedelta(days=180),
}


def seed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    for kind, duration in DURATIONS.items():
        DeadlineKindConfig.objects.update_or_create(kind=kind, defaults={"duration": duration})


def unseed_kind_durations(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind__in=DURATIONS).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0003_seed_signature_request_expiry")]

    operations = [
        migrations.RunPython(seed_kind_durations, unseed_kind_durations),
    ]
