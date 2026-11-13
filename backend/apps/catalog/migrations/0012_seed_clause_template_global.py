"""Сид ГВ.5 (docs/tasks/global-wave.md, ADR-075): GLOBAL-профиль ClauseTemplate
— та же структура К/V, что RU-конструктор (docs/contract-forms.md, приложение
к ADR-060/070), нейтральные EN-тексты-болванки (финальные придут контентным
пакетом, тот же принцип, что остальные i18n-болванки этой волны),
legal_anchors=[] (ГВ.1 §2: юрсилу в GLOBAL не заявляем).

Коды блоков — только те, что реально используются формами договоров сейчас
(apps/contracts/forms.py, grep kv_block=), не полный список К1–К15 из
доктрины (docs/contract-forms.md) — остальные заводятся по мере появления
форм, которые их используют (та же экономность, что Sphere/ContractType
сиды: механизм + текущий реальный набор, не воображаемый полный).

RU-строки НЕ заводятся здесь — см. docstring модели ClauseTemplate.

country_code="GLOBAL" — литерал, не импорт apps.jurisdictions.models.
GLOBAL_COUNTRY_CODE: apps.catalog и apps.jurisdictions — сиблинги нижнего
слоя, друг от друга не зависят по духу CLAUDE.md, хотя формальный
контракт import-linter прямо этого не запрещает (тот же принцип, что коды
валют между apps.catalog.Currency и apps.jurisdictions.JurisdictionConfig,
0007_seed_usd_eur)."""

from django.db import migrations

# Совпадает с apps.jurisdictions.models.GLOBAL_COUNTRY_CODE — не импортируется
# (см. docstring выше), значение продублировано как данные.
_GLOBAL_COUNTRY_CODE = "GLOBAL"

# EN-болванки, соответствующие блокам, которые кодирует
# apps/contracts/forms.py (kv_block=...).
_GLOBAL_CLAUSES = {
    "K1": "This agreement is entered into by the parties identified above.",
    "K2": "The party performing services or work agrees to complete them as described below.",
    "K3": "Payment for the subject of this agreement is arranged directly between the parties.",
    "K4": "The timeline and delivery schedule are set out below.",
    "K7": "The parties will document the handover and acceptance of results as described below.",
    "K8": "Warranty terms, if any, are set out below.",
    "V-ACCESS": "Access arrangements needed to perform the work are described below.",
    "V-GOODS": "The goods being sold are described below, including their condition.",
    "V-HANDOVER": "Handover and return procedures are described below.",
    "V-INV": "An inventory of items is recorded below.",
    "V-LOAN": "The loan amount, repayment schedule, and terms are set out below.",
    "V-PORT": "Portfolio visibility preferences for this deal are set out below.",
    "V-RENT": "The rented item and rental terms are described below.",
    "V-SUB": "Subcontracting terms, if any, are set out below.",
    "tax_note": (
        "This platform does not calculate or withhold taxes; each party is responsible for"
        " their own tax obligations under applicable law."
    ),
}


def seed_global_clauses(apps, schema_editor):
    ClauseTemplate = apps.get_model("catalog", "ClauseTemplate")
    for block_code, text in _GLOBAL_CLAUSES.items():
        ClauseTemplate.objects.update_or_create(
            country_code=_GLOBAL_COUNTRY_CODE,
            block_code=block_code,
            defaults={"text": text, "legal_anchors": []},
        )


def unseed_global_clauses(apps, schema_editor):
    ClauseTemplate = apps.get_model("catalog", "ClauseTemplate")
    ClauseTemplate.objects.filter(
        country_code=_GLOBAL_COUNTRY_CODE, block_code__in=_GLOBAL_CLAUSES
    ).delete()


class Migration(migrations.Migration):
    dependencies = [("catalog", "0011_clause_template")]

    operations = [
        migrations.RunPython(seed_global_clauses, unseed_global_clauses),
    ]
