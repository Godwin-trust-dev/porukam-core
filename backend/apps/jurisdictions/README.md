# apps.jurisdictions

Нижний слой: `JurisdictionConfig` — валютный блок (`default_currency_code`,
`allowed_currency_codes`, ADR-041, tech-spec.md §5.2.5 ревизия 2.0.3) плюс
блок GLOBAL-волны (ГВ.1, docs/tasks/global-wave.md, ADR-070):

- `is_global_default` — ровно одна строка с этим признаком (констрейнт БД,
  миграция 0003). Это контур `GLOBAL_COUNTRY_CODE` ("GLOBAL") — сид-данные
  миграция 0004_seed_ru_and_global.
- `selectors.resolve_jurisdiction(country_code)` — fallback-резолвер «страна
  пользователя (явный выбор) → плагин | GLOBAL». Гео-детекция сюда не
  попадает — только подсказка выше по стеку, резолвер такого параметра не
  принимает.
- Профиль контура (per-контур, не глобальный флаг): `legal_force_available`,
  `tax_guidance_available`, `platform_mediates_payment`, `sms_channel_enabled`.
  RU — все `True` (без изменений). GLOBAL — все `False` (юрсилу не заявляем,
  налоги не считаем, платежи сторон вне платформы с reference-кодом, SMS
  выключен).

Валюты — данные миграции, не код: RU остаётся RUB-only; GLOBAL — минимум
USD/EUR + RUB (сами валюты активируются в `apps.catalog.Currency.is_active`,
миграция apps.catalog/0007_seed_usd_eur — jurisdictions на catalog не
импортируется, коды дублируются как данные).

`primary_locale` (ГВ.5, docs/tasks/global-wave.md, ADR-075) — язык контура
(RU: `"ru"`, GLOBAL: `"en"`). `selectors.resolve_locale(country_code)` —
канонический источник «страна → язык»: читают `common/i18n.py` (ошибки
problem+json), `apps.accounts.selectors.get_user_locale`, `apps.
notifications.services.place_notification` (уведомления + SMS-гейт по
`sms_channel_enabled`) — никто не держит своего сопоставления.

Ещё не реализованы: entity_forms, tax_regimes, contract_types, провайдеры —
по docs/plan.md (этап 2). Ни от кого не зависит (import-linter).

Э6 (ADR-136 «Отмена части ГВ.3», ADR-137, миграция 0009, 26.08):
`evidence_server_storage_enabled=True` у ВСЕХ контуров — оригиналы
доказательств хранятся на сервере (шифротекстом, сроки ADR-137). Поле
оставлено ради обратимости; GLOBAL-путь ГВ.3 в `apps.evidence` жив за флагом.
