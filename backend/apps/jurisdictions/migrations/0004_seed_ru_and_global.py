"""Сид ГВ.1 (docs/tasks/global-wave.md, ADR-070): контур RU (существовал
только в тестах ad hoc — здесь впервые становится данными миграции, RU-волна
использует его как есть) и контур GLOBAL (is_global_default) — fallback для
пользователя без страны/со страной без своего плагина.

Набор допустимых валют — данные миграции, не код (задача ГВ.1: «набор — данные
миграции»). RU остаётся RUB-only (без изменений). GLOBAL — минимум USD/EUR +
RUB; коды сверены с активными валютами apps.catalog.Currency (миграция
apps.catalog 0007_seed_usd_eur), но здесь по слоям (jurisdictions ни от кого
не зависит) в apps.catalog не ходим — коды продублированы как данные.
"""

from django.db import migrations

from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE


def seed_ru_and_global(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")

    JurisdictionConfig.objects.update_or_create(
        country_code="RU",
        defaults={
            "default_currency_code": "RUB",
            "allowed_currency_codes": ["RUB"],
            "is_global_default": False,
            "legal_force_available": True,
            "tax_guidance_available": True,
            "platform_mediates_payment": True,
            "sms_channel_enabled": True,
        },
    )

    JurisdictionConfig.objects.update_or_create(
        country_code=GLOBAL_COUNTRY_CODE,
        defaults={
            "default_currency_code": "USD",
            "allowed_currency_codes": ["USD", "EUR", "RUB"],
            "is_global_default": True,
            # Профиль GLOBAL (постановка ГВ.1 §2): юрсилу не заявляем, налоги
            # не считаем, платежи сторон — вне платформы (reference-код),
            # SMS выключен (web-push + email вместо него, ГВ.5).
            "legal_force_available": False,
            "tax_guidance_available": False,
            "platform_mediates_payment": False,
            "sms_channel_enabled": False,
        },
    )


def unseed_ru_and_global(apps, schema_editor):
    JurisdictionConfig = apps.get_model("jurisdictions", "JurisdictionConfig")
    JurisdictionConfig.objects.filter(country_code__in=["RU", GLOBAL_COUNTRY_CODE]).delete()


class Migration(migrations.Migration):
    dependencies = [("jurisdictions", "0003_global_profile_fields")]

    operations = [
        migrations.RunPython(seed_ru_and_global, unseed_ru_and_global),
    ]
