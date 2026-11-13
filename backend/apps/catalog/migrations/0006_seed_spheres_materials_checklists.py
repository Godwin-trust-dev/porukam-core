"""Сид справочников сфер/материалов/шаблонов чек-листа (Э4.3,
docs/tasks/etap-4.md) — минимальный набор для механики рекомендаций
(ADR-047), НЕ полное наполнение всех 17 сфер (решение 01.08,
docs/contract-forms.md §8 п.1 — отдельный контентный трек П-03/Б9,
генерация партиями с ревью Godwin).

Коды сфер — те же 7, что уже используются как временный список в
apps.contracts.forms.SPHERE_CODES (до переезда той дельты на реальную
таблицу, см. её докстринг «Справочники-плейсхолдеры»). У каждой сферы —
обязательная позиция «Прочее» (`other_<sphere>`, domain-model.md §7.3);
для `renovation` дополнительно — пара реальных позиций с шаблонными
пунктами чек-листа, чтобы GET .../checklist-recommendations было на чём
проверять (тесты Э4.3), и один базовый (сферный) пункт чек-листа.
"""

from django.db import migrations

_SPHERE_CODES = (
    "renovation",
    "delivery",
    "tutoring",
    "it",
    "household",
    "design",
    "other",
)

_SPHERE_NAMES_RU = {
    "renovation": "Ремонт",
    "delivery": "Доставка",
    "tutoring": "Репетиторство",
    "it": "IT",
    "household": "Бытовые услуги",
    "design": "Дизайн",
    "other": "Другое",
}

_RENOVATION_ITEMS = [
    {
        "code": "renovation_tile",
        "name_i18n": {"ru": "Плитка керамическая"},
        "suggested_unit": "м²",
        "spec_template": ["производитель", "коллекция", "размер", "цвет"],
        "checklist": [
            {
                "description": "Плитка уложена без перепадов по высоте",
                "measurable_criterion": "перепад между смежными плитками ≤ 1 мм (правило+уровень)",
                "required_evidence": ["photo", "video"],
            },
            {
                "description": "Швы между плитками ровные и затёрты",
                "measurable_criterion": "ширина шва одинакова по всей поверхности ± 0.5 мм",
                "required_evidence": ["photo"],
            },
        ],
    },
    {
        "code": "renovation_wallpaper",
        "name_i18n": {"ru": "Обои"},
        "suggested_unit": "рулон",
        "spec_template": ["производитель", "артикул", "тип (флизелин/винил/бумага)"],
        "checklist": [
            {
                "description": "Стыки полотен не расходятся и рисунок совмещён",
                "measurable_criterion": "зазор в стыке отсутствует, смещение рисунка ≤ 2 мм",
                "required_evidence": ["photo"],
            },
        ],
    },
]

_RENOVATION_SPHERE_CHECKLIST = [
    {
        "description": "После завершения работ помещение убрано от строительного мусора",
        "measurable_criterion": "отсутствие видимого мусора/пыли на полу и поверхностях",
        "required_evidence": ["photo"],
    },
]


def seed(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    MaterialCatalogItem = apps.get_model("catalog", "MaterialCatalogItem")
    ChecklistTemplateItem = apps.get_model("catalog", "ChecklistTemplateItem")

    spheres = {}
    for code in _SPHERE_CODES:
        sphere, _created = Sphere.objects.update_or_create(
            code=code, defaults={"name_i18n": {"ru": _SPHERE_NAMES_RU[code]}, "is_active": True}
        )
        spheres[code] = sphere
        MaterialCatalogItem.objects.update_or_create(
            code=f"other_{code}",
            defaults={
                "sphere": sphere,
                "name_i18n": {"ru": "Прочее"},
                "suggested_unit": "",
                "spec_template": [],
                "is_active": True,
            },
        )

    renovation = spheres["renovation"]
    for item in _RENOVATION_ITEMS:
        catalog_item, _created = MaterialCatalogItem.objects.update_or_create(
            code=item["code"],
            defaults={
                "sphere": renovation,
                "name_i18n": item["name_i18n"],
                "suggested_unit": item["suggested_unit"],
                "spec_template": item["spec_template"],
                "is_active": True,
            },
        )
        for order, tpl in enumerate(item["checklist"]):
            ChecklistTemplateItem.objects.update_or_create(
                catalog_item=catalog_item,
                description=tpl["description"],
                defaults={
                    "measurable_criterion": tpl["measurable_criterion"],
                    "required_evidence": tpl["required_evidence"],
                    "order": order,
                },
            )

    for order, tpl in enumerate(_RENOVATION_SPHERE_CHECKLIST):
        ChecklistTemplateItem.objects.update_or_create(
            sphere=renovation,
            catalog_item=None,
            description=tpl["description"],
            defaults={
                "measurable_criterion": tpl["measurable_criterion"],
                "required_evidence": tpl["required_evidence"],
                "order": order,
            },
        )


def unseed(apps, schema_editor):
    Sphere = apps.get_model("catalog", "Sphere")
    MaterialCatalogItem = apps.get_model("catalog", "MaterialCatalogItem")
    # MaterialCatalogItem.sphere — on_delete=PROTECT: убрать материалы раньше
    # сфер, иначе удаление Sphere упадёт ProtectedError.
    MaterialCatalogItem.objects.filter(sphere__code__in=_SPHERE_CODES).delete()
    Sphere.objects.filter(code__in=_SPHERE_CODES).delete()


class Migration(migrations.Migration):
    dependencies = [("catalog", "0005_sphere_material_checklist")]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
