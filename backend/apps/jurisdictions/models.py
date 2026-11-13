"""domain-model.md §15 (JurisdictionConfig). Здесь — валютный блок (ADR-041)
и блок GLOBAL-волны (ГВ.1, docs/tasks/global-wave.md, ADR-070): признак
is_global_default и профиль контура (юрсила/налоги/платежи/SMS). Остальные
поля JurisdictionConfig (entity_forms, tax_regimes, contract_types,
провайдеры) добавляются на этапе 2 (docs/plan.md)."""

from django.contrib.postgres.fields import ArrayField
from django.db import models

# Псевдо-код страны для контура-по-умолчанию (ГВ.1). Не ISO 3166-1 — единственное
# исключение в этом поле, отсюда и расширенный max_length у country_code.
GLOBAL_COUNTRY_CODE = "GLOBAL"


class JurisdictionConfig(models.Model):
    """Конфигурация страны (плагин) или контура GLOBAL. Одна запись на country_code.

    default_currency_code — ТОЛЬКО подстановка в форму UI при создании
    черновика договора (ADR-041); не дефолт логики нигде. allowed_currency_codes —
    закрытый список валют юрисдикции, против которого валидируется валюта
    договора (apps.jurisdictions.services.assert_currency_allowed).

    Инвариант «default_currency_code входит в allowed_currency_codes»
    закреплён CHECK-констрейнтом БД (миграция 0002, живой PostgreSQL).

    is_global_default — ровно одна строка с этим признаком (констрейнт БД,
    миграция 0003): контур, в который попадает пользователь без страны или
    со страной без своего плагина (apps.jurisdictions.selectors.resolve_jurisdiction,
    ADR-070). Стране резолвер доверяет только явному выбору пользователя —
    гео-детекция нигде в этом приложении не используется, только подсказка
    выше по стеку.

    Профиль контура (ADR-070, §2 таблицы задачи ГВ.1) — не поведение кода,
    а данные конфигурации, которые читают приложения выше по стеку по мере
    реализации: legal_force_available (контур утверждает юридическую силу
    подписанного договора по местному праву — GLOBAL: нет, «фиксируем факты;
    их юридическую судьбу определяет ваша юрисдикция»), tax_guidance_available
    (контур считает/подсказывает налоговый режим), platform_mediates_payment
    (платёж идёт через контур платформы vs GLOBAL — вне платформы, только
    reference-код), sms_channel_enabled (SMS как канал уведомлений допустим
    в контуре).

    primary_locale (ГВ.5, docs/tasks/global-wave.md, ADR-075) — язык
    ошибок/уведомлений контура (RU: "ru", GLOBAL: "en"). Это ЕДИНСТВЕННЫЙ
    источник для «выбора языка по контуру» — apps.jurisdictions.selectors.
    resolve_locale() читает отсюда, а не хранит своё сопоставление
    country_code → язык где-то ещё.

    evidence_server_storage_enabled (ГВ.3, миграция 0007/0008) — хранит ли
    контур оригиналы доказательств на сервере. С 26.08 (ADR-136 «Отмена
    части ГВ.3», ADR-137, миграция 0009) — True у ВСЕХ контуров: оригиналы
    лежат в бакете шифротекстом, GDPR закрывается шифрованием + сроками
    хранения + crypto-shredding. Поле оставлено ради обратимости (GLOBAL-путь
    «хеш у платформы, оригинал у сторон» в apps.evidence жив за флагом).
    """

    country_code = models.CharField(max_length=8, primary_key=True)
    default_currency_code = models.CharField(max_length=3)
    allowed_currency_codes = ArrayField(models.CharField(max_length=3), default=list)

    is_global_default = models.BooleanField(default=False)

    legal_force_available = models.BooleanField(default=True)
    tax_guidance_available = models.BooleanField(default=True)
    platform_mediates_payment = models.BooleanField(default=True)
    sms_channel_enabled = models.BooleanField(default=True)
    primary_locale = models.CharField(max_length=8, default="ru")
    evidence_server_storage_enabled = models.BooleanField(default=True)

    class Meta:
        db_table = "jurisdiction_config"
        verbose_name = "конфигурация юрисдикции"
        verbose_name_plural = "конфигурации юрисдикций"
        constraints = [
            models.UniqueConstraint(
                fields=["is_global_default"],
                condition=models.Q(is_global_default=True),
                name="jurisdiction_config_single_global_default",
            ),
        ]

    def __str__(self) -> str:
        return self.country_code
