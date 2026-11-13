"""Read-слой apps.jurisdictions."""

from __future__ import annotations

from .models import GLOBAL_COUNTRY_CODE, JurisdictionConfig


def suggest_currency_code(jurisdiction: JurisdictionConfig) -> str:
    """Подстановка валюты в форму создания черновика договора (ADR-041).

    ТОЛЬКО предзаполнение UI слоем API: пользователь видит и подтверждает
    значение, а итоговая валюта договора всё равно приходит от клиента
    явно и проверяется services.assert_currency_allowed(). Нигде в
    бизнес-логике это значение не используется как дефолт/fallback.
    """
    return jurisdiction.default_currency_code


class NoGlobalDefaultConfiguredError(RuntimeError):
    """В jurisdiction_config нет строки с is_global_default=True.

    Штатно недостижимо — сид-миграция (0004_seed_ru_and_global) создаёт
    контур GLOBAL, а констрейнт БД (0003) не даёт завести вторую такую
    строку. Сигнал непоправимой рассинхронизации окружения (например,
    миграция GLOBAL не докатилась), а не обычная ветка бизнес-логики —
    поэтому исключение, а не «тихий» None.
    """


def get_global_default_jurisdiction() -> JurisdictionConfig:
    """Контур GLOBAL — единственная строка с is_global_default=True."""
    try:
        return JurisdictionConfig.objects.get(is_global_default=True)
    except JurisdictionConfig.DoesNotExist as exc:
        raise NoGlobalDefaultConfiguredError(
            "нет ни одной конфигурации юрисдикции с is_global_default=True"
        ) from exc


def resolve_jurisdiction(country_code: str | None) -> JurisdictionConfig:
    """Fallback-резолвер контура (ГВ.1, docs/tasks/global-wave.md, ADR-070):
    «страна пользователя → плагин | GLOBAL».

    country_code — ТОЛЬКО явный выбор пользователя (сохранённый в его
    профиле выше по стеку). У резолвера нет параметра геолокации/IP —
    гео-детекция используется только как подсказка в UI при выборе страны,
    в бизнес-логику разрешения контура она не попадает вообще (п. 8
    приложения к ADR-060/070).

    Пользователь без страны (country_code is None/пусто) или со страной,
    для которой своего плагина ещё нет, — попадает в контур GLOBAL.
    country_code=GLOBAL_COUNTRY_CODE резолвится в тот же контур (не
    считается «страной без плагина» — это литерал самого контура).
    """
    if country_code and country_code != GLOBAL_COUNTRY_CODE:
        try:
            return JurisdictionConfig.objects.get(
                country_code=country_code, is_global_default=False
            )
        except JurisdictionConfig.DoesNotExist:
            pass
    return get_global_default_jurisdiction()


def resolve_locale(country_code: str | None) -> str:
    """Язык контура (ГВ.5, docs/tasks/global-wave.md, ADR-075) — тонкая
    обёртка над resolve_jurisdiction().primary_locale. Канонический источник
    «страна → язык» для всего проекта: common/i18n.py (ошибки problem+json)
    и apps.notifications (уведомления) читают контур ТОЛЬКО отсюда, не
    держат своего сопоставления."""
    return resolve_jurisdiction(country_code).primary_locale
