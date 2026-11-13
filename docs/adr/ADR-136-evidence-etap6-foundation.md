# ADR-136. Этап 6 «Доказательства», фундамент: поля манифеста, шифрование оригиналов, WORM-режим, RetentionTimer, окно 72 ч

- Статус: принято
- Дата: 2026-08-26
- Ветка: `feat/evidence`
- Связано с: ADR-036 (хеши бессрочно, файлы по сроку, экспорт-пакет),
  ADR-045 (EXIF/гео = адрес заказчика), ADR-053 (делегированная съёмка,
  DeviceKey, окно выгрузки 72 ч), ADR-059 (envelope-шифрование ПД,
  crypto-shredding), ADR-064 (outbox, at-least-once), ADR-072 (свип доменных
  дедлайнов), ADR-084 (BYO-бэкап), ADR-125 (миниатюра), ADR-126 (матрица
  уведомлений), ADR-135 (TSA на корень суточного чекпойнта — делает
  `feat/audit-vault-tsa`), **ADR-137 (сроки хранения — решение владельца,
  этот ADR им управляется)**; разбор — `docs/tasks/etap6-evidence-decision.md`

## Контекст

Э6 закрывает один вопрос: как доказать, что файл существовал в момент T,
снят конкретным человеком и с тех пор не менялся — не полагаясь на слово
платформы. К 26.08 была ровно половина (веб-загрузка ГВ.3): sha256
очищенных байт, серверная метка, миниатюра, EXIF-очистка, релей
контрагенту, `verify`. Не было: полей манифеста §5.2.8, неизменяемости
хранения, шифрования оригиналов, сроков хранения, окна 72 ч, проверки
DeviceKey/назначения, дедупа по хешу.

Решения владельца 26.08 (docs/backlog.md «Комментарии пользователя»):
S3 на проде — **Cloudflare R2**; TSA — ADR-135 (другая ветка); экспорт-пакет
— без спешки, НЕ в этой задаче; сроки — **ADR-137** (3 мес горячее → до
**1 года** архив → хеши бессрочно; пауза на спор с пределом 6 мес; запись
сделки не удаляется; аудит удаления; публичная политика при создании
сделки); DeviceKey-контур переезжает в Э10 (серверную половину — сейчас,
включение — флагом); **оригиналы хранятся на сервере во всех
юрисдикциях** (отмена GLOBAL-исключения ГВ.3, см. §9).

Главный инженерный принцип волны: **то, что требует миграции и не
заполняется задним числом, — сейчас** (поля манифеста, решение о
шифровании, режим неизменяемости); **то, что подключается заменой
провайдера/флага, — позже** (TSA, подпись с телефона, экспорт).

## Решение

### 1. Поля манифеста в `Evidence` (миграция `evidence/0003`)

`device_key` (FK `accounts.DeviceKey`, PROTECT), `assignment` (FK
`authority.ContractAssignment`, PROTECT), `captured_at_device`,
`device_clock_skew_ms`, `geo_encrypted`/`geo_key_ref`, `device_signature`,
`tsa_token` (nullable; ADR-135 штампует корень чекпойнта, поле — под
обратную привязку), `lateness`, `is_evidence_role`, `retention_state`
(+`archived_at`/`shredded_at`), `encryption_key_ref`, индекс `file_hash`,
CHECK-констрейнты на enum'ы и «уничтоженный оригинал не имеет ни ключа
объекта, ни транзитной копии». PROTECT на ключ и назначение: это часть
доказательной базы («этот человек имел право быть на объекте, вот подпись
его устройства»), удалять их из-под доказательства нельзя.

**Гео хранится только шифротекстом.** По ADR-045 геометка доказательства =
адрес квартиры заказчика, то есть ПД. Не хранить нельзя — ADR-053 называет
гео одним из четырёх независимых доказательств («геометка → место»).
Компромисс: `common.crypto.encrypt_bytes_for_subject`, субъект
`("contract", contract_id)` (гео описывает объект договора и уничтожается
вместе с ПД договора); в API — только `has_geo`. Расшифровка наружу —
отдельным решением вместе с экспорт-пакетом.

**Существующие строки — по данным, а не по умолчанию:** `lateness=unknown`
(не `on_time` — время съёмки у веб-загрузок неизвестно),
`retention_state=hot`, `is_evidence_role=true`, `encryption_key_ref=""`.

