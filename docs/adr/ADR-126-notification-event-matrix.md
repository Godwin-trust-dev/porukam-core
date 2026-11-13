# ADR-126. Матрица «действие по договору → событие → уведомление»: вторая аудитория события и платёжный контур

- Статус: принято
- Дата: 2026-08-25
- Ветка: `feat/notifications-contract-actions`
- Связано с: ADR-057 (ЛК как юрканал уведомлений), ADR-064 (outbox-реле,
  at-least-once), ADR-075/ГВ.5 (язык уведомления), ADR-095 (полнота пакетов),
  ADR-098 (самодостаточный payload уведомления), ADR-112 (чат по договору)

## Контекст

Отсмотр 25.08 (дословно): «Уведомления не приходят при действиях по оплате.
Проверь в целом что с формированием уведомлений. Они должны приходить по
каждому действию по договору.»

Аудит показал две системные дыры, а не единичный пропуск.

**1. У события была ровно ОДНА аудитория — актор.**
`apps.notifications.subscriber.handle_event` создавал уведомление только для
`event.actor.user_id` (или явного `payload.notify_user_id`, ADR-112/объединения).
То есть человек получал уведомления исключительно о СВОИХ действиях, а о
действиях контрагента — только там, где приложение обходило реестр топиков и
звало `place_notification` напрямую (`signature_requested`,
`milestone_submitted_for_acceptance`, `evidence_received`,
`milestone_material_notice`, `message.received`, `contract.completed`). Шесть
точек из нескольких десятков. Остальное — отправка договора на согласование,
правки, отзыв, отклонение, возврат на доработку, подпись второй стороной,
старт/приёмка/отклонение этапа, расторжение, закрытие по гарантии — доходило
только до того, кто это сделал.

Реестр `NOTIFICATION_TOPIC_TEMPLATES` при этом задокументировал ограничение как
осознанное («handle_event шлёт уведомление ТОЛЬКО actor'у — не контрагенту:
реестр сознательно НЕ включает топики, где это делает уведомление
бессмысленным»). Ограничение архитектурное, а не продуктовое: сам подписчик не
умел резолвить стороны договора.

**2. Платёжный контур не был подключён ни одним топиком.**
`apps.payments` — пустое приложение (Э5 не начат, там только README);
подтверждения оплаты живут в `apps.milestones.services`
(`confirm_advance`/`confirm_payment`). Их события —
`milestone.advance_confirmed`, `milestone.payment_confirmed`, `milestone.paid` —
публиковались в outbox, но не встречались ни в одном реестре и не имели строк
`NotificationTemplate`. Никто не получал по оплате НИЧЕГО — ни актор, ни
контрагент. Зеркально: в проекции ленты (`apps.notifications.selectors.
_FEED_TEMPLATE_TYPES`) тип `payment` существовал с самого начала, но на него не
ссылался ни один шаблон — вкладка «Платежи» была пуста по построению, а тумблер
`group_payments` нечего было глушить.

**3. Подписчик не был идемпотентен.**
Реле доставляет at-least-once на уровне СОБЫТИЯ (ADR-064, `common/relay.py`):
если упал хоть один подписчик темы, событие переотдаётся ВСЕМ подписчикам, включая
успевших. Прежний докстринг признавал это и считал допустимым («дубль уведомления
не искажает факт юридической доставки»). С двумя аудиториями одно событие рождает
до трёх уведомлений — дубли множатся кратно, и лента ЛК (юрканал) становится
недостоверной.

## Решение

### 1. Два реестра вместо одного

`config/settings/base.py` — данные, не код (CLAUDE.md):

- `NOTIFICATION_TOPIC_TEMPLATES` — АКТОР события (`payload.notify_user_id`,
  иначе `event.actor.user_id`). Без изменений семантики.
- `NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES` — стороны договора события КРОМЕ
  актора. У системного события без актора (дедлайн-свип, авто-исход спора,
  закрытие по гарантии) — ОБЕ стороны.

Договор события резолвится в порядке: `subject.contract_id` (события
milestone/dispute/evidence кладут его рядом с собственным id) → `subject.id` при
`subject.type == "contract"` → `payload.contract_id` (события `amendment.*`, где
субъект — сам допник). Стороны — `apps.contracts.selectors.party_users`
(новая функция, тот же резолв «person → owner_user, business → claimed_by», что
у существующей `party_user`).

Подписчик обращается к `apps.contracts.selectors` ЛОКАЛЬНЫМ импортом внутри
функции — тем же приёмом, что `apps.notifications.services._enrich_payload`
(ADR-098): `apps.contracts.services` сам импортирует `apps.notifications.services`,
цикла на уровне модулей не заводим.

### 2. Код шаблона = топик; суффикс `.counterparty` — только при реальном расхождении

`l10n/README.md`: пакет несёт `notifications.<code>`, `render_body` читает ровно
по этому ключу. Правило именования:

- текст нейтрален к точке зрения («Этап принят», «Условия зафиксированы»,
  «Этап оплачен») → ОБА реестра ссылаются на ОДИН код;
- текст расходится («Ваша подпись принята» vs «Вторая сторона подписала») →
  код контрагента = `<topic>.counterparty`.

Отдельный случай — `negotiation.revised`: один топик несёт ТРИ разных для
контрагента факта (правку предложили / его правку приняли / его правку
отклонили), различает их только `payload["action"]`. Разводить это тремя
топиками нельзя: топик уже записан в Audit Vault и в `apps.reputation`,
переименование ломает историю. Поэтому запись реестра может быть не строкой, а
словарём `action -> код` с ключом `"*"` как фолбэком. Механизм намеренно узкий:
дискриминатор один (`payload["action"]`), новых понятий в реестре не появляется.

### 3. Идемпотентность подписчика — `Notification.source_event_id`

Новое поле (UUID, nullable, по значению — без FK: outbox живёт в `common` и
чистится отдельно) + условный `UniqueConstraint (recipient, template,
source_event_id) WHERE source_event_id IS NOT NULL`. Две линии защиты, как у
`apps.reputation.subscriber`: предпроверка в `_place` до вызова
`place_notification` и ограничение БД; `IntegrityError` на гонке ловится и
считается успехом, а не сбоем доставки (иначе событие ушло бы в бесконечный
ретрай). У «прямых» вызовов `place_notification` поле остаётся `NULL` — условие
в ограничении не даёт им схлопнуться между собой.

### 4. Границы: что НЕ уведомляет

Явный список — чтобы «дополним реестр до полноты» не прошло молча (зафиксирован
тестом `test_milestone_tree_edits_stay_unmapped`):

- `contract.drafted` / `draft_patched` / `draft_deleted` — черновик до отправки,
  второй стороны в нём ещё нет как адресата;
- `contract.started` (тот же момент, что `milestone.started`),
  `contract.warranty_started` (тот же момент, что `contract.completed`),
  `milestone.gate_passed` (тот же момент, что `milestone.started`) — дубль соседа;
- `milestone.created/updated/deleted/checklist_item_added/material_added` —
  правка дерева этапов: мастер создания договора засыпал бы ленту, а изменения
  видны в самом договоре;
- `negotiation/amendment.signature_forwarded` — адресат `routed_by`,
  business-контур доверенностей (отдельная волна);
- `amendment.drafted/frozen/signed/reopened/signature_request_expired` —
  промежуточные шаги допника; продуктовый итог — `contract.amended`;
- `authority.*`, `entity.*`, `identity.*`, `account.logged_in`,
  `social.consent_recorded`, `otp.*`, `accounts.refresh_grace_hit`,
  `domain_deadline.fired`, `evidence.originals_deleted` — вне контура договора.

## Матрица покрытия

«актор» — реестр `NOTIFICATION_TOPIC_TEMPLATES`, «контрагент» —
`NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES`, «прямой» — вызов
`place_notification` из services.py мимо реестров.

| Действие | Топик | Актор | Контрагент |
|---|---|---|---|
| Отправка на согласование | `negotiation.sent` | `negotiation.sent` (было) | `negotiation.sent.counterparty` (**новое**) |
| Правка предложена / встречная / преодобренная | `negotiation.revised` (`action=proposed/countered/preapproved_applied`) | `negotiation.revised` (было) | `negotiation.revised.proposed` (**новое**) |
| Правка принята | `negotiation.revised` (`action=accepted`) | `negotiation.revised` (было) | `negotiation.revised.accepted` (**новое**) |
| Правка отклонена | `negotiation.revised` (`action=rejected`) | `negotiation.revised` (было) | `negotiation.revised.rejected` (**новое**) |
| Отзыв согласования | `negotiation.withdrawn` | — | `negotiation.withdrawn` (**новое**) |
| Отклонение договора | `negotiation.rejected` | — | `negotiation.rejected` (**новое**) |
| Заморозка (готов к подписанию) | `negotiation.frozen` | `negotiation.frozen` (было) | `negotiation.frozen` (**новое**, тот же код) |
| Запрос подписи | `negotiation.signature_requested` | прямой `signature_requested` (было) | — |
| Первая подпись | `negotiation.signed` | `negotiation.signed` (было) | `negotiation.signed.counterparty` (**новое**) |
| Вторая подпись (договор заключён) | `contract.signed` | `contract.signed` (было) | `contract.signed` (**новое**, тот же код) |
| Возврат на доработку | `negotiation.reopened` | — | `negotiation.reopened` (**новое**) |
| Срок подписания истёк (свип) | `negotiation.signature_request_expired` | actor пуст | `negotiation.signature_request_expired` (**новое**, обеим) |
| Допник отправлен | `amendment.sent` | — | `amendment.sent` (**новое**) |
| Допник вступил в силу | `contract.amended` | — | `contract.amended` (**новое**) |
| Расторжение | `contract.terminated` | — | `contract.terminated` (**новое**) |
| Завершение исполнения | `contract.completed` | прямой ОБЕИМ (было) | прямой ОБЕИМ (было) |
| Закрытие по гарантии | `contract.closed` | actor пуст | `contract.closed` (**новое**, обеим) |
| Старт этапа | `milestone.started` | `milestone.started` (было) | `milestone.started` (**новое**, тот же код) |
| Сдача этапа | `milestone.submitted` | — | прямой `milestone_submitted_for_acceptance` (было) |
| Приёмка / автоприёмка | `milestone.accepted` / `.auto_accepted` | было | тот же код (**новое**) |
| Отклонение этапа | `milestone.rejected` | было | тот же код (**новое**) |
| Приостановка по материалам | `milestone.suspended` | — | прямой `milestone_material_notice` (было) |
| Материалы получены | `milestone.material_received` | — | `milestone.material_received` (**новое**) |
| Работы возобновлены | `milestone.resumed` | — | `milestone.resumed` (**новое**) |
| Доказательство загружено | `evidence.received` | — | прямой `evidence_received` (было) |
| **Подтверждение аванса** | `milestone.advance_confirmed` | `milestone.advance_confirmed` (**новое**) | `milestone.advance_confirmed.counterparty` (**новое**) |
| **Подтверждение оплаты** | `milestone.payment_confirmed` | `milestone.payment_confirmed` (**новое**) | `milestone.payment_confirmed.counterparty` (**новое**) |
| **Этап оплачен (оба подтвердили)** | `milestone.paid` | `milestone.paid` (**новое**) | `milestone.paid` (**новое**, тот же код) |
| Разногласие открыто | `dispute.opened` | было | тот же код (**новое**) |
| Разногласие урегулировано | `dispute.resolved` | было | тот же код (**новое**, при авто-исходе `cap_reached` actor пуст → обеим) |
| Сообщение в чате | `message.created` | — | прямой `message.received` (было) |

