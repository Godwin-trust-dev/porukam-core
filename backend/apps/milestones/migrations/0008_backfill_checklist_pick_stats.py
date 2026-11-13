"""Бэкфилл востребованности шаблонных пунктов чек-листа (ADR-153).

Живёт в apps.milestones, а не в apps.catalog, по той же причине, по которой
счётчик двигает фасад: каталог — нижний слой и читать `checklist_item`
(чужая таблица) не может даже миграцией; направление milestones → catalog
разрешено, поэтому историю считает тот, у кого она есть.

Считаем по тексту: `ChecklistItem.source_template` до этой миграции не
существовал, а `GET /checklist-recommendations` отдаёт плоский список
формулировок — единственный след происхождения уже созданного пункта — его
`description`. Тем же проходом заполняем и сам FK, чтобы дальше связь
читалась напрямую, без сопоставления текстов.

Неоднозначность (один текст в нескольких сферах — категория `other` есть
почти в каждом CL-файле) разрешается наименьшим `slug`, как в
`apps.catalog.selectors.find_checklist_template_by_description`: сферы
исторического пункта здесь под рукой нет (её могло не быть и в момент
создания), а расходиться с рантаймом хуже, чем взять детерминированный
вариант.
"""

from django.db import migrations

_BATCH = 500


def backfill(apps, schema_editor):
    ChecklistItem = apps.get_model("milestones", "ChecklistItem")
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")
    ChecklistTemplatePickStat = apps.get_model("catalog", "ChecklistTemplatePickStat")

    template_by_description: dict[str, tuple[str, object]] = {}
    for template_id, slug, description in (
        ChecklistTemplateItem.objects.filter(is_current=True)
        .exclude(slug="")
        .values_list("id", "slug", "description")
        .iterator()
    ):
        previous = template_by_description.get(description)
        if previous is None or slug < previous[0]:
            template_by_description[description] = (slug, template_id)

    counts: dict[str, int] = {}
    batch = []
    for item in ChecklistItem.objects.filter(source_template__isnull=True).iterator():
        matched = template_by_description.get(item.description)
        if matched is None:
            continue
        slug, template_id = matched
        counts[slug] = counts.get(slug, 0) + 1
        item.source_template_id = template_id
        batch.append(item)
        if len(batch) >= _BATCH:
            ChecklistItem.objects.bulk_update(batch, ["source_template"])
            batch = []
    if batch:
        ChecklistItem.objects.bulk_update(batch, ["source_template"])

    ChecklistTemplatePickStat.objects.bulk_create(
        [
            ChecklistTemplatePickStat(slug=slug, pick_count=count)
            for slug, count in sorted(counts.items())
        ],
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):
    dependencies = [
        ("milestones", "0007_checklistitem_source_template"),
    ]

    operations = [
        # Обратной операции нет: откат вернул бы счётчик к нулю, а не к
        # состоянию «до» — таблица статистики создаётся соседней миграцией
        # каталога и при откате уезжает вместе с ней целиком.
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
