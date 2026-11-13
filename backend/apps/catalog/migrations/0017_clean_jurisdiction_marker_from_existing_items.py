"""ADR-081 (доп. 2026-08-12): чистка артефакта разметки «[Л]»/«[L]» из уже
импортированных строк ChecklistTemplateItem.

Это НЕ правка содержания пункта — маркер дублировал информацию, которая
теперь хранится структурно в `is_jurisdiction_sensitive`; сам текст
формулировки не меняется, поэтому `version`/`is_current` НЕ трогаются
(решение и обоснование — ADR-081, раздел «Дополнение»). Правятся строки С
ЛЮБЫМ `is_current` (в т.ч. уже вытесненные версии) — на момент этой правки
ни один из 18 CL-*_GLOBAL.md ещё не прошёл финальное ревью (00_индекс.md
§1: все партии со статусом «⏳ ожидает ревью», кроме партии 1, принятой
05.08 без содержательных правок текста), т.е. ни один `ContractVersion` не
мог зафиксировать текст с маркером в подписанном снепшоте."""

from __future__ import annotations

import re

from django.db import migrations

_JURISDICTION_MARKER_RE = re.compile(r"\s*\[[ЛL]\]")


def clean_marker(apps, schema_editor):
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")
    candidates = ChecklistTemplateItem.objects.filter(description__regex=r"\[[ЛL]\]")
    for item in candidates.iterator():
        cleaned = _JURISDICTION_MARKER_RE.sub("", item.description).strip()
        item.description = cleaned
        # measurable_criterion = description для импортированных пунктов
        # (ADR-081) — тот же служебный артефакт, чистим синхронно.
        if item.measurable_criterion == item.description or _JURISDICTION_MARKER_RE.search(
            item.measurable_criterion
        ):
            item.measurable_criterion = _JURISDICTION_MARKER_RE.sub(
                "", item.measurable_criterion
            ).strip()
        item.is_jurisdiction_sensitive = True
        item.save(update_fields=["description", "measurable_criterion", "is_jurisdiction_sensitive"])


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0016_checklist_jurisdiction_sensitive"),
    ]

    operations = [
        migrations.RunPython(clean_marker, migrations.RunPython.noop),
    ]
