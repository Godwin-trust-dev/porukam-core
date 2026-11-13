"""ADR-155: из `Payment` уходят вид `advance` и способ `prepayment`.

Только `choices` — это метаданные Django, DDL не выполняется. CHECK-констрейнты
`payment_kind_valid`/`payment_method_valid` СОЗНАТЕЛЬНО не сужаются: они
разрешают надмножество, и ALTER на живой таблице платежей ради значений,
которые код больше не создаёт, только рисковал бы отвергнуть исторические
строки (см. комментарий в `apps.payments.models.Payment.Meta`).
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0002_backfill_from_milestone_confirmations"),
    ]

    operations = [
        migrations.AlterField(
            model_name="payment",
            name="kind",
            field=models.CharField(
                choices=[
                    ("postpayment", "Оплата этапа"),
                    ("prepayment", "Частичная предоплата (Р2)"),
                    ("refund", "Возврат (Р2)"),
                ],
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="payment",
            name="method",
            field=models.CharField(
                choices=[
                    ("cash", "Наличные"),
                    ("external", "Внешний перевод"),
                    ("direct_platform", "Прямой платёж (наблюдение платформой)"),
                    ("hold", "Холд (Р2)"),
                ],
                max_length=16,
            ),
        ),
    ]
