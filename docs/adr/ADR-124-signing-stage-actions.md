# ADR-124: Действия на этапе подписания — одна кнопка «Подписать», возврат на доработку и отклонение без заявки

Дата: 2026-08-25. Статус: принят. Бэк — `feat/contracts-signing-actions`, web — `feat/web-signing-actions`.

## Контекст

Экран подписания (`SigningPage`, реальный контур ADR-088 Фаза 4) буквально повторял
технический путь бэка: `under_review` → кнопка «Заморозить версию» → `pending_signature` →
кнопка «Отправить заявку на подпись» (`route_signatory`) → `awaiting_signatures` → «Подписать»
и «Вернуть на доработку». Отсмотр 2026-08-25: «с кнопками подписания какая-то путаница …
должно быть 3 кнопки разного цвета: Подписать, Вернуть на доработку, Отклонить. Кнопка
„Отправить заявку на подпись“ не надо вообще».

Причина путаницы — техническая ступень `SignatureRequest` (маршрутизация подписанта, нужна
для B2B с `SigningAuthority`, ADR-096) была вынесена в UI как самостоятельный жест, хотя в
C2C-запуске подписант всегда один — сам пользователь. Кроме того, «Вернуть на доработку»
существовала только как `decline_for_revision` — действие АДРЕСАТА pending-заявки, поэтому в
`pending_signature` (заявки ещё нет) вернуть договор было нечем, а «Отклонить»/«Отозвать»
(`reject`/`withdraw`) FSM допускала только из `under_review`.

## Решения

### 1. FSM согласования: выход из заморозки любым жестом согласования

В общий `NEGOTIATION_FSM` (`apps/contracts/services.py`) добавлены переходы:

| переход | из | в |
|---|---|---|
| `return_for_revision` | `pending_signature`, `awaiting_signatures` | `under_review` |
| `reject` | `pending_signature`, `awaiting_signatures` | `rejected_by_counterparty` |
| `withdraw` | `pending_signature`, `awaiting_signatures` | `withdrawn_by_initiator` |

`decline_for_revision` (по заявке, адресатом) сохранён — это тот же жест, но с адресацией
через `SignatureRequest` (нужен B2B-маршрутизации и `apps.dashboards` «ждёт моей подписи»).
FSM общая с Amendment: граф расширен и для допников, но сервисов `withdraw/reject/return`
для Amendment по-прежнему нет (как и раньше не было `withdraw/reject`) — при необходимости
добавляются тем же приёмом.

### 2. Аннулирование раунда — один хелпер `_annul_signing_round`

Любой выход из замороженного состояния (`return_for_revision`, `decline_for_revision`,
`reject_negotiation`, `withdraw_negotiation`) делает одно и то же: все pending
`SignatureRequest` раунда договора → `declined_for_revision` (новое значение enum НЕ
вводится — семантика «заявка аннулирована, подпись не состоялась» та же), подписи раунда
удаляются, `contract.frozen_version = NULL`. `ContractVersion` не удаляется — append-only
история снимков (инвариант). Id аннулированных объектов попадают в payload события
(`negotiation.reopened` / `negotiation.rejected` / `negotiation.withdrawn`) — хроника
договора показывает, что именно отменено. `negotiation.reopened` несёт `reason`:
`declined_for_revision` (старый путь) или `returned_for_revision` (новый) и `comment`.

### 3. API

- `POST /v1/contracts/{id}/return-for-revision` `{comment}` (обязателен, непуст, ≤ 2000) →
  `200 ContractSerializer`; любая сторона договора; из не-замороженных состояний — `409
  invalid_negotiation_transition` (общий маппинг `InvalidTransitionError`).
- `POST /v1/contracts/{id}/reject` и `/withdraw` — теперь и из `pending_signature` /
  `awaiting_signatures`; ролевые правила прежние (`reject` — только контрагент, `403
  not_counterparty`; `withdraw` — только инициатор, `403 not_initiator`).
- `POST /v1/signature-requests/{id}/decline` — без изменений.

### 4. Web: три кнопки, «Подписать» — составная

На реальном `SigningPage` для `under_review` / `pending_signature` / `awaiting_signatures`
под договором одна панель действий: **«Подписать»** (`primary`), **«Вернуть на доработку»**
(`secondary`), **«Отклонить»** (`destructive`). Экран «Заморозить версию» и кнопка
«Отправить заявку на подпись» убраны (ключ `signing.realRouteCta` удалён из 29 локалей).

«Подписать» выполняет цепочку сама: (a) `under_review` → `POST /freeze` (предметные ошибки
`requisites_missing` / `open_revisions` / `leaf_sum_mismatch` — те же тексты, что раньше);
(b) нет своей pending-заявки → `POST /signature-requests` с единственным подписантом своей
стороны (`GET /signatories`; пустой список → прежний блок «Подписант недоступен»);
(c) `POST /signature-requests/{id}/sign` на `integrity_hash` текущей версии → церемония.
Одно состояние загрузки на всю цепочку. Под `under_review` вместо блока замороженной версии —
нейтральный Callout «Нажмите «Подписать» — версия будет зафиксирована и подписана».

«Вернуть на доработку» → модалка с обязательным комментарием → `return-for-revision` →
карточка договора. «Отклонить» → подтверждение → `reject` (я не инициатор) или `withdraw`
(я инициатор) — для пользователя это один и тот же жест «не буду заключать», подпись кнопки
одна; статус в карточке различает `rejected_by_counterparty` / `withdrawn_by_initiator`.

## Инварианты (сохранены)

- Подпись — всегда на `integrity_hash` замороженной `ContractVersion`; составная кнопка
  подписывает ХЕШ версии, только что полученной с бэка (`sign` сверяет его — `409
  version_stale`).
- Подписанный договор неизменяем: `return_for_revision`/`reject`/`withdraw` из `signed` — 409.
- `ContractVersion` append-only; повторная заморозка без правок переиспользует версию.
- Каждый новый переход и каждый запрет — отдельным тестом (`test_signing.py`,
  `test_signing_api.py`); таблица переходов зафиксирована тестом парности с Amendment.

## Последствия

- Для C2C шаг «заявка на подпись» невидим; для B2B (SigningAuthority, `B2B_SIGNING_ROUTING`)
  выбор подписанта вернётся отдельным UI поверх тех же эндпоинтов — API не менялось.
- `negotiation.rejected`/`negotiation.withdrawn` теперь всегда несут списки
  `annulled_signature_request_ids`/`annulled_signature_ids` (пустые из `under_review`).
- Уведомления/дашборды, читающие `SignatureRequest.status = declined_for_revision`, видят
  аннулированные заявки и после reject/withdraw — это ожидаемо (заявка закрыта без подписи).