**`lateness` получил четвёртое значение `unknown`.** Спека даёт три
(`in_window|late|after_acceptance`), но все три — утверждения о времени
съёмки, которого у веб-загрузки нет. Ставить `on_time` значило бы
подписывать платформой факт, который прислал бы сам клиент; «информация
вместо наказания» (ADR-019/053) требует честного «неизвестно». Фронт
показывает пометку «без усиленной доказательной защиты» именно по
`strong_protection=false`, а `lateness` — раздельно.

**Дедуп по хешу** — сигнал, не запрет: тот же `file_hash` в другом
договоре → событие `evidence.duplicate_hash` (в Audit Vault и будущему
анти-фроду) + `metadata.duplicate_hash=true`. Один снимок в двух сделках
бывает честным («до/после»), вес — людям.

### 2. Шифрование оригиналов at rest — конверт `common.crypto`

Тот же конверт, что для ПД (ADR-059), в байтовом варианте
(`encrypt_bytes_for_subject`/`decrypt_bytes_for_subject`, добавлены в
`common/crypto.py`): мастер-ключ из env (`ENVELOPE_MASTER_KEY`) → KEK
субъекта `SubjectKey("evidence", evidence.id)` в БД → per-object DEK →
AES-256-GCM. Обёрнутый DEK лежит В БЛОБЕ (в объекте бакета) — без KEK из
БД и мастер-ключа из env он бесполезен; на строке — только
`encryption_key_ref`.

**Конфликт WORM ↔ crypto-shredding и его решение.** WORM означает «удалить
нельзя до срока», CLAUDE.md — «ПД удаляются только уничтожением ключа».
Оригиналы в WORM-бакете лежат зашифрованными, поэтому удаление =
`destroy_subject_key("evidence", id)`: шифротекст физически остаётся до
истечения правила бакета, но нечитаем. Это же закрывает GDPR-erasure для
вложений (§9). `file_hash` — ВСЕГДА от очищенных открытых байт (то, что
получил контрагент), не от шифротекста; `verify` работает и после
уничтожения оригинала («хеши бессрочно», ADR-036/137).

Объекты, загруженные до ADR-136 открытыми байтами, читаются как есть
(`encryption_key_ref=""`) и перешифровываются management-командой
`evidence_encrypt_backfill` (идемпотентно, батчами, dry-run) — **не**
data-миграцией: терабайты в S3 не место транзакции `migrate`. Под WORM
старый объект перезаписать нельзя — шифротекст пишется под новым ключом
`evidence/<id>/enc/<file>`; `--delete-plaintext` допустим только в
`WORM_MODE=none`.

Попутно закрыт латентный дефект ГВ.3: `api/views` не передавали store в
сервисы, RU-загрузка в проде легла бы в фейк-память процесса. Теперь
тумблер `EVIDENCE_OBJECT_STORE=fake|s3` (как `PROFILE_AVATAR_STORE`) и
`build_evidence_object_store()` на каждый вызов.

### 3. WORM-режим — `common/worm.py`, один модуль на оба хранилища

`WORM_MODE=object_lock|bucket_lock|none` (env):

| Режим | Что делает код | Инфраструктура |
|---|---|---|
| `object_lock` | `put_object(..., ObjectLockMode=COMPLIANCE, ObjectLockRetainUntilDate)` — как Audit Vault с ЭФ.3 | бакет создан с локом (`mc mb --with-lock`; на существующем включить нельзя) |
| `bucket_lock` | обычный `put_object`; при старте процесса — предупреждение в лог с бакетом и префиксами | **Cloudflare R2**: правило Bucket Lock на бакет/префикс в дашборде, работает на существующем бакете; из кода не читается |
| `none` | обычный `put_object` | dev/тесты |

Почему абстракция, а не «всегда Object Lock»: R2 отвергает
`ObjectLockMode` в `put_object`, а прод — R2 (решение владельца). Оба
хранилища — `apps.evidence.storage.S3EvidenceObjectStore` и
`services.audit_vault.storage.S3CheckpointObjectStore` — зовут
`common.worm.put_worm_object` с режимом из настроек; тесты на все три
режима — фейковым boto3-клиентом (`common/tests/test_worm.py` + по тесту
на каждое хранилище). Опечатка в `WORM_MODE` — ошибка старта
(`UnknownWormModeError`), не тихий фолбэк в `none`. Шаги владельца в R2 —
`прод-конфиг` «Cloudflare R2: Bucket Lock»; на проде — ОТДЕЛЬНЫЙ
бакет `porukam-evidence`, правило 730 дней на весь бакет (год архива
ADR-137 + предел продления 6 мес + запас), включать **после** деплоя и
бэкфилла — под правилом ничего не перезаписать.

