# ADR-133. Гарантийная претензия: «устранил» → подтверждение заказчика / «не устранено» / автоподтверждение по окну

- Статус: принято
- Дата: 2026-08-26
- Ветка: `feat/warranty-satisfied`
- Связано с: ADR-029/030 (гарантийный срок, отдельная метрика обращений),
  ADR-057 (ЛК как юрканал и якорь дедлайнов), ADR-064 (outbox-реле,
  at-least-once), ADR-072 (свип доменных дедлайнов), ADR-126 (матрица
  «действие → событие → уведомление»), ADR-131 §7 и дополнение 26.08
  (гарантия — своё приложение, диалог — `Dispute(kind=warranty)`,
  `decline_warranty_claim`, гард `warranty_declined` в `resolve_dispute`)

## Контекст

После дополнения 26.08 у претензии была одна кнопка — отказ исполнителя.
Исход `warranty_satisfied` существовал, но выбирался только через общий
`POST /disputes/{id}/resolve` **без проверки роли**: исполнитель мог
«удовлетворить» претензию к самому себе (тесты этап-7 так и делали). Ни
момента «исполнитель устранил», ни окна, за которое заказчик обязан
отреагировать, ни автозакрытия по молчанию не было — претензия висела до
потолка 30 дней.

Решение владельца 26.08 дословно: «Заказчик, нужен гард роли и кнопка,
симметрично отказу — нужно. Так же как с приёмкой. Если клиент не прислал
замечание в течение времени окна приёмки, то будет автоприёмка.»

## Решение

### 1. Три действия и статус `awaiting_confirmation` у претензии

| Действие | Эндпоинт | Кто | Из | В | Событие |
|---|---|---|---|---|---|
| «устранил» | `POST /warranty-claims/{id}/fix-submitted` `{comment?, evidence?}` | исполнитель | `submitted` | `awaiting_confirmation` | `warranty.fix_submitted` |
| подтвердить | `POST /warranty-claims/{id}/satisfy` `{comment?}` | заказчик | `submitted` / `awaiting_confirmation` | `resolved(warranty_satisfied)` | `warranty.claim_satisfied` |
| «не устранено» | `POST /warranty-claims/{id}/contest` `{comment, evidence?}` | заказчик | `awaiting_confirmation` | `submitted` | `warranty.claim_contested` |
| авто (свип) | — | система | `awaiting_confirmation` | `resolved(warranty_satisfied)` | `warranty.claim_auto_satisfied` |
| отказ (было) | `POST /warranty-claims/{id}/decline` | исполнитель | `submitted` / `awaiting_confirmation` | `resolved(warranty_declined)` | `warranty.claim_declined` |

Состояние «ждёт подтверждения заказчика» живёт на **претензии**
(`WarrantyClaim.status`), а не на споре: `Dispute(kind=warranty)` остаётся
`open` — диалоговый контур (реплики, окно ответа, потолок 30 дней) ему не
мешает, а FSM спора не обрастает состоянием, которого нет у спора по этапу.
`podtverdit'` разрешено и из `submitted` (устранили на месте, формального
«устранил» не было) — симметрично отказу, который тоже не требует
предварительных шагов.

Закрытие — как у отказа: спор закрывается фасадом
`disputes.resolve_dispute(..., "warranty_satisfied")`, заявка — в той же
транзакции; подписчик `handle_dispute_resolved` на закрытой заявке — NOOP.
События `claim_satisfied`/`claim_auto_satisfied` публикуются ВМЕСТО
`warranty.claim_resolved` (один момент — одно уведомление, ADR-126 §4).

### 2. Гард роли — в двух местах, симметрично `warranty_declined`

`warranty.services` проверяет сторону сам (403 `wrong_dispute_side`), и
`disputes.resolve_dispute` держит таблицу `_WARRANTY_RESOLUTION_ROLE`
(`warranty_declined` → исполнитель, `warranty_satisfied` → заказчик):
общий `/disputes/{id}/resolve` больше не даёт исполнителю закрыть претензию
к себе. `user=None` (системный исход по свипу) гард обходит — как
`cap_reached`. Существующие тесты, где исполнитель резолвил
`warranty_satisfied`, переписаны на заказчика — это и была дыра.

### 3. Окно подтверждения — доменный дедлайн, длина = окно приёмки этапа

`fix-submitted` создаёт строку `DomainDeadline(kind="warranty_claim_acceptance",
subject=warranty_claim, starts_from=cabinet_placement)` — тот же приём, что
`apps.milestones.services.submit_milestone`: дедлайн тикает с момента
**размещения** уведомления `warranty.fix_submitted` в ЛК (ADR-057,
`_anchor_related_deadlines` по субъекту), не с вызова API. Отложенных
Celery-задач нет — свип `apps.deadlines` раз в минуту публикует
`domain_deadline.fired`, `apps.warranty.handlers.handle_deadline_fired`
(реестр `OUTBOX_SUBSCRIBERS["domain_deadline.fired"]`, дискриминация по
`payload["kind"]`, как у milestones/disputes/payments) вызывает
`auto_satisfy_warranty_claim`.

