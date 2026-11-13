"""Удаление аккаунта пользователем (ADR-169, требование Google Play).

Аддитивное nullable-поле, бэкфила нет: NULL — «аккаунт не удалялся», и это
правда про все существующие строки (эндпоинта до этой ветки не было вовсе).
Индекса тоже нет: поле читается точечно по уже найденному пользователю
(вход отсекает `is_active`, а не оно), выборок «все удалённые» в продукте
нет — заводить индекс раньше запроса, которому он нужен, преждевременно.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0008_user_email_verified_at")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="deleted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
