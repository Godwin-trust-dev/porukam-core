"""Дополнение 26.08 к ADR-075: отзыв инициатором (`POST /amendments/{id}/
withdraw`, топик `amendment.withdrawn`) и отклонение второй стороной
(`POST /amendments/{id}/reject`, топик `amendment.rejected`) допсоглашения —
свои строки `NotificationTemplate`.

Тот же приём, что 0017/0018: `body_i18n` ПУСТОЙ, текст — из языкового
пакета (`notifications.amendment.rejected` / `.withdrawn`, долито во все 29
пакетов патчем `l10n/patches/adr-075-amendment-closed.json`). Тексты
нейтральны к точке зрения («Допсоглашение … отклонено/отозвано»), суффикса
`.counterparty` нет. `legal_significance=True`: прекращение согласования
допника — тот же класс факта, что `negotiation.rejected`/`withdrawn` (0014)."""

from __future__ import annotations

from django.db import migrations

TEMPLATES: dict[str, bool] = {
    "amendment.rejected": True,
    "amendment.withdrawn": True,
}


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    for code, legal_significance in TEMPLATES.items():
        NotificationTemplate.objects.update_or_create(
            code=code, defaults={"legal_significance": legal_significance, "body_i18n": {}}
        )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code__in=list(TEMPLATES)).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0018_seed_warranty_declined_template")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