`EVIDENCE_WORM_RETENTION_DAYS` (только `object_lock`) — срок лока от
загрузки: дата окончания договора в момент загрузки неизвестна, а
досрочное «удаление» всё равно идёт ключом.

### 4. RetentionTimer (ADR-036 → ADR-137) — строки дедлайнов + свип

`RetentionTimer` — один на договор (OneToOne), стартует подписчиком outbox
по окончанию сделки: `contract.completed` (работы приняты и оплачены —
ADR-137: срок платформы **не привязан к гарантии сторон**, «платформа —
свидетель, не поручитель»), `contract.terminated`; `contract.closed` —
фолбэк (при живом таймере NOOP). Три `DomainDeadline` (`apps.deadlines`,
свип каждую минуту, НЕ Celery-задачи), хранятся по значению без FK (как
`DisputeWindow.deadline_id`):

| kind | по умолчанию | что происходит |
|---|---|---|
| `evidence_hot_retention` | 90 дн | все строки договора `hot → archived`, событие `evidence.archived` |
| `evidence_archive_retention` | 365 дн | `archived → shredded`: `destroy_subject_key` на каждый файл, `s3_object_key`/`transit_payload` обнуляются, строка/хеш/миниатюра/метаданные/`tsa_token` остаются; событие `evidence.shredded` со списком id + строка лога на файл (аудит фактического удаления, ADR-137 п.7) |
| `evidence_retention_notice` | 10 дн | **производный** дедлайн `archive − notice` («скачайте себе» обеим сторонам, ADR-137: только перед удалением — перевод в архив для сторон ничего не меняет) |

Плюс `evidence_upload_window` (72 ч, ADR-053; дедлайна не заводит — параметр
`lateness`) и `evidence_dispute_pause_cap` (180 дн). Все — ДАННЫЕ в
`DeadlineKindConfig` (`deadlines/0009`), владелец меняет без релиза; те же
значения отдаёт публичный `GET /v1/evidence/retention-policy` (ADR-137 п.9:
ограничение видно при создании сделки, а не только за 10 дней до конца).
Для производного дедлайна `create_deadline` получил явный `deadline_at`
(категория всё равно обязана быть в конфиге — её длительность и есть N).

**«Архив» в этой волне — только состояние строки + событие.** Физического
холодного тира нет (один бакет), скачивание работает как прежде; переход
нужен ради честной хроники и уведомления. Ледяной тир — когда появится
статистика по объёмам (ADR-137: объём не блокер).

**Пауза при открытом споре** — подписчиками, не импортом `apps.disputes`:
`dispute.opened` → пауза трёх дедлайнов; `dispute.resolved` → возобновление,
только если по договору не осталось открытых разногласий
(`disputes.selectors.has_open_disputes` — единственный импорт из disputes,
read-слой). Таймер, стартующий при уже открытом споре, сразу на паузе.
Возобновление **продлевает** срок на длительность паузы (иначе «пауза» с
истёкшим `deadline_at` сработала бы в первую же минуту), с **жёстким
пределом ADR-137 как проверкой** (`effective_deadline_at`):

```
deadline = max(anchored + duration, min(anchored + duration + paused_total, resumed_at + cap))
notice   = archive_deadline − notice
```

то есть срок никогда не короче базового обещания оферты и никогда не
дальше 6 месяцев после завершения спора. Следствие: спор на третьем
месяце продления не даёт (остаток и так больше 6 мес), спор на
одиннадцатом — даёт ровно длительность спора. Потолок спора 30 дней
(ADR-020) плюс этот предел ограничивают срок сверху при любой истории.

Идемпотентность (ADR-064): старт — OneToOne; свип — `deadline_id` события
сверяется с id в таймере (чужой дедлайн той же категории игнорируется),
переходы — по `timer.state`; уведомление — `Notification.source_event_id`.

