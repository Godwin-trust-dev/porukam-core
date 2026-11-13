# ADR-073. Заморозка и подписание договора: canonical-хеш, адресация подписи по version_hash, аннуляция при reopen

**Статус:** принято
**Дата:** 2026-08-06
**Контекст этапа:** Э4.4 (docs/tasks/etap-4.md) — заморозка и подписание, самая
ответственная подзадача этапа Э4.

## Контекст

Договор после согласования (Э4.2) и построения дерева этапов (Э4.3) нужно
заморозить в неизменяемую версию (`ContractVersion`) и провести двустороннее
подписание с юридической значимостью. Требуется: детерминированная
сериализация снимка для хеширования (тест «одинаковый договор → одинаковый
hash»), способ адресовать подпись строго к конкретной версии («подписать не
то» физически невозможно), и понятная семантика того, что происходит при
правке после заморозки.

Отдельно — зависимость `GET /signatories` от `SigningAuthority` (подзадача
3.5, `feat/authority-profiles`): ветка не смёржена в `main` и конфликтует при
мёрже (26 несвязанных коммитов разошлись). Э4.4 не может ждать её мёржа.

## Решения

### 1. Canonical-сериализация — вынесена в `common/canonical.py`

Рецепт (JSON с сортированными ключами, без пробелов, ASCII) уже существовал
в `services/audit_vault/canonical.py` для хеш-цепочки Vault, но это
периферийный сервис со своей БД — кросс-импорт из `apps.*` запрещён
(CLAUDE.md). Рецепт извлечён в `common/canonical.py`
(`canonical_json_bytes`/`sha256_hex`) без цепочки (`prev_hash`) — Vault и
`ContractVersion.integrity_hash` используют один и тот же house-style, но
разные модули.

`apps.contracts.services._json_safe` рекурсивно и детерминированно приводит
snapshot (UUID/Decimal/datetime → str/isoformat, сортировка ключей dict) к
JSON-совместимому виду перед хешированием — независимость от порядка вставки
ключей в Python-словаре подтверждена property-based тестом (Hypothesis).

### 2. `TimestampProvider` — новый интерфейс в `common/timestamps.py`

Р1: только `ServerTimestampProvider` (`source="server"`) — задел под RFC 3161
(`source="rfc3161"`, Ю-21) без изменения вызывающего кода сервисов.

### 3. Подпись адресуется `version_hash`, не FK

`Signature.version_hash` — `CharField`, не `ForeignKey` на `ContractVersion`.
Тело запроса `POST /signature-requests/{id}/sign` несёт хеш явно — сервис
сверяет его с `contract.frozen_version.integrity_hash` и отклоняет
несовпадение (`StaleVersionError` → `409 version_stale`) ДО применения
side-эффектов. Тот же приём для `route_signatory` (`version_id` в теле).

### 4. Реквизиты — гейт на способ расчёта, не на сегмент (redaction v2)

`etap-4.md` явно поправляет исходную редакцию tech-spec.md §6.1 («для
платных сегментов» → «где договором предусмотрены расчёты через платформу»):
гейт `RequisitesMissingError` срабатывает на
`payment_method ∈ Contract.PROTECTED_PAYMENT_METHODS` (`direct_platform`,
`hold`), не на `segment`. Реквизиты выплат физлица-получателя в Р1 хранить
негде (нет модели платёжных реквизитов физлица) — расчёты через платформу с
person-получателем честно блокируются, а не притворяются готовыми.

### 5. `route_signatory`/`sign`/`forward`/`decline_for_revision`/`expire` — на общей `NEGOTIATION_FSM`

Один объект `StateMachine` (`common/fsm.py`) для ВСЕХ переходов договора —
включая Э4.2 (согласование) и Э4.4 (подписание). tech-spec.md §6.1: «Contract
и Amendment — общая FSM» — когда Э4.5 подключит `Amendment` к тому же
`NEGOTIATION_FSM`, оба пути будут идентичны по переходам по построению (один
граф, не два независимых), а не по совпадению. Тест
`test_negotiation_fsm_transition_table_is_the_shared_amendment_contract`
пинит точный набор переходов как контракт для Э4.5.

`decline_for_revision` (аннуляция, ADR-006 в tech-spec.md §6.1: «удаляет
активные SignatureRequest/подписи») реализована как ЖЁСТКОЕ УДАЛЕНИЕ строк
`Signature` текущего раунда и перевод активных `SignatureRequest` в
`declined_for_revision` — `ContractVersion` НЕ удаляется (append-only
история снимков, юридически значимый артефакт). `contract.frozen_version`
снимается в `NULL`; повторная заморозка без содержательных изменений
переиспользует существующую версию с тем же хешем (не пытается создать
дубликат — `UNIQUE (contract_id, integrity_hash)`).

### 6. Signatories: free_c2c-first, сеам под 3.5

`GET /contracts/{id}/signatories` для person-стороны возвращает единственного
подписанта — собственный `user` этой стороны (лимитов нет, представитель не
нужен). Для business-стороны список пуст: подписание от business-профиля по
лимиту `SigningAuthority` (3.5) — сеам (`SignatureRequest.signing_authority_id`
— свободный `UUIDField`, НЕ FK, по тому же приёму, что `Contract.
customer_contact` deferred до появления `apps.authority`), активируется
отдельной веткой при мёрже 3.5. Приёмочный сценарий Э4.4 (free_c2c «Услуга»
между двумя физлицами) проходит полностью без 3.5.

### 7. Idempotency-Key — новая инфраструктура в `common/`

Требование CLAUDE.md/etap-4.md («денежные/подписные POST — с
Idempotency-Key») до этой ветки нигде не было реализовано (greenfield).
`common.models.IdempotencyKey` + `common/api/idempotency.py`: ключ +
пользователь + endpoint-код → сохранённый ответ первого вызова; тот же ключ
с другим телом запроса — `422 idempotency_key_reused`. Обязателен на
`freeze`/`signature-requests` (POST)/`sign`.

## Последствия

- `GET /contracts/{id}/versions/{vid}` отдаёт `ETag: "<integrity_hash>"` —
  единственное применение ETag/If-Match в этой ветке (остальные
  подписные POST используют version_hash/version_id в теле, не заголовок
  If-Match — так буквально написано в tech-spec.md §8.4 для `/sign`).
- `Amendment` (Э4.5) не заводится этой веткой — сама модель и её эндпоинты
  остаются за следующей веткой; FSM для неё уже готова (см. п. 5).
- Полная поддержка business-подписантов по лимиту SigningAuthority ждёт
  мёржа 3.5 — сеам оставлен явно, не эмулируется заглушкой с фиктивными
  данными.
