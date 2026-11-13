# ADR-075. Допники: nullable `amendment` рядом с `contract`, partial-индексы вместо простого UniqueConstraint, дуальная развилка вместо новых эндпоинтов

**Статус:** принято
**Дата:** 2026-08-06
**Контекст этапа:** Э4.5 (docs/tasks/etap-4.md) — допники (Amendment).

## Контекст

После подписания (Э4.4) `Contract` неизменяем — изменения только через `Amendment`,
самостоятельный документ, проходящий ТОТ ЖЕ путь согласования/заморозки/подписания, что и
сам договор. Постановка явно требует: «Общая FSM согласования/подписания из Э4.2/Э4.4
переиспользуется, не дублируется». Нужно было решить, КАК технически подключить Amendment
к уже смёрженным, покрытым тестами таблицам `RevisionProposal`/`SignatureRequest`/`Signature`/
`ContractVersion`, которые сегодня имеют NOT NULL FK только на `Contract`.

## Решения

### 1. `amendment_id FK NULL` — рядом с `contract_id`, не вместо него

tech-spec.md §5.2.4 сама описывает эту схему: `signature_request(id, contract_id FK,
amendment_id FK NULL, ...)`, `signature(id, contract_id FK, amendment_id FK NULL, ...,
UNIQUE (contract_id, amendment_id, side, version_hash))`. `contract_id` остаётся NOT NULL
всегда (сторона его знает безусловно, даже когда запрос про допник) — `amendment_id` NULL
означает «раунд самого договора», не-NULL — «раунд конкретного допника». Это добавлено на
`SignatureRequest`/`Signature`; `RevisionProposal`/`PreapprovedAlternative` — НЕ получили
`amendment` FK (см. п. 4).

`ContractVersion` НЕ получила `amendment_id` — версия допника пишется в ТУ ЖЕ таблицу
(`contract=amendment.contract`), просто со снимком меньшего размера; `Amendment.frozen_version`
указывает на конкретную строку.

### 2. Partial-индексы вместо простого `UniqueConstraint`

Был `UniqueConstraint(fields=["contract", "side"], name="signature_one_per_side")`. Просто
добавить `amendment` в состав того же констрейнта (`UniqueConstraint(contract, amendment,
side)`) НЕЛЬЗЯ: в Postgres `NULL ≠ NULL` для уникальности — при `amendment=NULL` у всех
договорных строк уникальность контракт+сторона перестала бы ловить дубли. Решение — два
partial-индекса:

```python
models.UniqueConstraint(
    fields=["contract", "side"], condition=Q(amendment__isnull=True),
    name="signature_one_per_side_contract",
)
models.UniqueConstraint(
    fields=["amendment", "side"], condition=Q(amendment__isnull=False),
    name="signature_one_per_side_amendment",
)
```

### 3. Точечная правка Э4.4-функций, а не их дублирование

`route_signatory`/`sign`/`decline_for_revision` (Э4.4, `apps/contracts/services.py`) читают
`contract.signature_requests`/`contract.signatures` — реверс-связь ТЕПЕРЬ содержит и
договорные, и допник-строки (обе указывают на тот же `contract_id`). Добавлен
`amendment__isnull=True` в их фильтры — без этого «уже есть pending-запрос» и «обе стороны
подписали» ошибочно учитывали бы раунд допника. Изменение точечное (несколько `.filter(...)`),
не рефакторинг: существующие Э4.4-тесты остаются зелёными без изменений (amendment всегда
NULL в их сценариях).

### 4. Amendment-специфичные функции — структурно параллельны, не переиспользуют тела Э4.4

`freeze_amendment`/`route_amendment_signatory`/`sign_amendment`/
`forward_amendment_signature_request`/`decline_amendment_for_revision`/
`expire_amendment_signature_request` — НОВЫЕ функции, а не параметризация существующих.
Django-модели (`Contract`/`Amendment`) не дают общего интерфейса без риска для уже
смёрженного, ревьюженного Э4.4-кода, а его трогать в рамках этой ветки нежелательно. Что
ДЕЙСТВИТЕЛЬНО переиспользуется буквально (тот же объект/та же функция, не копия):
`NEGOTIATION_FSM` (один `StateMachine`, тест
`test_amendment_reuses_the_exact_same_fsm_object_as_contract` проверяет тождество объекта,
не совпадение графов), `get_party_for_user`/`is_party`/`list_signatories` (вызываются с
`amendment.contract` без единой правки), все исключения подписания (`StaleVersionError` и
т.д. — `_SERVICE_ERROR_STATUS` не получил новых записей под sign/forward/decline),
`common.canonical`/`common.timestamps`/`common.api.idempotency`/`apps.deadlines.services.
create_deadline`/`apps.notifications.services.place_notification`.

