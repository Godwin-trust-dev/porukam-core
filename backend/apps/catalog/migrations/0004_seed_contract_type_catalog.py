"""Сид каталога типов договоров Р1 (ADR-058) — docs/catalog-v2.md §2-4, §7.

Отдельного сида «этапа 2» до этой миграции не было (README.md apps.catalog),
поэтому здесь заведён сразу утверждённый Р1 клиентского дерева (док 27 v2),
а не промежуточное состояние v1 с последующей дельтой.
"""

from django.db import migrations

_DISCLAIMER_RU = (
    " Платформа не налоговый агент и не налоговый консультант, не касается "
    "денежного потока и не исчисляет налоги сторон — это информация с "
    "дисклеймером, решение и обязанность за налоговую квалификацию у сторон."
)

_ITEMS = [
    # --- Р1: семь кодов клиентского дерева (§1, §2) ---
    {
        "code": "services_individual",
        "name_i18n": {"ru": "Услуга — исполнитель без бизнес-статуса"},
        "default_segment": "free_c2c",
        "client_option": "service",
        "available_from": "r1",
        "needs_official_clarification": False,
        "legal_basis": "ГК гл. 37/39; ФНС-06",
        "tax_note_i18n": {
            "ru": (
                "НДФЛ у исполнителя; заказчик-организация становится налоговым "
                "агентом по закону (мы его уведомляем); счётчик систематичности "
                "и подсказка оформить НПД."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 10,
    },
    {
        "code": "services_business",
        "name_i18n": {"ru": "Услуга — исполнитель СМЗ/ИП/юрлицо"},
        "default_segment": "paid_business",
        "client_option": "service",
        "available_from": "r1",
        "needs_official_clarification": False,
        "legal_basis": "ГК гл. 37/39; ФЗ-422; ADR-049",
        "tax_note_i18n": {
            "ru": (
                "СМЗ: чек НПД, лимит дохода 2,4 млн ₽/год, проверка статуса; "
                "ИП/ООО — закрывающий акт."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 11,
    },
    {
        "code": "sale_personal",
        "name_i18n": {"ru": "Продажа — продавец-физлицо (личное имущество)"},
        "default_segment": "free_c2c",
        "client_option": "sale",
        "available_from": "r1",
        "needs_official_clarification": True,
        "legal_basis": (
            "п. 5 ч. 2 ст. 6 ФЗ-422 (ФНС-07); ЗоЗПП к C2C не применяется "
            "(Пленум ВС № 17); п. 13 ст. 217 НК (ЛПХ, ФНС-08)"
        ),
        "tax_note_i18n": {
            "ru": (
                "Движимое имущество в собственности ≥ 3 лет — освобождение от "
                "НДФЛ; иначе вычет 250 тыс ₽ или расходы на приобретение; "
                "«продукция своего личного хозяйства» — освобождение по п. 13 "
                "ст. 217 НК при соблюдении условий (≤ 0,5 га, без наёмных, "
                "справка о ЛПХ)."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 20,
    },
    {
        "code": "sale_business",
        "name_i18n": {"ru": "Продажа — продавец-бизнес"},
        "default_segment": "paid_business",
        "client_option": "sale",
        "available_from": "r1",
        "needs_official_clarification": True,
        "smz_own_production_only": True,
        "legal_basis": "ГК гл. 30; ст. 26.1 ЗоЗПП (B2C — возврат 7 дней); ст. 4 ФЗ-422",
        "tax_note_i18n": {
            "ru": (
                "ИП/ООО — налог по применяемому режиму; самозанятый может "
                "продавать только товар СОБСТВЕННОГО производства (перепродажа "
                "чужого товара НПД не разрешена, ст. 4 ФЗ-422); B2C — памятка о "
                "возврате в течение 7 дней генерируется автоматически."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 21,
    },
    {
        "code": "rent_items",
        "name_i18n": {"ru": "Аренда — вещи"},
        "default_segment": "free_c2c",
        "requires_service_flag": True,
        "client_option": "rent",
        "available_from": "r1",
        "needs_official_clarification": False,
        "legal_basis": "ГК гл. 34; ст. 607, ст. 381.1 ГК",
        "tax_note_i18n": {
            "ru": (
                "Систематическая сдача движимого имущества внаём — НПД "
                "разрешён; разовая сдача — НДФЛ у арендодателя-физлица."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 30,
    },
    {
        "code": "rent_home",
        "name_i18n": {"ru": "Аренда — жильё"},
        "default_segment": "free_c2c",
        "requires_service_flag": True,
        "client_option": "rent",
        "available_from": "r1",
        "needs_official_clarification": True,
        "legal_basis": "ГК гл. 35; ст. 674 (регистрация ≥ 1 года), ст. 687, ст. 381.1 ГК",
        "tax_note_i18n": {
            "ru": (
                "НПД 4/6% для жилья разрешён (апартаменты — нет) либо НДФЛ — "
                "проверьте свой случай (открытый вопрос ФНС-03); срок ≥ 1 года "
                "требует регистрации обременения; расторжение по ст. 687 "
                "асимметрично для сторон."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 31,
    },
    {
        "code": "loan_individuals",
        "name_i18n": {"ru": "Займ между физлицами"},
        "default_segment": "free_c2c",
        "client_option": "loan",
        "available_from": "r1",
        "needs_official_clarification": True,
        "legal_basis": "ГК гл. 42; ст. 808 (письменная форма от 10 тыс), ст. 809 ГК; ст. 212 НК",
        "tax_note_i18n": {
            "ru": (
                "Тело займа — не доход; проценты — НДФЛ займодавца "
                "(самодекларирование); у заёмщика матвыгоды нет (ст. 212 НК)."
            )
            + _DISCLAIMER_RU
        },
        "sort_order": 40,
    },
    # --- Р2 hidden, коды не теряем (§3) ---
    {
        "code": "gift_movable",
        "name_i18n": {"ru": "Дарение движимого имущества"},
        "default_segment": "free_c2c",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 32",
        "tax_note_i18n": {"ru": "Отложено из Р1 (docs/catalog-v2.md §3)." + _DISCLAIMER_RU},
        "sort_order": 50,
    },
    {
        "code": "barter_personal",
        "name_i18n": {"ru": "Мена (личное имущество)"},
        "default_segment": "free_c2c",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 31",
        "tax_note_i18n": {"ru": "Отложено из Р1 (docs/catalog-v2.md §3)." + _DISCLAIMER_RU},
        "sort_order": 51,
    },
    {
        "code": "gratuitous_help",
        "name_i18n": {"ru": "Безвозмездная помощь"},
        "default_segment": "free_c2c",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 36 (безвозмездное пользование) — по аналогии",
        "tax_note_i18n": {"ru": "Отложено из Р1 (docs/catalog-v2.md §3)." + _DISCLAIMER_RU},
        "sort_order": 52,
    },
    # --- Special, Р2 hidden + заглушка «скоро» (§0 п.5, §3) ---
    {
        "code": "sale_vehicle",
        "name_i18n": {"ru": "Продажа транспортного средства"},
        "default_segment": "special",
        "needs_special_handling": True,
        "client_option": "sale",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 30; переучёт в ГИБДД",
        "tax_note_i18n": {
            "ru": "Требует переоформления учёта — этот тип сделки скоро (Р2)." + _DISCLAIMER_RU
        },
        "sort_order": 60,
    },
    {
        "code": "sale_real_estate",
        "name_i18n": {"ru": "Продажа недвижимости"},
        "default_segment": "special",
        "needs_special_handling": True,
        "client_option": "sale",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 30; переход права — Росреестр (V-TITLE)",
        "tax_note_i18n": {
            "ru": "Требует регистрации перехода права — этот тип сделки скоро (Р2)."
            + _DISCLAIMER_RU
        },
        "sort_order": 61,
    },
    {
        "code": "gift_registered",
        "name_i18n": {"ru": "Дарение недвижимости/транспорта"},
        "default_segment": "special",
        "needs_special_handling": True,
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "ГК гл. 32; переход права — Росреестр/ГИБДД (V-TITLE)",
        "tax_note_i18n": {"ru": "Требует переоформления реестра — Р2." + _DISCLAIMER_RU},
        "sort_order": 62,
    },
    # --- Excluded, скрыт всегда (§4) ---
    {
        "code": "shares_securities",
        "name_i18n": {"ru": "Доли, паи, ценные бумаги"},
        "default_segment": "excluded",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "платформа не готовит",
        "tax_note_i18n": {"ru": "Не поддерживается." + _DISCLAIMER_RU},
        "sort_order": 90,
    },
    {
        "code": "crypto_dfa",
        "name_i18n": {"ru": "Цифровая валюта / ЦФА"},
        "default_segment": "excluded",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "платформа не готовит",
        "tax_note_i18n": {"ru": "Не поддерживается." + _DISCLAIMER_RU},
        "sort_order": 91,
    },
    {
        "code": "employment",
        "name_i18n": {"ru": "Трудовые отношения"},
        "default_segment": "excluded",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "красная линия М-07 — терминологический и юридический риск",
        "tax_note_i18n": {"ru": "Не поддерживается." + _DISCLAIMER_RU},
        "sort_order": 92,
    },
    {
        "code": "loan_matching",
        "name_i18n": {"ru": "Матчинг займов"},
        "default_segment": "excluded",
        "is_hidden": True,
        "available_from": "r2",
        "legal_basis": "259-ФЗ — платформа не является оператором инвестиционной платформы",
        "tax_note_i18n": {"ru": "Не поддерживается." + _DISCLAIMER_RU},
        "sort_order": 93,
    },
]


def seed_contract_types(apps, schema_editor):
    ContractTypeCatalogItem = apps.get_model("catalog", "ContractTypeCatalogItem")
    for item in _ITEMS:
        code = item["code"]
        defaults = {k: v for k, v in item.items() if k != "code"}
        ContractTypeCatalogItem.objects.update_or_create(code=code, defaults=defaults)


def unseed_contract_types(apps, schema_editor):
    ContractTypeCatalogItem = apps.get_model("catalog", "ContractTypeCatalogItem")
    ContractTypeCatalogItem.objects.filter(code__in=[item["code"] for item in _ITEMS]).delete()


class Migration(migrations.Migration):
    dependencies = [("catalog", "0003_contracttypecatalogitem")]

    operations = [
        migrations.RunPython(seed_contract_types, unseed_contract_types),
    ]
