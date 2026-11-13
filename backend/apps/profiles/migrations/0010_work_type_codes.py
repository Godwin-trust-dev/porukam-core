# ADR-190 (12.09, «подсферы» в профиле и поиске): выбранные виды работ —
# составные коды каталога `<сфера>.<категория>`, до PROFILE_MAX_WORK_TYPES.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("profiles", "0009_work_areas"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="work_type_codes",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
