# ADR-120: галерея фото проекта (до 5, первое — основное) + started_at.
# Данные: существующая обложка photo_key → первая PortfolioPhoto (order=0);
# сам photo_key остаётся зеркалом основного фото (см. models.PortfolioProject).

import django.db.models.deletion
from django.db import migrations, models

import common.uuid7


def cover_to_photos(apps, schema_editor):
    PortfolioProject = apps.get_model("profiles", "PortfolioProject")
    PortfolioPhoto = apps.get_model("profiles", "PortfolioPhoto")
    for project in PortfolioProject.objects.exclude(photo_key="").iterator():
        PortfolioPhoto.objects.get_or_create(
            project=project, photo_key=project.photo_key, defaults={"order": 0}
        )


class Migration(migrations.Migration):

    dependencies = [
        ("profiles", "0006_portfolioproject_photo_key"),
    ]

    operations = [
        migrations.AddField(
            model_name="portfolioproject",
            name="started_at",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name="PortfolioPhoto",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=common.uuid7.uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("photo_key", models.CharField(max_length=255)),
                ("order", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="photos",
                        to="profiles.portfolioproject",
                    ),
                ),
            ],
            options={
                "verbose_name": "фото проекта портфолио",
                "verbose_name_plural": "фото проектов портфолио",
                "db_table": "portfolio_photo",
                "ordering": ["order", "created_at"],
            },
        ),
        migrations.AddConstraint(
            model_name="portfoliophoto",
            constraint=models.UniqueConstraint(
                fields=("project", "photo_key"), name="portfolio_photo_key_unique"
            ),
        ),
        migrations.RunPython(cover_to_photos, migrations.RunPython.noop),
    ]
