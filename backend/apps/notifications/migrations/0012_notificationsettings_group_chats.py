# Складка «Чаты» в уведомлениях (отсмотр 2026-08-24): своя группа-канал для
# сообщений переписки — тумблер push/email, как у остальных групп.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("notifications", "0011_seed_group_templates"),
    ]

    operations = [
        migrations.AddField(
            model_name="notificationsettings",
            name="group_chats",
            field=models.BooleanField(default=True),
        ),
    ]
