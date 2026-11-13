"""ADR-138: серия напоминаний «договор без движения» адресуется ОБЕИМ
сторонам договора — прежняя уникальность (deadline, point) допускала одного
получателя на точку (серия `milestone_acceptance` — только заказчику).
Уникальность становится (deadline, recipient, point); прежние строки
условию удовлетворяют (у них один получатель на дедлайн)."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("notifications", "0021_seed_warranty_acceptance_reminders")]

    operations = [
        migrations.RemoveConstraint(model_name="reminderschedule", name="unique_reminder_point"),
        migrations.AddConstraint(
            model_name="reminderschedule",
            constraint=models.UniqueConstraint(
                fields=["deadline", "recipient", "point"], name="unique_reminder_point"
            ),
        ),
    ]
