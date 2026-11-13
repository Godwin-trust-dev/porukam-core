"""ADR-151: `Contract.payment_order` — порядок оплаты этапа (срок оплаты
относительно исполнения: `before_start` / `after_acceptance`). Отдельная ось
от `payment_method` (рельсы расчёта). Nullable без бэкфилла: существующие
договоры условия не имеют, обязательность — только на `send` новых
черновиков (`services.send_for_review`)."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("contracts", "0009_contract_last_activity_at"),
    ]

    operations = [
        migrations.AddField(
            model_name="contract",
            name="payment_order",
            field=models.CharField(
                blank=True,
                choices=[
                    ("before_start", "Предоплата — до начала этапа"),
                    ("after_acceptance", "Постоплата — после приёмки этапа"),
                ],
                max_length=16,
                null=True,
            ),
        ),
    ]
