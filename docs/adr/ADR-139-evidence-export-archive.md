# ADR-139. Доказательный пакет сделки и выдача архива обеим сторонам: `apps.archive`, асинхронная сборка, долгоживущие ссылки `/a/<token>`

- Статус: принято
- Дата: 2026-08-26
- Ветка: `feat/evidence-export` (от `feat/evidence`, ADR-136)
- Связано с: ADR-036 (экспорт: ZIP + манифест хешей, «проверяется без
  участия платформы»), ADR-038/065 (Audit Vault, линейная хеш-цепочка,
  чекпойнт), ADR-059 (envelope-шифрование, crypto-shredding), ADR-064
  (outbox, at-least-once), ADR-126 (матрица уведомлений), ADR-135 (TSA на
  корень чекпойнта, `feat/audit-vault-tsa`), ADR-136 (Э6-фундамент:
  шифрование оригиналов, RetentionTimer), **ADR-137 (сроки хранения и
  передача архива — решение владельца, этот ADR его исполняет: требования
  1, 2, 5, 6, 7, 10, 11; шаги 1–6, 9, 11)**, ADR-138 (`contract.auto_closed`);
  фронт-контракт — `docs/tasks/DEV-12_экспорт-архива-сделки.md`.

## Контекст

ADR-137 решил, что архив сделки выдаётся **обеим сторонам при завершении**
«добровольно-принудительно»: доказательство нужно не тому, у кого оно
лежит, а копия у каждой стороны делает «потерю» невыгодного документа
бессмысленной. Там же — разделение по размеру (пакет — письмом, файлы —
ссылкой), ограничения Cloudflare (125 с, `no-store`), долгоживущие ссылки с
непрозрачным токеном, «ссылка живёт дольше данных». ADR-036 требовал, чтобы
пакет **объяснял сам себя**: манифест хешей + инструкция, иначе платформа
— заинтересованный свидетель. ADR-136 дал фундамент (шифрование
оригиналов, RetentionTimer, поля манифеста) и явно вынес экспорт в
отдельную задачу. Фронт (DEV-12, `web/src/mocks/archiveHandlers.ts`) уже
ждёт `GET /contracts/{id}/archive`, `POST …/archive/export` → 202,
`GET …/archive/export/{jobId}`.

## Решение

### 1. Новое приложение `apps.archive`, не `apps.evidence`

Пакет собирается из **пяти** контекстов (contracts, milestones, payments,
disputes/warranty, evidence) и из Audit Vault. Класть это в `apps.evidence`
значило бы дать ему право читать всё остальное и хранить «экспорт» рядом с
доказательствами, которые он лишь перечисляет. `apps.archive` — read-
композиция поверх фасадов и селекторов (конвенция ADR-090 как у
`apps.dashboards`) + две собственные таблицы: `ArchiveExport` (сборка) и
`ArchiveLink` (ссылка стороны на артефакт). Регистрируется после
`apps.evidence`; import-linter чист (направление одно — archive → остальные,
обратных импортов нет). Добавлены точечные фасады:
`apps.evidence.selectors.list_for_contract/retention_summary`,
`apps.disputes.selectors.list_for_contract`, Vault —
`apps.audit.client.find_entry_seq/checkpoint_covering/chain_links/
checkpoint_record/checkpoint_files/checkpoint_openssl_commands`.

### 2. Два артефакта одной сборки (ADR-137 «разделение по размеру»)

| Артефакт | Состав | Объём | Судьба |
|---|---|---|---|
| `package.zip` | `manifest.json`, `SHA256SUMS`, `README.txt`, `index.html`, `verify.py`, `verify.ps1`, `checkpoint-<id>.json` + `checkpoint-<id>/NN-<host>.tsr\|.tsq\|.chain.pem\|.ocsp.der` | килобайты | **бессрочно** (треб. 5–6) |
| `files.zip` | `files/<evidence_id>_<name>` (оригиналы — открытые байты, те же, что у контрагента), `thumbnails/<id>.jpg` | мегабайты | по сроку хранения оригиналов; `evidence.shredded` → удалён |

