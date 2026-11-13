# ADR-134. Хроника договора: реестр topic'ов, ключ представления `kind`, свёрнутые события дочерних сущностей

- Статус: принято
- Дата: 2026-08-26
- Ветка: `feat/contracts-timeline`
- Связано с: tech-spec.md §6.4 (доменные события и лента объекта, §37a
  концепции), §8.4 (`GET /contracts/{id}/timeline`), ADR-064 (реле outbox),
  ADR-126 (`subject.contract_id` у событий дочерних сущностей), ADR-095/
  Л.2 (языковые пакеты), Э6 (экспорт архива — будущий потребитель `kind`)

## Контекст

`GET /contracts/{id}/timeline` — read-модель прямо из outbox: строки с
`subject.type == "contract"`, поле `topic` — сырой код, фронт печатал его как
есть (22 кода, переводов ни в одной локали). Разбор 26.08 (docs/backlog.md,
«Комментарии пользователя») зафиксировал три проблемы и решения владельца:

1. `message.created` (чат) засоряет хронику — у переписки своя вкладка,
   в ленте юрзначимых фактов сообщения — шум.
2. Один topic несёт несколько смыслов, различимых только по payload:
   `negotiation.revised` — предложить / принять / отклонить / встречная /
   «принять все» / альтернатива; `domain_deadline.fired` — «гарантия истекла»
   и «окно оспаривания расторжения закрылось». Различать надо на бэке.
3. Реестра topic'ов в бэке не было: литералы в `services.py`, список в
   tech-spec §6.4 «неполный» и содержит коды, которые никто не эмитирует
   (`signature.*`, `contract.fee_*`, `payment.initiated|observed|captured|
   confirmed|refunded|failed`, `milestone.disputed`…). Переводить — только
   по фактическим.

Плюс продуктовое: ключевые события этапов, допников, споров, платежей и
гарантии в хронике договора нужны (свёрнуто), а contracts не импортирует
payments/disputes (import-linter) — собирать их можно только из той же
outbox-таблицы, без join на чужие модели.

## Решение

**Бэк отдаёт и стабильный ключ представления `kind`, и готовую подпись
(`title`/`detail`) на языке запроса из l10n-паков; фронт не переводит.**
Первоначальный вариант «гибрид: `kind` с бэка, словарь подписей во фронте»
отменён решением владельца 26.08 в тот же день (docs/backlog.md): один
источник текстов (паки, ревью носителем, `pack_version`/lock) вместо двух
словарей, и тот же `kind` → текст пригодится экспорту архива Э6 без
переделки. `kind` остаётся в ответе — стабильный ключ для фронтовой логики
(иконки, группировка) и для фолбэка, когда текста нет.

### 1. Реестр topic'ов — `apps/contracts/events.py::Topic`

`StrEnum` со ВСЕМИ topic'ами, которые публикует `apps.contracts.services`
(35 сайтов публикации). Литералов в `publish` больше нет; тест
`test_timeline.py::test_every_published_topic_is_in_registry` разбирает
`services.py` через `ast` и сверяет первый аргумент каждого `*.publish(...)`
с реестром — AST, а не перехват в рантайме, потому что перехват покрыл бы
только сайты, до которых дошли тесты. `amendment.rejected` /
`amendment.withdrawn` заведены заранее под `feat/contracts-amendment-reject`.

Чужие topic'и (`milestone.*`, `dispute.*`, `payment.*`, `warranty.*`) в
реестр НЕ входят — владелец topic'а его издатель; в `events.py` они только
перечислены строками как ключи свёртки (`NESTED_TOPICS`).

### 2. Фильтр чата

`events.EXCLUDED_TOPICS = {"message.created"}` — фильтр на выдаче в
`selectors.get_timeline`; outbox не трогается (событие нужно уведомлениям и
Audit Vault, §37a: «три потребителя — один источник»).

### 3. `kind` — `events.timeline_kind(topic, payload)`

Одна функция с таблицами соответствий, по ветке на тест:

| topic | различитель в payload | kind |
|---|---|---|
| `negotiation.revised` | `action=proposed` | `negotiation.revised.proposed` |
| | `action=accepted` | `negotiation.revised.accepted` |
| | `action=accepted, via=accept_all` | `negotiation.revised.accept_all` |
| | `action=rejected` | `negotiation.revised.rejected` |
| | `action=countered` | `negotiation.revised.countered` |
| | `action=preapproved_applied` | `negotiation.revised.alternative` |
| `negotiation.reopened` | `reason=returned_for_revision` | `negotiation.reopened.returned` |
| | `reason=declined_for_revision` | `negotiation.reopened.declined` |
| `contract.terminated` | `terminated_by=customer` | `contract.terminated.by_customer` |
| | `terminated_by=contractor` | `contract.terminated.by_contractor` |
| `domain_deadline.fired` | `kind=contract_warranty` | `deadline.warranty_expired` |
| | `kind=termination_dispute_window` | `deadline.termination_window_closed` |
| остальные | — | `kind == topic` |

Поле `action` у `negotiation.revised` уже было во всех шести сайтах
публикации; payload не менялся. Событие без различителя (старые строки,
чужой издатель) честно остаётся под своим topic'ом — элемент не теряется,
подпись будет общей. `negotiation.reopened` и `contract.terminated` добавлены
к списку владельца по тому же критерию («один topic — два смысла»: вернул
сам / отклонил подписант; расторг заказчик / исполнитель).

Полный список значений — `events.TIMELINE_KINDS` (реестр для фронта/l10n).

### 4. Свёрнутые события дочерних сущностей

`selectors.get_timeline` собирает из outbox:

- собственные события договора: `subject.type=contract, subject.id=<id>`,
  кроме `EXCLUDED_TOPICS`;
- `events.NESTED_TOPICS` по `subject.contract_id=<id>` (издатели milestones/
  disputes/payments/warranty кладут его в `subject`, tech-spec §6.4 и
  ADR-126) ИЛИ `payload.contract_id=<id>` (допники: `subject` — сам допник,
  `contract_id` — в payload).

Ключевые, не все: `milestone.started|submitted|accepted|auto_accepted|
rejected`, `amendment.sent|rejected|withdrawn` («подписан обеими» — это
`contract.amended` на самом договоре), `dispute.opened|resolved`,
`payment.paid`, `warranty.claim_submitted|claim_declined|claim_resolved`.
`milestone.paid` намеренно не включён: тот же факт публикует `payment.paid`
(payments зеркалит подтверждение в milestones в одной транзакции), деньги —
сущность платежей. Рабочий шум (`milestone.gate_passed/suspended/
checklist_*`, `payment.created/payer_confirmed`, `dispute.responded/fix_*`)
остаётся в ленте самой сущности (`/milestones/{id}/timeline`).

Элемент получает `nested: true` (subject — не договор) и
`subject: {type, id, title}`; `title` — только из самого события
(`payload.milestone_title`, «самодостаточный payload» док 31 §7), без join.
Ссылки на смежные сущности фронт берёт из `payload` издателя (проверено,
издатели не менялись): `warranty.claim_*` — `payload.dispute_id` (спор
претензии; `apps.warranty.services._payload` кладёт его во все три
события), `dispute.*` — `payload.milestone_id` (`null` у гарантийного
спора), `payment.paid` — `payload.milestone_id`, `contract.amended` —
`payload.amendment_id`.

Порядок — `occurred_at`, тай-брейк `event_id` (uuid7 монотонный) для
событий одной транзакции (`contract.completed` + `contract.warranty_started`).

### 5. Контракт элемента (`TimelineEventSerializer`)

```json
{
  "event_id": "uuid",
  "topic": "negotiation.revised",
  "kind": "negotiation.revised.accepted",
  "title": "Правка принята",
  "detail": "Пункт: title",
  "nested": false,
  "occurred_at": "2026-08-26T10:00:00Z",
  "actor": {"user_id": "…"},
  "subject": {"type": "contract", "id": "…", "title": null},
  "payload": {"…": "…"}
}
```

