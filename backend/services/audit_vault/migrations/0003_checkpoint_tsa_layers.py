"""ADR-135: запись чекпойнта — алгоритм хеша полем, идентификатор хоста,
статус кворума TSA, список слоёв меток вместо одного фейкового токена.
Старые строки (`tsa_token` фейка ЭФ.3) переносятся в `timestamps` как один
слой `tsa_fake` со статусом `fake`."""

from django.db import migrations, models


def forwards(apps, schema_editor):
    AuditCheckpoint = apps.get_model("audit_vault", "AuditCheckpoint")
    alias = schema_editor.connection.alias
    for checkpoint in AuditCheckpoint.objects.using(alias).all().iterator():
        token = checkpoint.timestamps
        if isinstance(token, dict):
            checkpoint.timestamps = [
                {
                    "tsa": "tsa_fake",
                    "alg": "sha256",
                    "serial": token.get("serial"),
                    "gen_time": token.get("stamped_at"),
                    "tsq_b64": None,
                    "tsr_b64": None,
                    "chain_pem": [],
                    "chain_complete": False,
                    "revocation": None,
                }
            ]
            checkpoint.tsa_status = "fake"
            checkpoint.save(using=alias, update_fields=["timestamps", "tsa_status"])


def backwards(apps, schema_editor):
    AuditCheckpoint = apps.get_model("audit_vault", "AuditCheckpoint")
    alias = schema_editor.connection.alias
    for checkpoint in AuditCheckpoint.objects.using(alias).all().iterator():
        layers = checkpoint.timestamps
        if isinstance(layers, list):
            first = layers[0] if layers else {}
            checkpoint.timestamps = {
                "digest": checkpoint.digest,
                "stamped_at": first.get("gen_time"),
                "serial": first.get("serial"),
            }
            checkpoint.save(using=alias, update_fields=["timestamps"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit_vault", "0002_chain_verification_run"),
    ]

    operations = [
        migrations.RenameField(
            model_name="auditcheckpoint", old_name="tsa_token", new_name="timestamps"
        ),
        migrations.AlterField(
            model_name="auditcheckpoint",
            name="timestamps",
            field=models.JSONField(default=list),
        ),
        migrations.AddField(
            model_name="auditcheckpoint",
            name="alg",
            field=models.CharField(default="sha256", max_length=16),
        ),
        migrations.AddField(
            model_name="auditcheckpoint",
            name="host_id",
            field=models.CharField(blank=True, default="", max_length=128),
        ),
        migrations.AddField(
            model_name="auditcheckpoint",
            name="tsa_status",
            field=models.CharField(
                choices=[
                    ("attested", "заверен (кворум TSA достигнут)"),
                    ("unattested", "не заверен (недобор кворума TSA)"),
                    ("fake", "фейковая метка (dev/test)"),
                ],
                default="fake",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="auditcheckpoint",
            name="tsa_failures",
            field=models.JSONField(default=list),
        ),
        migrations.RunPython(forwards, backwards),
    ]