`manifest.json` (`porukam.archive_manifest/1`): запись сделки (стороны с
`profile_id`/`trust_id`/именем, замороженная версия целиком со `snapshot` и
`integrity_hash`, все версии, подписи, допники с изменениями и подписями,
дерево этапов с чек-листами и материалами, платежи, разногласия,
гарантийные заявки, хроника outbox до `snapshot_at`), доказательства
(`sha256` очищенных байт, размер, метки времени, `lateness`,
`strong_protection`, `has_geo`, `retention_state`, `original_included`),
`audit_checkpoints`, `audit_chains`, `retention` (состояние таймера + даты
+ публичная политика), `sections` (счётчики состава). Единственное время
в пакете — `snapshot_at` экспорта: **повторная сборка того же экспорта
даёт те же байты** (тест), zip с фиксированными `date_time`/атрибутами и
сортировкой путей.

`SHA256SUMS` — формат GNU `sha256sum -c` (два пробела), покрывает и файлы
пакета, и файлы `files.zip`: оба zip распаковываются в один каталог, одна
команда проверяет всё; без `files.zip` — `--ignore-missing`.

**Примечание 03.09 (замечание владельца «простому смертному не понятно что
делать»).** `README.txt` переписан в ТРИ слоя, двуязычие построчно (ru-строка,
следом en): часть 1 «Что это и зачем» — снимок сделки + отпечаток (хеш)
каждого файла, проверять НЕ обязательно, состав пакета по строке на файл;
часть 2 «Как проверить, что файлы не менялись» — общий шаг 0 (распаковать оба
zip в одну папку) и три пути по шагам с объяснением каждой команды и разбором
вывода («OK» у каждой строки / «FAILED» / «ПРОПУЩЕН»): Windows (Проводник →
«Извлечь всё…» → PowerShell `verify.ps1`, запасной путь `Get-FileHash`), macOS
(`shasum -a 256 -c SHA256SUMS`), Linux (`sha256sum -c`); часть 3 — прежние
экспертные шаги (хеши доказательств, цепочка Vault, `openssl ts -verify …`)
под явной оговоркой «обычному участнику сделки не нужно».

В пакет добавлен **`verify.ps1`** — PowerShell-аналог `sha256sum -c` (читает
`SHA256SUMS`, `Get-FileHash` на каждый файл, печатает `OK`/`FAILED`, а
отсутствующие — `ПРОПУЩЕН / MISSING` без ошибки: files.zip мог быть не
распакован или удалён по сроку хранения; код возврата 1 при расхождении,
2 — если `SHA256SUMS` рядом нет). Файл начинается с BOM: Windows PowerShell
5.1 без BOM читает `.ps1` в кодировке системы и портит кириллицу. Скрипт —
такой же файл пакета, как остальные: он входит в `SHA256SUMS` и в
`PACKAGE_ROOT_FILES`. `verify.py` не тронут (он же остаётся единственным, кто
проверяет цепочку Vault). Детерминизм сохранён: в README и `verify.ps1` нет
ничего, кроме `snapshot_at`, — повторная сборка даёт тот же `package_sha256`.

**PDF-оглавления нет — сознательно.** В `uv.lock` нет WeasyPrint/reportlab/
fpdf (PyPI недоступен), а «минимальный PDF своими руками» с базовыми
шрифтами не умеет кириллицу — вместо подделки шрифтами отдаём `index.html`
(UTF-8, печатается в PDF любым браузером). В API `format.pdf=false`,
`ExportJob.pdf=null`; фронт DEV-12 ждал `pdf+zip` — расхождение помечено
в задаче.

### 3. Цепочный путь «запись → заверенный корень» (честно о пределе)

Цепочка Vault **линейная** (ADR-038: `this_hash = sha256(prev_hash ||
canonical)`), и её чекпойнт заверяет `this_hash` последней записи
(ADR-135). Inclusion-proof для линейной цепочки — это все `canonical`
промежуточных записей, а они содержат данные ЧУЖИХ сделок. Компромисс:

