# ADR-122: заявленные сферы деятельности профиля (коды каталога, до 10).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("profiles", "0007_portfolio_photos_v2"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="sphere_codes",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