Протокол разногласий (`RevisionProposal`) на допниках — явно ВНЕ объёма (etap-4.md Э4.5 его
не упоминает, приёмка не тестирует) — сеам, `amendment` FK на эту модель не заведён.

### 5. Дуальная развилка в существующих вьюхах вместо новых эндпоинтов

`POST /signature-requests/{id}/{sign,forward,decline}` и `GET /signature-requests/{id}` — ТЕ
ЖЕ URL и view-классы для договора и допника: `if sig_request.amendment_id: services.sign_
amendment(...) else: services.sign(...)`. Развилка — одна строка на метод; `_call_service`/
`_idempotent_call`/`_SERVICE_ERROR_STATUS`/`_get_signature_request_as_party` не изменились
(последняя уже проверяла `sig_request.contract`, который у допника тоже всегда установлен).
Отдельные новые эндпоинты появились только там, где ресурс реально другой:
`/contracts/{id}/amendments`, `/amendments/{id}/{send,freeze,signatories,signature-requests,
timeline}`, `/contracts/{id}/effective-terms`.

### 6. `AmendmentChange.amount_delta`/`days_delta` — считаются сервером, не принимаются от клиента

tech-spec.md §8.6 приводит пример тела запроса с явным `amount_delta` от клиента. В этой
ветке — иначе: `apps.contracts.services._create_amendment_change` вычисляет дельту сама
(из `payload`/цели), чтобы значение, показанное в карточке допника, ГАРАНТИРОВАННО совпадало
с тем, что реально применится к дереву на `apply_amendment` — не два независимых источника
истины. `compute_amendment_deltas(amendment)` — общая точка для canonical-снимка
(`_build_amendment_snapshot`) и `GET /amendments/{id}` (сериалайзер), не дублируется.

### 7. `effective_terms` — плоская склейка, не структурный дифф дерева

`Contract.effective_terms()` в domain-model.md §9 (`apply_amendment_terms(terms, amendment)`)
подразумевает содержательное слияние снимков. В этой ветке `effective_terms(contract)` —
`{**contract.frozen_version.snapshot, "amendments": [...], "total_amount": <живая сумма
из total_leaf_amount>}`: текущее состояние дерева этапов уже является источником истины
структуры (Milestone-таблица), функция не пытается её продублировать диффом снимков.

## Последствия

- `remove_milestone` допника ограничен ЛИСТЬЯМИ (`AmendmentRemoveTargetNotLeafError`) — частичное
  удаление поддерева допником не специфицировано ни постановкой, ни спекой, оставлено вне
  объёма.
- Гейты «нельзя удешевить/убрать принятое» и «нельзя убрать полученный материал» проверяются
  на СОЗДАНИИ допника (`create_amendment`/`_create_amendment_change`), не повторно на
  заморозке/подписании — в этой ветке ничто не может изменить `accepted_at`/`received` между
  созданием и применением (исполнение — Э4.6, ещё не начато).
- Доначисление/возврат комиссии по дельте, `additional_hold` при `hold`-способе (domain-model.md
  §9 `apply_amendment`) — НЕ реализованы (финмодель v2, доп. решение по объёму уже принято в
  Э4.1-Э4.4).

## Дополнение 26.08 (`feat/contracts-amendment-reject`): отзыв и отклонение допника

**Контекст.** `NEGOTIATION_FSM` — один объект на договор и допник, и переходы
`withdraw`/`reject` (ADR-124: из `under_review`, `pending_signature`,
`awaiting_signatures`) в нём были с самого начала. Но use case и эндпоинты
существовали только для договора: у допника из `under_review`/`pending_signature`
единственным выходом была подпись. ADR-131 зафиксировал следствие как хвост —
«отклонённое предложение скидки оставляет допник в `under_review` неподписанным».