- `audit_chains["checkpoint-<id>"]` — путь от **самой ранней записи этой
  сделки** в чекпойнте до `seq_to`: звенья этой сделки (цель — договор/его
  доказательство, либо `payload.contract_id` наш) — с `canonical`,
  остальные — **только `seq` + `prev_hash` + `this_hash`**;
- `verify.py` пересчитывает раскрытые звенья, проверяет сцепку
  `prev_hash` всех звеньев и сходимость с `root`; чужие звенья — принятые
  хеши (их содержимое лежит в WORM-объекте чекпойнта и выдаётся по
  запросу суда/эксперта через `read()` Vault — ADR-038);
- корень заверяется `.tsr` (`openssl ts -verify`), то есть «не позже
  genTime существовали все звенья пути».

Это «проверка без платформы» для собственных записей и метки времени, но
**не** для чужих звеньев. Полный офлайн-путь без чужих хешей требует
Merkle-коммитмента в чекпойнте (формат v3: `merkle_root` над `this_hash`
листьев, штампуемый imprint = `sha256(root || merkle_root)`), что меняет
`services/audit_vault/checkpoint.py` параллельной ветки — вопрос
владельцу, см. «Что позже». Фасад Vault `chain_links(disclose=…)` —
не `read()` (только служебные роли): наружу уходит лишь то, что стороне и так
принадлежит. `ARCHIVE_CHAIN_PATH_MAX_LINKS` (20 000, ~100 байт на чужое
звено) — потолок, сверх — `truncated=true` в манифесте.

Формат `checkpoint-<id>.json` и имена `NN-<host>.tsr|.tsq|.chain.pem|
.<ocsp|crl>.der` повторяют `verify_checkpoint_timestamps --export-dir`
ветки `feat/audit-vault-tsa` (пакет юристу и пакет сделки проверяются
одними командами). Код НЕ импортирован из другой ветки: минимальные функции
экспорта — `services/audit_vault/export.py` (чистые, над `CheckpointInfo`),
**дедуп при мерже**: команда той ветки должна звать `checkpoint_files()`
отсюда. На этой ветке `AuditCheckpoint` без полей ADR-135 —
`checkpoint_covering` читает `alg/host_id/tsa_status/timestamps` через
`getattr` с честными значениями (`fake`, пусто): без `.tsr` файлов меток
в пакете нет, README пакета говорит об этом прямо.

### 4. Асинхронная сборка, идемпотентность (ADR-137 треб. 10)

`POST /contracts/{id}/archive/export` (`Idempotency-Key` обязателен) →
`request_export`: строка `ArchiveExport(status=queued, snapshot_at=now)`,
событие `archive.export_requested`, Celery-задача
`apps.archive.tasks.build_archive_export` — **после коммита**
(`transaction.on_commit`). Ни байта zip в запросе. Идущая сборка с теми же
опциями → тот же export (и без ключа). Задача: `build_export` — сборка,
шифрование, put, ссылки, выдача, `archive.ready`; исключение → `failed`
+ ретрай (3×, `ARCHIVE_BUILD_RETRY_SECONDS`). Потеря задачи брокером до
старта — beat `requeue_stale_exports` (10 мин, `queued` без `started_at`
старше `ARCHIVE_STALE_QUEUED_MINUTES`). Это страховка задачи, не доменный
дедлайн (тех здесь нет: сборка — не юрсрок).

Опции DEV-12: `include_originals` ↔ `manifest_only` взаимоисключающие
(422 `archive_options_conflict`); `manifest_only` → `files.zip` не
собирается (`files_state=not_requested`); `include_originals=false` →
`files.zip` только с миниатюрами. Черновик без единой заморозки — 409
`archive_nothing_to_export` (`can_export=false`). `is_snapshot` —
сделка не окончена (`execution_status` вне completed/warranty/closed/
terminated_*).

