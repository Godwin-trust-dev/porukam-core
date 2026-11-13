"""ADR-140: длительность конкретного дедлайна из условий договора (окно
приёмки этапа `acceptance_window_hours`). NULL — длительность категории."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("deadlines", "0009_seed_evidence_retention_kinds")]

    operations = [
        migrations.AddField(
            model_name="domaindeadline",
            name="duration_override",
            field=models.DurationField(blank=True, null=True),
        ),
    ]
