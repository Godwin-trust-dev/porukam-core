"""ADR-133: окно подтверждения устранения по гарантийной претензии
(`warranty_claim_acceptance`) — решение владельца 26.08 дословно: «Если
клиент не прислал замечание в течение времени окна приёмки, то будет
автоприёмка». Длительность берётся из УЖЕ ЗАСЕЯННОЙ строки
`milestone_acceptance` (окно приёмки этапа, tech-spec.md §7/§6.3; 0002 —
48 ч) в момент миграции, а не литералом: источник длины окна — один.
Своя строка, а не общая с этапом, потому что `DomainDeadline.kind` —
одновременно и категория длительности, и дискриминатор обработчиков
срабатывания (`payload["kind"]` в `OUTBOX_SUBSCRIBERS["domain_deadline.fired"]`);
если юрист позже разведёт окна, это правка данных без релиза."""

from datetime import timedelta

from django.db import migrations

KIND = "warranty_claim_acceptance"
SOURCE_KIND = "milestone_acceptance"
FALLBACK = timedelta(hours=48)


def seed(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    source = DeadlineKindConfig.objects.filter(kind=SOURCE_KIND).first()
    duration = source.duration if source is not None else FALLBACK
    DeadlineKindConfig.objects.update_or_create(kind=KIND, defaults={"duration": duration})


def unseed(apps, schema_editor):
    DeadlineKindConfig = apps.get_model("deadlines", "DeadlineKindConfig")
    DeadlineKindConfig.objects.filter(kind=KIND).delete()


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0006_seed_dispute_window_kinds")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