### 5. Шифрование артефактов — тем же конвертом, разными субъектами

Оба zip в бакете — **шифротекст** `common.crypto.encrypt_bytes_for_subject`
(ADR-059/136). Иначе рядом с зашифрованными оригиналами лежал бы открытый
zip тех же фотографий, обнуляя и шифрование at rest, и crypto-shredding.
Субъекты разные — `("archive_package", export_id)` (ключ живёт бессрочно,
как сам пакет) и `("archive_files", export_id)` (уничтожается по сроку).
Следствие: **presigned-ссылок нет** (объект нечитаем без ключа) — выдача
стримом через приложение с расшифровкой в `GET /a/<token>`; для
килобайтного пакета и мегабайтных файлов это укладывается в ограничения
Cloudflare (таймаут — на первые байты ответа, не на длительность
скачивания). Хранилище `apps/archive/storage.py` — **не WORM**: `files.zip`
обязан физически удаляться (треб. 7 — аудит фактического удаления),
неизменяемость доказательства держат хеши `package_sha256`/`files_sha256`
в строке и событие `archive.ready` в Vault. Бакет `ARCHIVE_BUCKET_NAME`
(прод — отдельный бакет R2 без Bucket Lock), ключи
`archive/<contract_id>/<export_id>/package.zip|files.zip`. TTL объекта —
не lifecycle-правилом, а подписчиком на `evidence.shredded` (иначе
удаление было бы недоказуемо — треб. 7).

### 6. Выдача обеим сторонам (ADR-137 треб. 1–2)

Подписчик `apps.archive.handlers.handle_contract_ended` на
`contract.completed` / `contract.terminated` / `contract.auto_closed`
(ADR-138, строка топика) / `contract.closed` (фолбэк) →
`request_auto_export` (один автоэкспорт на договор, `trigger=auto`,
`include_originals=true`). После готовности `deliver_export` для КАЖДОЙ
стороны: две ссылки (`package`, `files`) и `place_notification(
template="archive.ready", legal_significance=True, force_email=True,
email_attachments=[package.zip])`.

**Решение (владелец 26.08 склонялся к нему — принято): письмо с пакетом
— юрзначимое и уходит независимо от пользовательской настройки e-mail и
групп-каналов.** У новых пользователей e-mail выключен по умолчанию (0015,
25.08) — иначе схема «копия у каждой стороны» не сработала бы ровно у тех,
кто ничего не настраивал. Реализация — новый параметр `force_email` в
`place_notification` (+ `email_attachments`; `ResendEmailProvider` шлёт
`attachments[{filename, content}]`). Нет адреса — только ЛК (юрканал) +
`DeliveryAttempt(email, no_email)`, чтобы факт был виден. Пакет вкладывается
при размере ≤ `ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES` (20 МБ; треб. 2
«заведомо ниже 20 МБ»), крупнее — только ссылка (`package_attached=false`
в payload). `archive.ready` НЕ в реестрах топиков (как `contract.completed`):
получатели и вложение известны только сервису.

Отдельного шаблона `archive.link_revoked` нет (минимум ADR: `archive.ready`);
события `archive.export_requested/ready/link_accessed/link_revoked/
files_shredded` уходят в Vault глобальным подписчиком.

### 7. Долгоживущие ссылки `/a/<token>` (ADR-137 «Долгоживущие ссылки»)

