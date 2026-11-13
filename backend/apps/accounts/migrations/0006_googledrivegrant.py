# ADR-084 (docs/tasks/Задача_feat_evidence-drive.md §2.1): грант Drive BYO-
# бэкапа — refresh-токен envelope-зашифрован (common/crypto.py, ADR-059),
# access-токен не хранится нигде.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0005_user_country_code'),
    ]

    operations = [
        migrations.CreateModel(
            name='GoogleDriveGrant',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('refresh_token_encrypted', models.BinaryField()),
                ('encryption_key_ref', models.CharField(max_length=64)),
                ('granted_scope', models.CharField(max_length=255)),
                ('status', models.CharField(choices=[('active', 'Активен'), ('revoked', 'Отозван')], default='active', max_length=16)),
                ('granted_at', models.DateTimeField(auto_now_add=True)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('social_account', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='drive_grant', to='accounts.socialloginaccount')),
            ],
            options={
                'db_table': 'google_drive_grant',
                'verbose_name': 'грант Google Drive',
                'verbose_name_plural': 'гранты Google Drive',
            },
        ),
    ]
