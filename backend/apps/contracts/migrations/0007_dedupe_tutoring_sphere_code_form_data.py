# Дедупликация сфер (chore/sphere-dedup): apps.contracts.forms.SPHERE_CODES
# заменил "tutoring" на "education" (см. apps.catalog.migrations.
# 0014_dedupe_tutoring_into_education) — уже сохранённые ЧЕРНОВИКИ
# (Contract.form_data["sphere_code"] == "tutoring") переносим здесь.
#
# ContractVersion.snapshot НЕ трогаем: подписанный договор неизменяем
# (CLAUDE.md — "Подписанный договор неизменяем; изменения — только через
# Amendment"), snapshot — замороженная копия под integrity_hash, факт того,
# что стороны реально подписали; переписывать его задним числом означало
# бы менять подписанный документ. Только Contract.form_data — живой,
# редактируемый черновик (frozen_version отдельно, докстринг Contract).
from django.db import migrations


def repoint_forward(apps, schema_editor):
    Contract = apps.get_model("contracts", "Contract")
    for contract in Contract.objects.filter(form_data__sphere_code="tutoring"):
        contract.form_data = {**contract.form_data, "sphere_code": "education"}
        contract.save(update_fields=["form_data"])


def repoint_backward(apps, schema_editor):
    # См. apps.catalog.migrations.0014 dedupe_backward — необратимо.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("contracts", "0006_l10n_canonical_language"),
    ]

    operations = [
        migrations.RunPython(repoint_forward, repoint_backward),
    ]
