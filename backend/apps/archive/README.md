# apps.archive

Доказательный пакет сделки и его выдача сторонам (ADR-139; ADR-036 «экспорт
проверяется без участия платформы»; ADR-137 «архив обеим сторонам при
завершении, пакет — почтой, файлы — ссылкой, ссылка живёт дольше данных»).

Read-композиция поверх `contracts`/`milestones`/`payments`/`disputes`/
`warranty`/`evidence` (только фасады и селекторы, как `apps.dashboards`) +
Audit Vault через `apps.audit.client` + две свои таблицы: `ArchiveExport`
(сборка) и `ArchiveLink` (долгоживущая ссылка `/a/<token>`).

## Что реализовано

- **Два артефакта** (ADR-137 «разделение по размеру»):
  `package.zip` — `manifest.json` (запись сделки: стороны, замороженная
  версия, подписи, допники, этапы с чек-листами и материалами, платежи,
  разногласия, гарантийные заявки, хроника outbox, список доказательств с
  `sha256`/`lateness`/`strong_protection`, цепочный путь до корня чекпойнта
  Vault, сроки хранения), `SHA256SUMS` (формат `sha256sum -c`), `README.txt`,
  `index.html` (оглавление, печать в PDF браузером), `verify.py` (офлайн,
  stdlib), `checkpoint-<id>.json` + `checkpoint-<id>/NN-<host>.tsr|.tsq|
  .chain.pem|.ocsp.der` (когда чекпойнт заверен — ADR-135). Килобайты,
  бессрочно. `files.zip` — `files/<evidence_id>_<name>` (оригиналы,
  расшифрованные — те же байты, что получил контрагент) + `thumbnails/`.
  Мегабайты, по сроку хранения оригиналов.
- **Детерминизм**: единственное время в пакете — `snapshot_at` экспорта;
  повторная сборка того же экспорта даёт те же байты.
- **Цепочный путь** (`audit_chains`): линейная цепочка Vault
  (`this_hash = sha256(prev_hash || canonical)`) от самой ранней записи
  сделки в чекпойнте до его корня; записи ЭТОЙ сделки — с `canonical`,
  чужие — только `this_hash` (их содержимое сторонам не принадлежит).
  `verify.py` пересчитывает раскрытые звенья и сходится с корнем; корень
  заверяется `.tsr` (`openssl ts -verify`, команды в README пакета).
- **Асинхронно** (Cloudflare 125 с): `POST` только ставит `ArchiveExport`
  и Celery-задачу `build_archive_export` после коммита; beat
  `requeue_stale_exports` перезапускает потерянные `queued`.
- **Шифрование** артефактов тем же конвертом `common.crypto`, разные
  субъекты: `("archive_package", id)` (бессрочно) и `("archive_files", id)`
  (уничтожается по сроку). Presigned-ссылок нет — выдача стримом через
  приложение.
- **Выдача обеим сторонам** (`deliver_export`): ЛК (юрканал) + письмо с
  пакетом во вложении (`ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES`, по умолчанию
  20 МБ; крупнее — только ссылка) — **независимо от настройки e-mail**
  (`place_notification(force_email=True)`), без адреса — ЛК + `no_email`;
  ссылки на пакет и файлы — каждой стороне свои.
- **Автоэкспорт при завершении**: подписчик на `contract.completed` /
  `contract.terminated` / `contract.auto_closed` (ADR-138) / `contract.closed`
  (фолбэк); один автоэкспорт на договор.
- **`/a/<token>`**: 256 бит (`secrets.token_urlsafe(32)`), в БД sha256
  токена + шифротекст токена (для показа владельцу в API), без авторизации,
  рейт-лимит по адресу, `Cache-Control: private, no-store`, лог обращений
  (`archive.link_accessed` → Vault), отзыв `POST /archive/links/{id}/revoke`
  (любая сторона; ключ токена уничтожается). После `evidence.shredded` —
  `files.zip` удалён (ключ + объект), ссылка на файлы отвечает **410** с
  датой удаления, ссылкой на пакет и `SHA256SUMS`; пакет отдаётся всегда.

## API

| Метод и путь | Ответ |
|---|---|
| `GET /v1/contracts/{id}/archive` | превью состава (`ArchivePreview` DEV-12) + `retention` + `exports[]` |
| `POST /v1/contracts/{id}/archive/export` `{include_originals, manifest_only}` + `Idempotency-Key` | `202 {export_id, jobId, status}` |
| `GET /v1/contracts/{id}/archive/export/{export_id}` | `ExportJob`: `status` queued\|running\|ready\|failed, `progress`, `package`/`zip`/`pdf`(null), `links[]` |
| `POST /v1/archive/links/{id}/revoke` | ссылка |
| `GET /a/<token>` (без /v1, без авторизации) | zip / 404 / 409 / 410 / 429 |

Коды ошибок: `permission_denied` 403, `archive_nothing_to_export` 409,
`archive_options_conflict` 422, `archive_export_not_ready` 409,
`idempotency_key_required` 400, `idempotency_key_reused` 409,
`archive_link_not_found` 404, `archive_link_revoked` 410,
`archive_files_shredded` 410, `archive_link_rate_limited` 429.

## Настройки

`ARCHIVE_OBJECT_STORE` (fake|s3), `ARCHIVE_BUCKET_NAME`,
`ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES`, `ARCHIVE_LINK_BASE_URL`,
`ARCHIVE_LINK_RATE_LIMIT`, `ARCHIVE_LINK_RATE_WINDOW_SECONDS`,
`ARCHIVE_CHAIN_PATH_MAX_LINKS`, `ARCHIVE_BUILD_RETRY_SECONDS`,
`ARCHIVE_STALE_QUEUED_MINUTES`. nginx: `location /a/` → core
(`конфиг nginx`).

## Не реализовано (ADR-139 «Что позже»)

PDF-оглавление (нет WeasyPrint в зависимостях; `index.html` вместо него),
Merkle-коммитмент в чекпойнте (полный офлайн-путь без чужих хешей),
уведомление `archive.link_revoked`, физическое удаление `package.zip` по
GDPR-запросу (только ключ-субъект), BYO Drive в составе пакета.