`ArchiveLink`: `secrets.token_urlsafe(32)` (256 бит ≥ 128), в БД — `sha256`
токена (unique) + **шифротекст токена** (субъект `("archive_link", id)`):
фронт открывает скачивание `window.open(url)` без `Authorization`, поэтому
API стороны обязан уметь показать её собственный URL повторно; отзыв =
`revoked_at` + уничтожение ключа токена (показать нельзя, найти по хешу —
можно, ответ 410). Ручка `GET /a/<token>` — в **корне** сайта, не под
`/v1` (письмо ведёт на неё; nginx `location /a/` → core), без
авторизации, `Cache-Control: private, no-store` на КАЖДОМ ответе (треб.
11), рейт-лимит по адресу (`ARCHIVE_LINK_RATE_LIMIT`/`…_WINDOW_SECONDS`,
429 + `Retry-After`; тот же приём, что лимит загрузок), лог обращений —
`archive.link_accessed` в outbox → Vault (без IP/UA: Vault бессрочен, ПД
туда не пишем; счётчик и `last_access_at` — на строке). Отзыв —
`POST /v1/archive/links/{id}/revoke` любой стороной договора (письмо могло
утечь у любой из них).

**Примечание 03.09: denylist service worker'а.** Ссылка `/a/<token>` живёт в
КОРНЕ того же origin, что и SPA, — и этим попала под навигационный fallback
PWA (`workbox`: `navigateFallback: '/index.html'`). Денилист знал только
`/^\/v1\//`, поэтому service worker перехватывал вставленный в адресную
строку `https://porukam.app/a/<token>` и отдавал оболочку из precache: запрос
НЕ ДОХОДИЛ ни до nginx, ни до core (по логам прода — ни одного `/a/`-запроса
за 48 часов, при том что человек пробовал; работала только кнопка «Скачать»,
потому что `<a download>` для SW не навигация). Отсюда правило: **любой путь,
который nginx проксирует в бэкенд, обязан быть в denylist'е SW** — список и
разбор в `web/src/features/pwa/navigateFallbackDenylist.ts`, сторожа —
`web/tests/navigateFallbackDenylist.test.ts` и e2e
`web/tests/e2e/pwa/archive-link.spec.ts`. Побочные следствия, которые важно
помнить при следующем таком адресе: `registerType: 'prompt'` — исправленный
SW доезжает до человека только после его согласия («Обновить» в тосте или
Ctrl+Shift+R), поэтому в SPA оставлен маршрут-страховка `/a/*`
(`web/src/pages/ArchiveLinkPage.tsx`): он снимает регистрацию SW и повторяет
переход с меткой `?swbypass=1`. В UI сама ссылка обязана быть кликабельной
`<a href download>` (до 03.09 адрес выводился текстом в `<code>` рядом с
кнопкой «копировать» — единственным способом ей воспользоваться было
копирование).

**Ссылка живёт дольше данных**: после shred `GET /a/<token>` на файлы →
**410** `archive_files_shredded` с `shredded_at`, `files_sha256`,
`package_url` (ссылка той же стороны на пакет), `package_sha256`,
`sha256sums` (текст SHA256SUMS целиком) и `retention_policy_url`; JSON
(problem+json) либо HTML-страница по `Accept: text/html`. Для этого
`manifest`/`sha256sums` дублируются в `ArchiveExport` (килобайты) —
отвечать можно и при недоступном бакете. Ссылка на пакет — 200 всегда.
Формулировка «согласно п. N оферты» — пункт оферты ещё не пронумерован
(ADR-137 шаг 13, юрист) — в тексте сейчас «политика хранения (оферта,
п. о сроках хранения; ADR-137)».

### 8. RetentionTimer → экспорт

`evidence.shredded` (ADR-136) → `apps.archive.handlers.handle_evidence_
shredded` → `shred_export_files`: у всех экспортов договора с
`files_state=available` — `destroy_subject_key("archive_files", id)`,
`store.delete(files_key)`, `files_state=shredded`, `files_shredded_at`,
строка лога + событие `archive.files_shredded` (треб. 7). `package.zip`,
`package_sha256`, `files_sha256`, манифест и SHA256SUMS — не трогаются.
`evidence.archived` реакции не требует (состояние читается в манифест на
лету). `files_expires_at` = `archive_until` таймера (None у снимка по
идущей сделке).

## Контракт API (для фронта, DEV-12)

- `GET /v1/contracts/{id}/archive` → `ArchivePreview` + `retention` +
  `exports[]` (последние сверху). `format = {pdf:false, zip:true, html:true}`,
  `drive_backup="off"` (BYO Drive в состав пакета не входит).