### 5. Окно 72 ч / `lateness` (ADR-053)

`compute_lateness(captured_at_device, received_at, milestone_status,
window)` — чистая функция, property-based тест. Приоритет:
`after_acceptance` (этап `accepted|paid|disputed` на момент загрузки —
независимо от времени съёмки: приёмка закрыта, материал только в архив
спора, на состоявшуюся автоприёмку не влияет; загрузка НЕ отклоняется) →
`unknown` (нет времени съёмки) → `on_time|late` по окну. Отдаётся в
сериализаторе; `late` — пометка, не санкция.

### 6. Серверная половина DeviceKey/ContractAssignment — за флагом

`services.verify_device_manifest`: разбор манифеста
(`apps/evidence/manifest.py`, чистые функции), ключ ЭТОГО пользователя, не
отозванный на момент съёмки (отзыв позже съёмки материал не аннулирует —
снепшот полномочий ADR-005/053), подпись над канонической формой (JSON,
sort_keys, без пробелов, ASCII — как `audit_vault/canonical.py`;
алгоритмы `ed25519` и `ecdsa_p256`), `sha256` манифеста = хеш ПОЛУЧЕННЫХ
байт (телефон подписывает то, что снял; EXIF-очистка ADR-045 идёт после,
сырой хеш остаётся в `metadata.manifest_sha256` рядом с очищенным
`file_hash`), договор/этап манифеста = цель загрузки, назначение (если
указано) действовало в момент съёмки — фасад
`apps.authority.services.assignment_valid_at` (договор, сам представитель с
`upload_evidence`, интервал действия, отзыв, сужение до этапов).

`EVIDENCE_DEVICE_MANIFEST_ENABLED=false`: манифест в загрузке → `409
device_manifest_disabled`. Подписывать некому до Р1-мобайл (Э10) — включение
одной переменной.

**`POST /evidence/batches` не заведён.** Манифест + подпись принимаются
ТЕМ ЖЕ upload'ом (`manifest` JSON-строкой, `signature` base64 в
multipart) по одному файлу — это дёшево и покрыто тестами; batch-приём с
ответом «по каждому элементу» и очисткой локальных копий — контракт
мобильного клиента, его форма решится в Э10 вместе с самим клиентом.

### 7. `strong_protection`

`EvidenceSerializer.strong_protection = device_key ∧ device_signature` —
отсутствие пометки «без усиленной доказательной защиты» (tech-spec.md §1.3,
§14 п.17). Веб-загрузка — всегда `false`, фронт показывает пометку.
Остальные новые поля сериализатора: `device_key_id`, `assignment_id`,
`captured_at_device`, `device_clock_skew_ms`, `has_geo`, `has_tsa_token`,
`lateness`, `is_evidence_role`, `encrypted_at_rest`, `retention_state`,
`archived_at`, `shredded_at`, `original_available`.

### 8. Границы приложений

| Событие | Подписчик | Зачем |
|---|---|---|
| `contract.completed` / `contract.terminated` / `contract.closed` | `evidence.handlers.handle_contract_ended` | старт RetentionTimer |
| `dispute.opened` | `evidence.handlers.handle_dispute_opened` | пауза |
| `dispute.resolved` | `evidence.handlers.handle_dispute_resolved` | возобновление (последний спор) |
| `domain_deadline.fired` (`kind=evidence_*`) | `evidence.handlers.handle_deadline_fired` | уведомление / архив / уничтожение ключей |

Новые события apps.evidence: `evidence.retention_started`,
`evidence.retention_expiring`, `evidence.archived`, `evidence.shredded`,
`evidence.duplicate_hash`. Импорты: `apps.deadlines` — services/selectors
(+ новые `get_kind_duration`, `shift_deadline`, `create_deadline(deadline_at=)`),
`apps.authority` — фасад, `apps.disputes` — только selectors. import-linter
чист.

### 9. Отмена части ГВ.3: оригиналы на сервере во всех юрисдикциях

