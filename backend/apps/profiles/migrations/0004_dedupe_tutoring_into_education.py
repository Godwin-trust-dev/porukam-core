# Дедупликация сфер (chore/sphere-dedup): PortfolioProject.sphere — плоский
# код без FK (docstring PortfolioProject) — синхронизируем с
# apps.catalog.models.Sphere (apps.catalog.migrations.
# 0014_dedupe_tutoring_into_education): AlterField отражает новый choices
# (`education` вместо `tutoring`), RunPython переносит уже сохранённые
# строки.
from django.db import migrations, models


def repoint_forward(apps, schema_editor):
    PortfolioProject = apps.get_model("profiles", "PortfolioProject")
    PortfolioProject.objects.filter(sphere="tutoring").update(sphere="education")


def repoint_backward(apps, schema_editor):
    # Необратимо осознанно (см. apps.catalog.migrations.0014
    # dedupe_backward): после forward неотличимо, какие строки "education"
    # были изначально "tutoring", а какие — уже "education" (собраны из
    # CL-education контента) — наивный реверс исказил бы вторые.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("profiles", "0003_backfill_person_profiles"),
    ]

    operations = [
        migrations.AlterField(
            model_name="portfolioproject",
            name="sphere",
            field=models.CharField(
                choices=[
                    ("renovation", "Ремонт"),
                    ("delivery", "Доставка"),
                    ("education", "Обучение и репетиторство"),
                    ("it", "IT"),
                    ("household", "Бытовые услуги"),
                    ("design", "Дизайн"),
                    ("other", "Другое"),
                ],
                max_length=16,
            ),
        ),
        migrations.RunPython(repoint_forward, repoint_backward),
    ]
