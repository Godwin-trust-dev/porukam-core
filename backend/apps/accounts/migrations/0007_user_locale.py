"""Язык интерфейса как явный выбор пользователя (ADR-095).

Отдельное поле, а не переиспользование country_code: контур знает только
ru/en (JurisdictionConfig.primary_locale, засеяны RU и GLOBAL), а языков в
переключателе 29. Бэкфила нет — NULL означает «выбора не было», и резолвер
языка запроса падает на прежнюю цепочку (контур -> Accept-Language), то
есть поведение уже существующих пользователей не меняется.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0006_googledrivegrant")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="locale",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
    ]