Источник длины окна приёмки — `DeadlineKindConfig("milestone_acceptance")`
(48 ч, deadlines/0002); на уровне договора отдельного параметра нет.
Миграция `deadlines/0007` заводит `warranty_claim_acceptance` **со значением
из этой строки на момент миграции**, а не литералом. Своя строка, а не общий
`kind` с этапом, потому что `DomainDeadline.kind` — одновременно категория
длительности и дискриминатор обработчиков; если юрист позже разведёт окна,
это правка данных. Тест `test_warranty_acceptance_window_equals_milestone_
acceptance` фиксирует равенство на сиде.

Снятие окна (подтверждение, возражение, отказ, закрытие по исходу спора) —
**пауза** дедлайна (`pause_deadline`, свип фильтрует `paused=False`), как у
окон спора: удаления дедлайнов в проекте нет. `WarrantyClaim.
acceptance_deadline_id` — по значению, без FK (как `dispute_id`); подписчик
свипа сверяет `deadline_id` события с текущим окном претензии — повторная
доставка старого срабатывания не закроет новый раунд.

Авто-исход: актор пуст (системное действие, как `finalize_acceptance(auto=True)`),
`auto=True` в payload, уведомление обеим сторонам «претензия закрыта
автоматически по истечении окна». Серия напоминаний по окну — см.
дополнение 26.08 ниже (в6-8; в первой редакции её не было).

### 4. Раунды «не устранено» — своё поле, потолок общий

`WarrantyClaim.fix_rounds_used` + `CHECK (<= 2)`, константа —
`apps.disputes.models.MAX_FIX_ROUNDS` (импорт warranty → disputes законен).
Третье возражение — `409 fix_rounds_exhausted`, код из tech-spec.md §8.8
дословно; дальше — подтверждение, отказ исполнителя, суд или потолок.

Почему не `disputes.request_fix`/`resubmit_fix` через фасад: раунд спора по
этапу — пара «заказчик просит → исполнитель сдаёт», и сдача возвращает
**этап** в `under_acceptance` подписчиком `apps.milestones` — у гарантии
этапа нет, а порядок действий обратный (сам факт претензии и есть просьба;
раунд открывает исполнитель). Переиспользовать `FixRequest` значило бы
либо заводить фиктивный `request_fix` перед каждым «устранил», либо учить
`request_fix` гарантийным спорам с `milestone=None` и глушить
`dispute.fix_requested`/`fix_resubmitted` (дубли уведомлений). Поэтому —
таблица `warranty_fix` (`WarrantyFix`: `round`, `submitted_by`, `comment`,
`evidence`, `submitted_at`, `contested_by`, `contest_comment`,
`contest_evidence`, `contested_at`), зеркало `FixRequest` с обратным
порядком; `round = fix_rounds_used + 1` на момент сдачи (1..3, CHECK).
Тексты и доказательства хранятся строкой, а не только в payload события
(тот же довод, что у `DisputeReply` в дополнении 26.08 к ADR-131).

### 5. Границы приложений

- warranty → disputes только через `services`/`selectors`-фасады и
  `MAX_FIX_ROUNDS` из `models`; disputes про warranty не знает;
- закрытие претензии по исходу спора и авто-исход — подписчики outbox;
- import-linter: без изменений контрактов, все зелёные.

## Уведомления (реестры ADR-126)

Четыре новых кода, тексты нейтральны, один код на оба реестра:
`warranty.fix_submitted`, `warranty.claim_satisfied`, `warranty.claim_contested`
(актор + контрагент), `warranty.claim_auto_satisfied` (только реестр
контрагента — актора нет, обеим сторонам). Все `legal_significance=True`.
Лента: `fix_submitted`/`contested` → `dispute`/`due`, `claim_satisfied` →
`dispute`/`good`, `claim_auto_satisfied` → `deadline`/`good`;
`action.href` — `/contracts/{contract_id}` (общая проекция ленты).
`NotificationTemplate` — `notifications/0020_seed_warranty_satisfaction_templates`;
тексты во все 29 пакетов (`l10n/patches/adr-133-warranty-satisfaction.json`,
`pack_version` +1, lock обновлён).

## API

`WarrantyClaimSerializer` +: `status` (`submitted | awaiting_confirmation |
resolved`), `fix_rounds_used`, `fix_rounds_left`, `fix_submitted_at`,
`acceptance_deadline_at` (null до размещения уведомления в ЛК и вне окна),
`fixes[{id, round, submitted_by_id, comment, evidence, submitted_at,
contested_by_id, contest_comment, contest_evidence, contested_at}]`.

Ошибки: 403 `permission_denied` (чужак), 403 `wrong_dispute_side` (не та
сторона — и из `resolve_dispute` тоже), 409 `warranty_claim_already_resolved`,
409 `warranty_claim_awaiting_confirmation` (повторный «устранил»),
409 `warranty_claim_not_awaiting_confirmation` (возражение без «устранил»),
409 `fix_rounds_exhausted`, 409 `dispute_already_resolved`,
409 `warranty_claim_dispute_missing`.

