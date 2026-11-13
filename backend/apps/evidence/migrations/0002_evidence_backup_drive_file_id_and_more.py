# ADR-084 (docs/tasks/Задача_feat_evidence-drive.md §2.3): file id/ссылка
# реального Drive-бэкапа — нужны для идемпотентности POST /evidence/{id}/backup.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('evidence', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='evidence',
            name='backup_drive_file_id',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='evidence',
            name='backup_drive_web_view_link',
            field=models.URLField(blank=True, default=''),
        ),
    ]
