"""ADR-138: `Contract.last_activity_at` — момент последнего движения по
договору (ADR-137 требование 8: «движение — любая активность, включая
сообщения в чате»). Бэкфилл для существующих строк — дата последнего
outbox-события по договору (`subject.id` при `type=contract`,
`subject.contract_id` — события этапов/споров/доказательств, либо
`payload.contract_id` — допники), иначе `created_at`. Само поле получает
`default=timezone.now`, поэтому новые договоры метку имеют с создания без
отдельного кода.

Считаются ВСЕ события, не только с актором: на момент бэкфилла различить
«последнее действие стороны» и «последнее системное срабатывание» можно, но
это сместило бы отсчёт в прошлое для давно живущих договоров и закрыло бы
их раньше, чем стороны получили бы предупреждение. Консервативный вариант —
отсчитывать от самого позднего события — даёт всем существующим договорам
полные 3 месяца и предупреждение за две недели с момента раскатки."""

from __future__ import annotations

from django.db import migrations, models
from django.db.models import Max, Q
from django.utils import timezone


def backfill_last_activity(apps, schema_editor):
    Contract = apps.get_model("contracts", "Contract")
    OutboxEvent = apps.get_model("common", "OutboxEvent")
    for contract in Contract.objects.only("id", "created_at").iterator():
        cid = str(contract.id)
        latest = OutboxEvent.objects.filter(
            Q(subject__type="contract", subject__id=cid)
            | Q(subject__contract_id=cid)
            | Q(payload__contract_id=cid)
        ).aggregate(latest=Max("occurred_at"))["latest"]
        Contract.objects.filter(pk=contract.pk).update(
            last_activity_at=max(latest, contract.created_at) if latest else contract.created_at
        )


class Migration(migrations.Migration):
    dependencies = [
        ("contracts", "0008_contract_additional_terms"),
        ("common", "0004_idempotency_key"),
    ]

    operations = [
        migrations.AddField(
            model_name="contract",
            name="last_activity_at",
            field=models.DateTimeField(default=timezone.now),
        ),
        migrations.RunPython(backfill_last_activity, migrations.RunPython.noop),
    ]