ГВ.3 (docs/tasks/global-wave.md п.1, `jurisdictions/0008`) выключил
серверное хранение для GLOBAL: «хеш у платформы, оригиналы у сторон»,
`transit_payload` удалялся после доставки. На проде это означало, что
GLOBAL-контур оригиналы не хранит вовсе — а ADR-137 требует хранение 3 мес
+ до года и выдачу архива обеим сторонам («доказательство нужно не тому, у
кого оно лежит»). Решение владельца 26.08: **оригиналы хранятся на сервере
во ВСЕХ контурах** (`jurisdictions/0009`: `evidence_server_storage_enabled
=True` везде). GDPR-аргумент ГВ.3 закрывается тремя механизмами этого ADR:
шифрование at rest (per-object DEK), сроки хранения (ADR-137) и
crypto-shredding (удаление = уничтожение ключа, включая удаление по запросу
— хеш/`tsa_token`/цепочки при этом не трогаются, ADR-137 п.6).

Реализация: новый `storage_mode=server` для новых загрузок всех контуров
(`ru` у старых строк читается тем же путём); `transit_payload` для
хранения больше не используется, поле оставлено ради чтения старых
GLOBAL-строк; флаг контура и GLOBAL-путь кода оставлены ради обратимости и
покрыты тестами при явно выключенном флаге. На проде — отдельный бакет R2
`porukam-evidence` (`прод-конфиг`, README).

## Что заглушкой / что позже

| Что | Состояние | Когда |
|---|---|---|
| TSA на корень чекпойнта | ADR-135, `feat/audit-vault-tsa` | параллельная ветка; `tsa_token` на строке — под обратную привязку |
| Подпись DeviceKey с телефона, `POST /evidence/batches` | серверная половина есть, флаг выключен | Э10 (Р1-мобайл) |
| Экспорт-пакет (PDF + ZIP + манифест хешей), выдача архива обеим сторонам, ручка `/a/<token>` | нет | отдельная задача (ADR-137 шаги 1–6, «без спешки») |
| Физический холодный тир | нет — `archived` только состояние | по статистике объёмов |
| Расшифровка гео наружу | нет — только `has_geo` | вместе с экспорт-пакетом |
| `GET /contracts/{id}/retention` | нет — есть публичный `GET /evidence/retention-policy` и события | с фронтом хроники |
| Автозакрытие сделок без движения (ADR-137 п.8) | другой агент, `apps.contracts` | evidence реагирует на `contract.completed` как на любое окончание |
| `POST /contracts/{id}/evidence` (документы, `is_evidence_role=false`) | поле есть, эндпоинта нет | по запросу |

## Уведомления (реестры ADR-126)

Три системных топика, actor пуст → ОБЕИМ сторонам через
`NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES`: `evidence.retention_expiring`
(формулировка обещания — ADR-137: «Подлинность ваших документов мы
подтверждаем бессрочно. Сами файлы храним год — дальше они ваши»),
`evidence.archived`, `evidence.shredded`. `legal_significance=true`.
Строки `NotificationTemplate` — `notifications/0024`, тексты — во всех 29
пакетах (`l10n/patches/adr-136-evidence-retention.json`, `pack_version` +1,
`packs.lock.json`). Типы ленты — существующие (`deadline`, `stage_submitted`).

## Последствия и хвосты

- Миграции: `evidence/0003`, `jurisdictions/0009`, `deadlines/0009`,
  `notifications/0024`. Другие ветки тоже поднимают `pack_version` и номера
  миграций notifications — конфликт разрешается при мерже.
- Новые env: `EVIDENCE_OBJECT_STORE`, `WORM_MODE`,
  `EVIDENCE_WORM_RETENTION_DAYS`, `EVIDENCE_DEVICE_MANIFEST_ENABLED`,
  `EVIDENCE_RETENTION_POLICY_CACHE_SECONDS`; прод —
  `EVIDENCE_BUCKET_NAME=porukam-evidence`, `WORM_MODE=bucket_lock`.
- Уведомление `evidence_received` контрагенту не изменилось; `lateness` и
  `strong_protection` добавлены в payload `evidence.received` (Audit Vault).
- `file_size` при уничтожении НЕ обнуляется (в отличие от формулировки
  задачи): размер, как и хеш, — факт об оригинале без ПД, нужен для сверки;
  спека §5.2.8 обнуляет только ключ объекта.
- GDPR-erasure по запросу пользователя для доказательств отдельным
  контуром не реализован; путь тот же, что у срока: `destroy_subject_key`
  на файл, строка/хеш/`tsa_token` остаются (ADR-137 п.6) — юрист
  подтверждает позицию по хешам до публичного запуска (оговорка ADR-137).
