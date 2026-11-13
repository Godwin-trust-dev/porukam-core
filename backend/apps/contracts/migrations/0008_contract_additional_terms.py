# ADR-123: `Contract.additional_terms` — дополнительные условия договора,
# добавленные через протокол разногласий (правка «Другое», item_ref="other").
# Только новая колонка с дефолтом [] — существующие договоры не трогаем.
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("contracts", "0007_dedupe_tutoring_sphere_code_form_data"),
    ]

    operations = [
        migrations.AddField(
            model_name="contract",
            name="additional_terms",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
