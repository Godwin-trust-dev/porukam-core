"""feat/notifications-wiring: приводим ключи `content["notifications"]` уже
импортированных `LocalePack` к реальным outbox-топикам/новой схеме
доставки — тот же трансформ, что скрипт, который переписал 26 файлов
`l10n/packs/*.json` (см. PR feat/notifications-wiring за обоснованием
каждого решения). Транформ инлайнится здесь целиком (не читает файлы с
диска) — миграция должна оставаться воспроизводимой сама по себе сколь
угодно далеко в истории git, независимо от текущего состояния
`l10n/packs/`.

`apps.notifications.subscriber.handle_event` уведомляет ТОЛЬКО actor
события (кто выполнил действие), не контрагента — старый текст пакета был
написан в расчёте на контрагента ("вас пригласили", "приняли вашу правку").
Для en/ru — новый текст (REWRITE). Для остальных locale — ключ с неверной
адресацией просто убирается (фолбэк locale->en, частичный пакет валиден по
дизайну apps.l10n).

pack_version у изменённых строк — +1 к текущему (не хардкод) и checksum
пересчитан тем же алгоритмом, что apps.l10n.services._checksum (sha256
канонического JSON без pack_version) — если позже `import_l10n_pack`
прогонит обновлённые файлы `l10n/packs/*.json` (pack_version тоже +1 там),
содержимое совпадёт бит-в-бит и импорт будет честным no-op, не конфликтом
версии."""

from __future__ import annotations

import hashlib
import json

from django.db import migrations

RENAME = {
    "contract.invited": "negotiation.sent",
    "contract.ready_to_sign": "negotiation.frozen",
    "negotiation.revision_proposed": "negotiation.revised",
}
ACTOR_MISMATCH_DROP_FOR_OTHER_LOCALES = [
    "negotiation.sent",
    "negotiation.frozen",
    "negotiation.revised",
    "milestone.accepted",
    "milestone.rejected",
]
COLLAPSE_DROP = ["negotiation.revision_accepted", "negotiation.revision_rejected"]
DROP = [
    "evidence.backup_completed",
    "milestone.acceptance_reminder",
    "evidence.received",
    "milestone.submitted",
]

REWRITE = {
    "en": {
        "negotiation.sent": {
            "subject": "Contract sent for review",
            "body": "'{contract_title}' has been sent for review.",
        },
        "negotiation.revised": {
            "subject": "Changes recorded",
            "body": "Changes to '{contract_title}' have been recorded.",
        },
        "negotiation.frozen": {
            "subject": "Contract ready to sign",
            "body": "'{contract_title}' is frozen and ready to sign.",
        },
        "negotiation.signed": {
            "subject": "Signature recorded",
            "body": (
                "Your signature on '{contract_title}' is recorded. "
                "Waiting for the other party to sign."
            ),
        },
        "milestone.started": {
            "subject": "Work started",
            "body": "Work on '{milestone_title}' has started.",
        },
        "milestone.accepted": {
            "subject": "Work accepted",
            "body": "'{milestone_title}' has been accepted.",
        },
        "milestone.rejected": {
            "subject": "Work declined",
            "body": "'{milestone_title}' was declined, citing a checklist item.",
        },
        "dispute.resolved": {
            "subject": "Disagreement resolved",
            "body": "The disagreement on '{milestone_title}' has been resolved.",
        },
    },
    "ru": {
        "negotiation.sent": {
            "subject": "Договор отправлен на согласование",
            "body": "Договор «{contract_title}» отправлен на согласование.",
        },
        "negotiation.revised": {
            "subject": "Зафиксированы изменения",
            "body": "По договору «{contract_title}» зафиксированы изменения.",
        },
        "negotiation.frozen": {
            "subject": "Договор готов к подписанию",
            "body": "Договор «{contract_title}» зафиксирован и готов к подписанию.",
        },
        "negotiation.signed": {
            "subject": "Подпись принята",
            "body": "Ваша подпись под «{contract_title}» принята. Ждём подпись второй стороны.",
        },
        "milestone.started": {
            "subject": "Работа началась",
            "body": "Работа над этапом «{milestone_title}» началась.",
        },
        "milestone.accepted": {
            "subject": "Работа принята",
            "body": "Работа «{milestone_title}» принята.",
        },
        "milestone.rejected": {
            "subject": "Работа отклонена",
            "body": "Работа «{milestone_title}» отклонена со ссылкой на пункт чек-листа.",
        },
        "dispute.resolved": {
            "subject": "Разногласие урегулировано",
            "body": "Разногласие по этапу «{milestone_title}» урегулировано.",
        },
    },
}


def _checksum(content: dict) -> str:
    payload = {key: value for key, value in content.items() if key != "pack_version"}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _transform(content: dict) -> dict:
    notifications = dict(content.get("notifications", {}))

    for old, new in RENAME.items():
        if old in notifications:
            notifications[new] = notifications.pop(old)
    for key in COLLAPSE_DROP + DROP:
        notifications.pop(key, None)
    if content.get("locale") not in ("en", "ru"):
        for key in ACTOR_MISMATCH_DROP_FOR_OTHER_LOCALES:
            notifications.pop(key, None)

    rewrite = REWRITE.get(content.get("locale"))
    if rewrite:
        for key, entry in rewrite.items():
            notifications[key] = dict(entry)

    content["notifications"] = notifications
    return content


def rename_forward(apps, schema_editor):
    LocalePack = apps.get_model("l10n", "LocalePack")
    for pack in LocalePack.objects.all():
        content = _transform(dict(pack.content))
        content["pack_version"] = pack.pack_version + 1
        pack.content = content
        pack.pack_version = content["pack_version"]
        pack.checksum = _checksum(content)
        pack.save(update_fields=["content", "pack_version", "checksum", "imported_at"])


def rename_backward(apps, schema_editor):
    # Осознанно необратимо: старый текст (написанный в расчёте на
    # контрагента) выброшен, а не сохранён где-то для отката — тот же
    # приём, что apps/catalog/migrations/0014_dedupe_tutoring_into_education.
    pass


class Migration(migrations.Migration):

    dependencies = [("l10n", "0002_seed_locales")]

    operations = [
        migrations.RunPython(rename_forward, rename_backward),
    ]
