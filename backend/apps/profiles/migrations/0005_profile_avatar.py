# ADR-103: фото профиля — ключ объектов в бакете, источник, время обновления.

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("profiles", "0004_dedupe_tutoring_into_education"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="avatar_key",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="profile",
            name="avatar_source",
            field=models.CharField(
                choices=[
                    ("none", "Нет фото"),
                    ("upload", "Загружено пользователем"),
                    ("google", "Импортировано из Google при регистрации"),
                ],
                default="none",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="profile",
            name="avatar_updated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
