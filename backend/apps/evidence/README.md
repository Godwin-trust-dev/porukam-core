# apps.evidence

Доказательства (tech-spec.md §4, §5.2.8, §8.9; domain-model.md §14):
`Evidence` + `RetentionTimer`. Пайплайн приёма (хеш/миниатюра/EXIF) —
`services/evidence_ingest` (чистые функции без Django); здесь — транзакция,
модель, релей, бэкап, хранение, сроки.

## Что реализовано

- **Приём** (`POST /milestones/{id}/evidence`, `POST /disputes/{id}/evidence`):
  sha256 ОЧИЩЕННЫХ байт (EXIF вырезан, ADR-045), серверная метка времени
  (`common.timestamps`), миниатюра (ADR-125), лимиты размера/частоты
  (настройки), уведомление контрагенту, событие `evidence.received`.
- **Хранение оригиналов — на сервере во всех контурах** (ADR-136 §9, отмена
  GLOBAL-исключения ГВ.3; `jurisdictions/0009`): объект в бакете —
  ШИФРОТЕКСТ конверта `common.crypto` (per-object DEK, KEK субъекта
  `("evidence", id)`, мастер-ключ из env). `storage_mode=server` (новые),
  `ru` (до ADR-136, тот же путь чтения), `global` (путь ГВ.3 «оригинал у
  сторон», жив за флагом контура ради обратимости). Тумблер хранилища —
  `EVIDENCE_OBJECT_STORE=fake|s3`.
- **WORM** — `common/worm.py`, `WORM_MODE=object_lock|bucket_lock|none`
  (общий с чекпойнтами Audit Vault). Прод — Cloudflare R2, `bucket_lock`,
  отдельный бакет `porukam-evidence` (шаги владельца —
  `прод-конфиг`).
- **Бэкфилл** объектов до ADR-136: `manage.py evidence_encrypt_backfill
  [--batch-size N] [--limit N] [--dry-run] [--delete-plaintext]`
  (идемпотентно; `--delete-plaintext` только при `WORM_MODE=none`).
- **RetentionTimer** (ADR-036/137): по `contract.completed|terminated|closed`
  — три дедлайна `apps.deadlines` (`evidence_hot_retention` 90 дн →
  `archived`; `evidence_archive_retention` 365 дн → `shredded` =
  уничтожение ключей, строка/хеш/миниатюра остаются; `evidence_retention_notice`
  = архив − 10 дн → «скачайте себе» обеим сторонам). Пауза на `dispute.opened`,
  возобновление на `dispute.resolved` без других открытых споров с пределом
  `evidence_dispute_pause_cap` (180 дн после спора, ADR-137). Длительности —
  `DeadlineKindConfig` (`deadlines/0009`); публично — `GET /evidence/retention-policy`.
- **Окно 72 ч / `lateness`** (ADR-053): `unknown` (веб, нет времени
  съёмки) / `on_time` / `late` / `after_acceptance` (этап уже принят — в
  архив спора, на приёмку не влияет). Окно — `evidence_upload_window`.
- **DeviceKey-манифест** (серверная половина, ADR-053; `EVIDENCE_DEVICE_MANIFEST_ENABLED`,
  выкл. до Э10): `manifest` (JSON) + `signature` (base64) в том же
  multipart; проверка ключа/подписи/хеша/договора/назначения
  (`apps.authority.services.assignment_valid_at`); гео — только шифротекстом.
  `strong_protection` в сериализаторе; веб-загрузка — всегда `false`
  (пометка «без усиленной доказательной защиты»).
- **Дедуп по хешу**: индекс `file_hash`, тот же хеш в другом договоре →
  событие `evidence.duplicate_hash` (сигнал, не запрет).
- Скачивание/сверка (`/download`, `/verify`), миниатюра, BYO-бэкап в Google
  Drive (ADR-084).

## Слои и границы

`api/` (тонкие вьюхи, коды ошибок) → `services.py` (use cases, транзакции,
события) → `selectors.py` → `models.py`; `manifest.py` — чистые функции
подписи; `handlers.py` — подписчики outbox (`settings.OUTBOX_SUBSCRIBERS`);
`storage.py` — S3/фейк. Чужие приложения — через фасады: `apps.deadlines`
(services/selectors), `apps.authority` (services/selectors),
`apps.disputes` (selectors), `apps.contracts` (services/selectors).

## Коды ошибок API

`evidence_not_attached` 422, `checklist_item_wrong_milestone` 422,
`evidence_too_large` 413, `evidence_upload_rate_limited` 429,
`evidence_original_unavailable` 409, `evidence_original_shredded` 409,
`device_manifest_disabled` 409, `device_manifest_invalid` 422,
`assignment_not_valid` 403, `thumbnail_not_available` 404.

## Не реализовано (ADR-136 «Что заглушкой / что позже»)

TSA на файл (ADR-135 — на чекпойнт), подпись с телефона и `POST /evidence/batches`
(Э10), физический холодный тир, `GET /contracts/{id}/retention`, документы
`is_evidence_role=false`. Экспорт-пакет и выдача архива обеим сторонам — `apps.archive`
(ADR-139): читает отсюда `selectors.list_for_contract/retention_summary` и
`services.read_original_bytes`, реагирует на `evidence.shredded`.
