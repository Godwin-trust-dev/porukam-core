"""ADR-155: строка NotificationTemplate для нового топика
`milestone.material_handed_over` — первый шаг двустороннего подтверждения
материала («передал» отмечает сторона-источник).

Без строки таблицы `apps.notifications.subscriber._place` молча отбрасывает
событие с warning-логом, даже если топик уже в реестре
`settings.NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES` — та же механика, что
у 0014_seed_contract_action_templates, и `body_i18n` здесь так же ПУСТОЙ:
источник текста для кодов-топиков — языковой пакет (`apps.l10n`, namespace
`notifications.<code>`).

`legal_significance=False` — как у симметричного `milestone.material_received`
(0014): передача материалов — информационный шаг исполнения, юрзначимого
срока от него не считается (в отличие от `milestone_material_notice`, где
размещение в ЛК якорит окно оспаривания ADR-019).
"""

from __future__ import annotations

from django.db import migrations

CODE = "milestone.material_handed_over"


def seed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.update_or_create(
        code=CODE, defaults={"legal_significance": False, "body_i18n": {}}
    )


def unseed(apps, schema_editor):
    NotificationTemplate = apps.get_model("notifications", "NotificationTemplate")
    NotificationTemplate.objects.filter(code=CODE).delete()


class Migration(migrations.Migration):
    dependencies = [("notifications", "0025_seed_archive_templates")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
