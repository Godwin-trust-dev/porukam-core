import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True, scope="session")
def _flush_cache_before_tests():
    """Redis (в отличие от тестовой БД) не откатывается транзакцией между
    тестами — без этого повторные локальные прогоны `pytest` без рестарта
    redis_cache подхватывают счётчики rate-limit от прошлого прогона."""
    cache.clear()


_SEED_APPS = ("catalog", "deadlines", "jurisdictions", "l10n", "notifications")


def _replay_notifications_0002() -> None:
    """`notifications.0002` писала одноязычный `body_stub`, а `0003` перенесла
    его в `body_i18n` и удалила поле — на актуальной схеме исходная функция
    падает с FieldError. Берём ЕЁ ЖЕ данные и применяем сразу в целевом виде,
    то есть воспроизводим цепочку 0002 → 0003. Без этого два шаблона остаются
    с пустым телом, а точки напоминаний не заводятся вовсе (до них функция
    не доходит) — и падают тесты рендера уведомлений и гарантийных сроков.
    """
    import importlib

    from apps.notifications.models import NotificationTemplate, ReminderPointConfig

    migration = importlib.import_module(
        "apps.notifications.migrations.0002_seed_templates_and_reminder_points"
    )
    for code, fields in migration.TEMPLATES.items():
        defaults = dict(fields)
        body = defaults.pop("body_stub", "")
        if body:
            defaults["body_i18n"] = {"ru": body}
        NotificationTemplate.objects.update_or_create(code=code, defaults=defaults)
    for kind, fields in migration.REMINDER_POINTS.items():
        ReminderPointConfig.objects.update_or_create(kind=kind, defaults=fields)


def _replay_data_migrations() -> None:
    """Перепрогоняет forward-функции всех RunPython-миграций приложений с
    сидами — по возрастанию номера, с РЕАЛЬНЫМИ моделями. Сиды идемпотентны
    (`update_or_create`), поэтому повтор безопасен.

    Часть исторических функций писалась под промежуточную схему (например
    `notifications.0002` заполняет поле `body_stub`, позже переименованное) —
    такие пропускаем: цель фикстуры не воспроизвести историю, а вернуть
    актуальный набор сидов, который доложат следующие миграции.
    """
    import importlib
    import pkgutil
    import re

    from django.apps import apps as django_apps
    from django.core.exceptions import FieldDoesNotExist, FieldError

    _replay_notifications_0002()  # до общего прогона: 0004+ дополнят тела переводами
    for app in _SEED_APPS:
        package = importlib.import_module(f"apps.{app}.migrations")
        names = sorted(
            module.name
            for module in pkgutil.iter_modules(package.__path__)
            if re.match(r"^\d{4}_", module.name)
        )
        for name in names:
            migration = importlib.import_module(f"apps.{app}.migrations.{name}")
            for operation in getattr(migration.Migration, "operations", []):
                forward = getattr(operation, "code", None)
                if forward is None:
                    continue
                try:
                    forward(django_apps, None)
                except (FieldError, FieldDoesNotExist, TypeError):
                    continue  # функция под старую схему — её данные доложат следующие


@pytest.fixture(autouse=True)
def _ensure_jurisdiction_seeds(request):
    """Транзакционные тесты (django_db(transaction=True)) после себя ДЕЛАЮТ
    FLUSH всех таблиц — вместе с данными data-миграций. С `--reuse-db` такая
    БД переживает прогон, и любой следующий тест, дошедший до
    resolve_request_locale (обработчик problem+json), падает на пустом
    JurisdictionConfig. Восстанавливаем сиды миграций 0004/0006/0008/0009 перед
    тестом, если их смыло (идемпотентно, ~1 запрос exists() в обычном
    случае). Тесты без django_db БД не трогают — пропускаем.

    Тем же FLUSH смывает и остальные сиды — каталог типов, сферы, шаблоны
    уведомлений, длительности дедлайнов, локали, — из-за чего СЛЕДУЮЩИЙ
    прогон падал сотнями `…DoesNotExist` в случайных местах (порядок тестов
    случаен). Штатный `serialized_rollback=True` тут не спасает: буфер
    восстановления наполняется только при СОЗДАНИИ тестовой БД, а с
    `--reuse-db` создание пропускается. Поэтому, обнаружив смытую БД,
    перепрогоняем data-миграции целиком (`_replay_data_migrations`)."""
    marker = request.node.get_closest_marker("django_db")
    if "django_db" not in request.fixturenames and not marker:
        yield
        return
    # Тестам с не-default БД (audit_vault: databases=["audit"]) в default
    # лезть нельзя (DatabaseOperationForbidden) — да и сиды им не нужны.
    databases = (marker.kwargs.get("databases") if marker else None) or ["default"]
    if databases != "__all__" and "default" not in databases:
        yield
        return
    from apps.catalog.models import ContractTypeCatalogItem
    from apps.jurisdictions.models import GLOBAL_COUNTRY_CODE, JurisdictionConfig

    if not ContractTypeCatalogItem.objects.exists():
        _replay_data_migrations()

    if not JurisdictionConfig.objects.filter(is_global_default=True).exists():
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
                "legal_force_available": False,
                "tax_guidance_available": False,
                "platform_mediates_payment": False,
                "sms_channel_enabled": False,
                "primary_locale": "en",
                # ADR-136/137 (jurisdictions 0009): серверное хранение везде.
                "evidence_server_storage_enabled": True,
            },
        )
    yield