**Решение.**

1. `withdraw_amendment` / `reject_amendment` — зеркала `withdraw_negotiation` /
   `reject_negotiation` (п. 4 выше: структурно параллельны, ФСМ — тот же объект).
   `POST /amendments/{id}/withdraw` — только инициатор допника (`Amendment.created_by`,
   иначе 403 `not_initiator`); `POST /amendments/{id}/reject` — только вторая сторона
   (инициатор → 403 `not_counterparty`). Оба — из всех трёх состояний, объявленных FSM;
   из заморозки — с аннулированием раунда подписания ДОПНИКА
   (`_annul_amendment_signing_round`: pending-запросы → `declined_for_revision`, подписи
   допника удаляются, `frozen_version` снимается; договорный раунд не трогается, снимок
   `ContractVersion` остаётся — append-only). Из `signed`, `withdrawn_by_initiator`,
   `rejected_by_counterparty`, `draft` перехода нет → 409 `invalid_negotiation_transition`
   (подписанный допник неизменяем; повторный вызов — тот же 409). Чужак — 403
   `permission_denied`. Тело `{reason?}` уходит в payload события и в хронику допника
   (`GET /amendments/{id}/timeline`, subject `amendment`).
2. `return-for-revision` для допника НЕ заведён: переход возвращает в `under_review`, а
   не в `draft`, и PATCH допника в Р1 нет (п. 4: «список неизменяем после создания») —
   вернуть «на доработку» нечего. Для этого случая есть `decline_amendment_for_revision`
   (адресат заявки) и теперь `withdraw` + новый допник.
3. **Скидка по спору (ADR-131).** `apps.contracts` про `apps.disputes` не знает
   (import-linter), поэтому события `amendment.rejected`/`amendment.withdrawn`
   (subject — допник, payload `contract_id`, `reason`, аннулированные id) слушает
   `apps.disputes.handlers.handle_amendment_closed`: по `DiscountAgreement.amendment`
   находит предложение в `proposed`, помечает `declined` и возвращает спор из
   `awaiting_discount` в `open` тем же переходом `decline_discount`
   (`services.cancel_discount_by_amendment`). Спор публикует `dispute.discount_cancelled`
   (с `cause=rejected|withdrawn`) — топик **не** маппится в реестры уведомлений: о самом
   действии уже уведомляют `amendment.rejected`/`amendment.withdrawn`, второе уведомление
   о том же моменте было бы дублем (ADR-126 §4). Обычный допник и уже решённое предложение
   — NOOP (идемпотентность реле, ADR-064). Обратное направление (прямой
   `decline_discount` → допник) по-прежнему оставляет допник в `under_review`; теперь его
   можно отозвать/отклонить руками — автоматический отзыв не делается, чтобы не рождать два
   уведомления на одно действие. *Пересмотрено тем же днём* (решение владельца в6-6,
   дополнение 26.08 к ADR-131): `decline_discount` закрывает допник сам через
   `reject_amendment(..., cause="discount_declined")`, а дубль уведомления глушится по
   `cause` в реестрах — второго уведомления по-прежнему нет.
4. **Уведомления.** `amendment.rejected`, `amendment.withdrawn` — обеим сторонам, тексты
   нейтральны («Допсоглашение к договору «…» отклонено второй стороной / отозвано
   инициатором»), один код на оба реестра (правило ADR-126 §2), `legal_significance=True`
   (как `negotiation.rejected`/`withdrawn`). Лента: тип `negotiation`, `action.href` —
   `/contracts/{contract_id}` (общая проекция ленты; отдельного href на допник у ленты
   нет). `NotificationTemplate` — миграция `notifications/0019`, тексты — во все 29 пакетов
   (`l10n/patches/adr-075-amendment-closed.json`, `pack_version` +1, lock обновлён).
5. `SignatureRequestSerializer.signed_at` — момент подписи по запросу (из `Signature`
   того же раунда: contract + amendment + side), `null` до подписи и после аннулирования
   раунда; экран допника показывает время чужой подписи.
