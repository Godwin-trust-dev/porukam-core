# apps.l10n

Нижний слой (как `apps.catalog`/`apps.jurisdictions`): не импортирует ничего
из других `apps.*` (import-linter). Инфраструктура языковых пакетов (Л.2,
docs/tasks/l10n-wave.md) — продолжение фолбэк-механизма ГВ.5 (ADR-075,
`common/i18n.py`), не дубликат.

`Locale` (code BCP-47, name, rtl, enabled, quality: canonical|reviewed|
machine) — справочник языков; сид `en`/`ru` (миграция 0002). `LocalePack` —
последний импортированный пакет на язык (по значению pack_version +
sha256-checksum содержимого, история версий не хранится).

`services.import_pack` — идемпотентный (тот же pack_version + то же
содержимое → no-op), версионированный (меньший pack_version →
`StalePackError`; тот же версии, другое содержимое → `PackVersionConflictError`),
частичный пакет валиден (отсутствующие namespaces/ключи — фолбэк на EN
читает `selectors`, не сам импорт). Management-команда `import_l10n_pack
<file>` — тонкая обёртка.

`selectors.get_pack_text`/`get_error_title`/`get_notification_text`/
`get_catalog_text`/`get_clause_text`/`get_legal_text` — чтение с фолбэком
`запрошенный язык → en` (НЕ до `ru` — RU-контур остаётся на своём
отдельном, не тронутом этой веткой механизме). `common/i18n.py` —
единственное готовое подключение в этой волне (заголовки
application/problem+json на произвольном включённом языке); подключение
`apps.notifications`/`apps.catalog` к тем же селекторам — следующая волна
(инфраструктура уже готова, полный рольаут — по мере контент-пакетов).

Формат файла пакета и схема — `l10n/README.md` (корень репозитория).

GET `/v1/locales` — активные языки (для бейджа beta на фронте), публичный
эндпоинт. Шейп ответа — `LocaleSerializer` (api/serializers.py), под
контракт фронта `LocaleInfo` (packages/core/src/api/types.ts), НЕ модель
`Locale` буквально: `self_name` (= `Locale.name`, родное название) +
`english_name` (статический справочник `ENGLISH_NAMES` в самом
сериализаторе — это не БД-волна переводов), `quality` сведено к
`human`/`machine` (canonical/reviewed → `human`), `dir` вместо булева
`rtl`, и `enabled` — сериализуется явно (раньше не входил в `fields`, из-за
чего фронт получал `undefined` и считал все языки выключенными,
docs/tasks/Задача_fix_web-locales-switcher.md).

Ни от кого не зависит (import-linter).