- `POST /v1/contracts/{id}/archive/export` `{include_originals?, manifest_only?}`,
  заголовок `Idempotency-Key` → `202 {export_id, jobId, status:"queued"}`.
- `GET /v1/contracts/{id}/archive/export/{export_id}` → `ExportJob`:
  `status` **queued|running|ready|failed** (фронт: queued/running → pending,
  failed → error), `progress` 0/50/100, `package{url,size_bytes,sha256,
  state}`, `zip{…, state: pending|available|shredded, expires_at,
  shredded_at}` (files.zip), `pdf: null`, `links[]` (у чужой стороны
  `url=null`), `error`.
- `POST /v1/archive/links/{id}/revoke` → ссылка.
- `GET /a/<token>` → `200 application/zip` (`Content-Disposition`,
  `X-Content-Sha256`) | 404 | 409 `archive_export_not_ready` | 410
  `archive_link_revoked` | 410 `archive_files_shredded` | 429.

## Что заглушкой / что позже

| Что | Состояние | Когда |
|---|---|---|
| PDF-оглавление | `index.html` вместо PDF | когда появится WeasyPrint в lock (PyPI) |
| Merkle-коммитмент чекпойнта (полный офлайн-путь) | линейный путь, чужие звенья хешем | решение владельца; формат v3 в `feat/audit-vault-tsa` |
| `.tsr`/`chain.pem` в пакете | код есть, на этой ветке чекпойнт фейковый | после мержа `feat/audit-vault-tsa` (дедуп `export.py`) |
| Гео из манифеста DeviceKey | не расшифровывается (`has_geo` только) | вместе с Э10 и решением о выдаче адреса заказчика |
| Стрим больших `files.zip` | целиком в памяти воркера/ответа | при первых сделках с сотнями МБ — chunked-расшифровка |
| GDPR-удаление `package.zip` по запросу | только ключ-субъект `archive_package` | юрист (ADR-137 оговорка) |

## Уведомления (реестры ADR-126)

`archive.ready` — прямой вызов (не реестр), `legal_significance=True`,
`force_email=True`, вложение; тип ленты `archive_ready` → группа `deals`
(тип существовал в проекции с DEV-14). Строка `NotificationTemplate` —
`notifications/0025`; тексты — 29 пакетов (`l10n/patches/adr-139-archive.json`,
ru/en вручную, остальные машинно; `pack_version` +1 у всех, `packs.lock.json`).

## Последствия и хвосты

- Миграции: `archive/0001`, `notifications/0025`. Другие ветки поднимают
  `pack_version` и номера миграций notifications — при мерже перенумеровать.
- Новые env: `ARCHIVE_OBJECT_STORE`, `ARCHIVE_BUCKET_NAME`,
  `ARCHIVE_EMAIL_ATTACHMENT_MAX_BYTES`, `ARCHIVE_LINK_BASE_URL`,
  `ARCHIVE_LINK_RATE_LIMIT`, `ARCHIVE_LINK_RATE_WINDOW_SECONDS`
  (+ `ARCHIVE_CHAIN_PATH_MAX_LINKS`, `ARCHIVE_BUILD_RETRY_SECONDS`,
  `ARCHIVE_STALE_QUEUED_MINUTES`); прод — `ARCHIVE_OBJECT_STORE=s3`,
  отдельный бакет R2 без Bucket Lock; nginx `location /a/`.
- `place_notification` получил `force_email`/`email_attachments`;
  `ResendEmailProvider` — вложения. Поведение остальных вызовов не
  изменилось (по умолчанию `False`/`None`).
- `apps.audit.client` расширен read-фасадами Vault для inclusion-proof;
  `services/audit_vault/export.py` — кандидат на дедуп с
  `verify_checkpoint_timestamps` при мерже TSA-ветки.
- Тексты 27 языков — машинные, требуют ревью носителем (как ADR-095).