## Последствия и хвосты

- Претензия, по которой исполнитель нажал «устранил», а заказчик молчит,
  закрывается через окно приёмки (48 ч от размещения в ЛК) — в пользу
  исполнителя, как автоприёмка этапа. Это продуктовое решение владельца;
  длину окна юрист может развести с этапом правкой `DeadlineKindConfig`.
- `DisputeSerializer` про статус претензии не знает (disputes не импортирует
  warranty): карточка спора `kind=warranty` берёт статус из
  `GET /contracts/{id}/warranty-claims` по `dispute_id`.
- Усиленная серия напоминаний по окну подтверждения — дополнение 26.08.

## Дополнение 26.08 (`feat/disputes-warranty-followups`)

### Серия напоминаний по окну подтверждения (в6-8: «да»)

`ReminderPointConfig(kind="warranty_claim_acceptance", template=
"warranty_claim_acceptance_reminder")` — та же усиленная серия, что у окна
приёмки этапа: миграция `notifications/0021` копирует точки из строки
`milestone_acceptance` на момент миграции (как `deadlines/0007` копирует
длительность), а не литералом. Шаблон `warranty_claim_acceptance_reminder`
— `legal_significance=True`, `body_i18n` пуст, тексты во всех 29 пакетах
(`l10n/patches/adr-133-warranty-reminders.json`, `pack_version` +1: ru 18,
остальные 19; lock обновлён). Лента: `("deadline", "due")` → группа
«Сроки», как `milestone_acceptance_reminder`. Адресат — заказчик; финальная
точка (0.99) — с SMS-фоллбэком (ADR-057), как у приёмки.

**Кому уходит серия — и почему уведомление заказчику теперь размещается
прямым вызовом.** `place_notification` планирует серию для получателя ТОГО
уведомления, которым якорится дедлайн. В первой редакции якорил подписчик
outbox, а он размещает сначала актору (исполнителю) — серия ушла бы не той
стороне. Поэтому `submit_warranty_fix` размещает `warranty.fix_submitted`
заказчику сам, прямым `place_notification` (тот же приём, что
`milestones.services.submit_milestone` → `milestone_submitted_for_acceptance`,
список «прямых» точек в докстринге реестров `config/settings/base.py`), а из
реестра контрагента `warranty.fix_submitted` убран; исполнителю копию
по-прежнему кладёт реестр актора. Побочное следствие для API: окно
заякорено уже в транзакции `POST /fix-submitted`, и `acceptance_deadline_at`
в его ответе заполнен сразу (раньше — `null` до прохода реле). Юридически
это точнее ADR-057: окно считается от размещения в ЛК той стороны, которая
обязана реагировать.

**Снятие серии.** Подтверждение, возражение, отказ исполнителя и закрытие
по исходу спора по-прежнему ставят дедлайн на паузу; свип напоминаний
(`notifications.tasks.sweep_reminder_schedules`) теперь фильтрует
`deadline.paused=False` — напоминание о снятом окне не шлётся, старая серия
после «не устранено» → новый «устранил» молчит, новый раунд получает свою.
Это общее правило для всех серий (у `milestone_acceptance` паузы окна нет,
поведение не меняется).

**Договор напоминания.** У `DomainDeadline` нет `contract_id`, а
`place_notification` умеет добирать договор по субъекту только для
`milestone`; `_fire` берёт его из уведомления, которым дедлайн заякорен
(`Notification.related_deadline`) — иначе у напоминания по `warranty_claim`
не было бы ни `{contract_title}`, ни якоря навигации ленты.

### Признак автозакрытия в API претензии

`WarrantyClaim.resolved_by` (FK на пользователя, NULL у системного исхода)
и `resolved_auto` (bool) — миграция `warranty/0003`; CHECK
`warranty_claim_auto_resolution_has_no_actor`: `resolved_auto=true` только у
`status=resolved` и без `resolved_by`. Поле, а не вычисление из событий:
таблица outbox чистится, а «закрыта автоматически» — факт, который фронт
показывает на карточке. Заполняет `_close_claim`: подтверждение — заказчик,
отказ — исполнитель, общий `/disputes/{id}/resolve` — актор исхода спора
(подписчик `handle_dispute_resolved` переносит `event.actor`), свип окна
подтверждения и потолок 30 дней (`cap_reached`, актора нет) — `resolved_auto=
true`. Существующие закрытые претензии остаются `false/NULL` — восстановить
актора задним числом по outbox нельзя, угадывать юрфакт не стоит.

`WarrantyClaimSerializer` +: `resolved_by_id: uuid|null`, `resolved_auto:
bool`. Фронт: «закрыта автоматически по истечении окна» = `resolved_auto &&
resolution_type == "warranty_satisfied"`; `resolved_auto && resolution_type ==
"cap_reached"` — «закрыта по потолку спора». Событие `warranty.claim_*` при
закрытии теперь всегда несёт `auto: bool` (раньше — только два топика).