Тот же сериализатор у `/amendments/{id}/timeline` и `/milestones/{id}/
timeline` (`selectors.timeline_entries` — общий вход для лент сиблинг-
сущностей); там `nested: true` у всех строк, сворачивать нечего.

### 6. Подписи `title` / `detail` — из l10n-паков, namespace `ui`

- **Где хранить.** Вариант «таблица + миграция-сид по образцу
  `NotificationTemplate`» отвергнут: у уведомлений таблица нужна для
  RU-контура и `body_i18n`, а для хроники есть готовый путь «строка по
  (ключ, язык) без новой инфраструктуры» — `apps.l10n.selectors` читает
  `LocalePack.content` с фолбэком locale → en. Namespace `ui` — плоская
  карта `{ключ: текст}`, уже валидируется импортёром; новых namespace'ов и
  миграций нет. Ключи: `ui.timeline.<kind>` (заголовок) и
  `ui.timeline.<kind>.detail` (короткая подпись с подстановками из payload,
  необязательна). Один запрос на язык цепочки на всю ленту —
  `l10n_selectors.get_ui_map("timeline.", locale=…)` (новый селектор по
  образцу `get_catalog_map`), не по два запроса на элемент.
- **Язык** — `common.i18n.resolve_request_locale(request)` (ADR-095:
  `user.locale` → страна → Accept-Language → default), тот же порядок, что у
  ошибок API и у получателя уведомления.
- **Подстановки** (`events.timeline_detail_vars`, EN-канон плейсхолдеров):
  `{milestone_title}`, `{item}` (item_ref правки), `{amount}` `{currency}`,
  `{comment}`, `{reason}`, `{description}` — только непустые строки из payload
  события, без чтения БД. Нет шаблона или в payload нет значения (гарантийный
  спор без этапа, пустой комментарий) — `detail: null`, а не подпись с
  дыркой (`events.render_timeline_detail`).
- **Нет текста ни в locale, ни в en** (новый kind без строки в паке, паки
  не импортированы) — `title: null`; фронт показывает `kind`. Честный
  контракт вместо ключа под видом подписи.
- **Паки:** патч `l10n/patches/contract-timeline-kinds.json` (71 ключ ×
  29 языков: 50 заголовков + 21 detail) → `apply_pack_patch.py` →
  `pack_version` +1 у всех 29 → `lock_packs.py`. ru/en — авторские, остальные
  27 — машинный перевод (ревью носителем, как у всех `quality=machine`).
- **Тесты:** каждый `kind` из `TIMELINE_KINDS` имеет заголовок в ru и en и во
  всех 29 паках; плейсхолдеры `detail` совпадают с en-каноном; неизвестный
  kind → `title: null`, лента не падает; без импортированных паков — тоже.

## Последствия

- Схема БД не меняется, миграций нет. Запрос по JSON-ключам
  (`subject->>'contract_id'`, `payload->>'contract_id'`) сужен
  `topic IN (...)` (есть индекс `topic, occurred_at`); отдельная read-таблица
  `object_timeline` из §37a остаётся планом на объёмах, где это станет
  заметно.
- Новый kind = строка в таблице `timeline_kind` + тест ветки + запись в
  `TIMELINE_KINDS` (тест `test_every_derived_kind_is_in_registry`).
- tech-spec §6.4: реестр topic'ов приведён к фактическому, добавлен §6.4a
  с контрактом элемента хроники.
- Новый kind = строка в паках (патч через `apply_pack_patch.py`, bump
  `pack_version`) — тест полноты не даст забыть.
- Фронт: показывает `title`/`detail` как есть (ветка
  `feat/web-timeline-labels`), `nested` сворачивается, `subject` — ссылка на
  этап/допник/спор/платёж; `kind` — для иконок/группировки и фолбэка при
  `title: null`.