**Всё ещё нет события в домене** (не дыра уведомлений, а незаконченный Э5):
выставление счёта, зачисление платежа платёжным провайдером, просрочка оплаты.
`apps.payments` пуст; среди `DeadlineKindConfig` нет платёжного вида, поэтому
«просрочка оплаты» не может даже сработать свипом. Уведомления по этим точкам
появятся вместе с моделью `Payment` (tech-spec.md §8.7).

## Последствия

- Тексты 20 новых кодов долиты во ВСЕ 29 языковых пакетов
  (`l10n/patches/adr-126-contract-actions.json` → `l10n/apply_pack_patch.py`),
  `pack_version` каждого пакета +1, `l10n/packs.lock.json` обновлён — иначе
  импорт на проде падает `PackVersionConflictError` (см. докстринг
  `lock_packs.py`).
- Строки `NotificationTemplate` — миграция
  `notifications/0014_seed_contract_action_templates` с ПУСТЫМ `body_i18n`
  (источник текста — пакет, как у 0007).
- Проекция ленты (`_FEED_TEMPLATE_TYPES`) расширена: платёжные шаблоны получают
  тип `payment` → группа `payments`, то есть вкладка «Платежи» ЛК наконец
  наполняется и тумблер `group_payments` начинает что-то глушить.
- Объём ленты у активного договора вырастает примерно вдвое. Осознанно: юрканал
  — размещение в ЛК, и «не знал о действии контрагента» дороже, чем «много
  пунктов в ленте». Гейт push/email остаётся за группами-каналами.
- Фронту новые типы уведомлений НЕ требуют работы: все новые шаблоны
  спроецированы на УЖЕ существующие типы ленты (`payment`, `negotiation`,
  `signature`, `signed`, `accepted`, `stage_submitted`, `deadline`), иконки и
  окраска для них уже есть.

## Каналы

Решение продукта 25.08, принятое вместе с этой волной: **e-mail-канал уведомлений
по умолчанию ВЫКЛЮЧЕН** (`NotificationSettings.email_enabled` default=False,
миграция `notifications/0015_email_channel_off_by_default` — только дефолт для
новых строк, существующие настройки не трогаются) — дублировать письмом каждое
уведомление расширенной ленты человек включает сам; ЛК остаётся юрканалом и
неотключаем (ADR-057), push/SMS без изменений. Мок фронта
(`web/src/mocks/notificationsDb.ts`) отдавал `email: false` с самого начала —
расходился именно бэкенд.

## Альтернативы

- **Звать `place_notification` напрямую в каждом месте services.py.** Так решены
  шесть исторических точек. Не выбрано: получатель и текст размазываются по
  четырём приложениям, а `apps.milestones`/`apps.disputes` начинают знать про
  шаблоны уведомлений. Реестр-данные держит решение в одном файле.
- **Отдельные топики вместо `payload["action"]` у правок.** Ломает историю
  Audit Vault и `apps.reputation` (см. выше).
- **Оставить подписчик неидемпотентным.** Годилось при одном уведомлении на
  событие; при трёх — нет.
