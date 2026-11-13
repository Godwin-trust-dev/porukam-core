# ADR-178. Уведомления — только по действиям контрагента: убираем самоуведомление актора

- Статус: принято
- Дата: 2026-09-11
- Ветка: `feat/notifications-counterparty-only`
- Отменяет частично: ADR-126 §1 (реестр `NOTIFICATION_TOPIC_TEMPLATES` — «актор
  события»)
- Связано с: ADR-057 (ЛК как юрканал уведомлений), ADR-064 (outbox-реле,
  at-least-once), ADR-098 (самодостаточный payload уведомления), ADR-156
  (окно схлопывания правок материалов), ADR-162 (автостарт этапа)

## Контекст

Владелец, дословно (11.09): «уведомления должны приходить только по
действиям контрагентов, не моих. Сейчас сыпется всё. Много, утомляет.»

ADR-126 (25.08) завёл ДВЕ аудитории на одно доменное событие:

- `NOTIFICATION_TOPIC_TEMPLATES` — карточка САМОМУ АВТОРУ действия («ваше
  действие зафиксировано») примерно на 30 топиков: `negotiation.*`,
  `contract.signed`, `milestone.started/accepted/rejected/payment_confirmed/
  paid`, весь контур `dispute.*`/`warranty.*`/`amendment.*`;
- `NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES` — та же история второй стороне.

Размещением занимался `apps.notifications.subscriber.handle_event`: получателя
«аудитории актора» он брал как `payload["notify_user_id"] or event.actor.
user_id` — то есть при отсутствии явного адресата (а он не был указан НИ У
ОДНОГО из ~30 топиков выше) подставлял самого автора действия. В результате
человек получал карточку (+ пуш и письмо по настройкам) на КАЖДОЕ своё
действие по договору — отправил на согласование, подписал, принял этап,
подтвердил оплату, открыл спор, отклонил допник и так далее. Отсюда «сыпется
всё».

Отдельно нашлись ДВА места с той же болезнью вне реестров — прямые вызовы
`place_notification`, где маршрутизирующий пользователь и получатель могли
СОВПАДАТЬ: `apps.contracts.services.route_signatory`/
`route_amendment_signatory` — для person-стороны (`list_signatories`)
единственный подписант её собственный `user`, то есть маршрутизирующий часто
и есть подписант, и «попросил подписать» превращалось в «попросил сам себя».

И третье — скрытый источник ложных self-нотификаций: `apps.milestones.
services.finalize_acceptance` для системных событий БЕЗ реального актора
(автоприёмка по свипу, приёмка по исходу спора) искусственно подставлял
заказчика fallback-актором в поле `actor` outbox-события — единственно ради
того, чтобы прежний реестр «актора» (требовавший явный `actor.user_id`) вообще
доставил уведомление. Побочный эффект: `milestone.auto_accepted` — системное
событие, не «моё действие» — было видно ТОЛЬКО заказчику, хотя это факт,
касающийся обеих сторон в равной мере.

## Решение

### 1. Реестр актора сужен до адресных уведомлений

`NOTIFICATION_TOPIC_TEMPLATES` переименован в
`NOTIFICATION_TOPIC_ADDRESSEE_TEMPLATES` и очищен от всех строк, которые жили
только ради самоуведомления. Из ~30 строк остались 4 — те, где получатель
ЗАВЕДОМО НЕ автор действия, а явный адресат в `payload.notify_user_id`:

- `entity.claimed` — claim юрлица: получатель совпадает с актором по факту
  (`_apply_claim` кладёт `notify_user_id` явно), но карточка нужна как
  юридическая квитанция и якорь проверочного дедлайна
  (`apps.notifications.tests.test_subscriber`), а не как напоминание о своём
  действии — исключение сознательное, не лазейка;
- `group.join_requested` / `group.invited` / `group.request_approved` —
  события объединений, адресат — лидер группы / приглашённый, ВСЕГДА не сам
  actor (отсмотр 2026-08-23).

Убраны строки (полный список): `negotiation.sent`, `negotiation.revised`,
`negotiation.frozen`, `negotiation.signed`, `contract.signed`,
`milestone.started`, `milestone.accepted`, `milestone.auto_accepted`,
`milestone.rejected`, `dispute.opened`, `dispute.resolved`,
`milestone.payment_confirmed`, `milestone.paid`, `payment.cancelled`,
`dispute.fix_requested`, `dispute.fix_resubmitted`, `dispute.responded`,
`dispute.window_contested`, `dispute.discount_proposed`,
`dispute.discount_declined`, `warranty.claim_submitted`,
`warranty.claim_declined`, `warranty.fix_submitted`,
`warranty.claim_satisfied`, `warranty.claim_contested`,
`amendment.rejected`, `amendment.withdrawn`.

Техническая часть — `apps.notifications.subscriber.handle_event`: получателем
адресного уведомления теперь считается ТОЛЬКО явный
`payload["notify_user_id"]`; `event.actor.user_id` в этой роли больше не
используется (фолбэк убран целиком, а не просто перестал понадобиться —
регресс-тест `test_addressee_registry_does_not_fall_back_to_actor` фиксирует
это на уровне подписчика, а не только через опустевший реестр). Актор для
исключения из списка получателей КОНТРАГЕНТСКОГО реестра — по-прежнему
`event.actor.user_id` (реальный автор действия), это отдельная, не
затронутая величина.

### 2. Общие для обоих реестров коды не пострадали

Топики вроде `dispute.*`, `warranty.*`, `amendment.rejected/withdrawn`,
`milestone.accepted`, `contract.signed` и другие, где текст нейтрален к точке
зрения («Этап принят», а не «Ваш этап принят»), были заведены на ОДИН код
шаблона в обоих реестрах. Удаление строки из адресного реестра не трогает
одноимённую строку в `NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES` — она
доставляется контрагенту, как и раньше. Итог для таких кодов: тот, кто
совершил действие, свою же карточку больше не видит; тот, кто узнаёт о
действии контрагента, — видит.

### 3. Прямые вызовы `place_notification`: подписи самому себе

`apps.contracts.services.route_signatory` и `route_amendment_signatory`
теперь пропускают размещение `signature_requested`, когда `signatory.id ==
user.id` (маршрутизирующий и подписант — одно лицо). Остальные прямые вызовы
(`contract.completed`, `milestone_submitted_for_acceptance`,
`warranty.fix_submitted` заказчику, `milestone_material_notice`,
`evidence_received`, `message.received`) уже адресовали получателя, отличного
от актора, — правок не потребовалось.

### 4. Автоприёмка и приёмка по исходу спора — событие БЕЗ актора, обеим сторонам

`apps.milestones.services.finalize_acceptance` больше не подставляет
заказчика fallback-актором в outbox-событие `milestone.accepted`/
`milestone.auto_accepted`, когда реального `actor_user` нет (автоприёмка по
свипу, приёмка по исходу спора). Раньше фолбэк был нужен только затем, чтобы
угодить прежнему реестру «актора», требовавшему явный `actor.user_id`; теперь
событие честно публикуется БЕЗ актора и уходит ОБЕИМ сторонам через
`NOTIFICATION_TOPIC_COUNTERPARTY_TEMPLATES` (пустой актор = никто не исключён
из сторон договора) — оно и есть в перечне системных событий ADR-126,
адресуемых обеим сторонам («свип дедлайнов, автоприёмка, авто-исход спора»),
а не «моё действие» одной стороны. Как следствие, при `payment_order=
before_start` авто-расчёт `milestone.paid`, сцепленный с автоприёмкой,
тоже честно публикуется без актора и доходит до обеих сторон.

### 5. Системные события и общие двусторонние факты — без изменений

Не тронуты (и не должны быть тронуты): дедлайн-свип, авто-исход спора,
`payment.created`/`payment.overdue`, `warranty.claim_auto_satisfied` — они
живут ТОЛЬКО в реестре контрагента и адресуются обеим сторонам при пустом
акторе, потому что это не «моё действие», а факт, который случился сам.
`contract.completed` — прямой вызов ОБЕИМ сторонам, тоже не «моё действие», а
двусторонний факт завершения исполнения. Окно схлопывания правок материалов
(ADR-156, `_handle_materials_change`) и так адресовало только контрагента —
подтверждено тестами `test_actor_does_not_notify_himself` /
`test_draft_changes_are_silent`, без изменений кода.

## Что решили НЕ делать

**Оставить своё действие в ленте тихо (без пуша/бейджа/письма), а не убрать
совсем.** Отклонено: владелец выбрал «убрать совсем» — история своих действий
и так видна в хронике договора/этапа, а лента уведомлений должна отвечать на
один вопрос «что от меня хотят», а не дублировать журнал произошедшего.

**Полное протягивание фильтра до `_handle_materials_change` и системных
топиков.** Не нужно: тот код и так строил окно ТОЛЬКО для контрагента правки
(ADR-156), а системные топики и так адресуются обеим сторонам при пустом
акторе — это не предмет жалобы владельца.

## Последствия

- Объём ленты у активного договора возвращается к «действие контрагента»
  вместо «действие контрагента + моё же действие» — примерно в два раза
  меньше карточек на активную сделку (обратный эффект ADR-126 «Объём ленты
  у активного договора вырастает примерно вдвое»).
- `NotificationTemplate`/l10n-пакеты НЕ чистятся: коды, переставшие
  использоваться реестром (`negotiation.sent`, `negotiation.frozen` как код
  для актора, `negotiation.signed`, `dispute.fix_requested` и другие в роли
  «своей» карточки — там, где второй реестр использует ДРУГОЙ код с суффиксом
  `.counterparty`/`.proposed` и т.п.), продолжают рендерить УЖЕ размещённые
  исторические уведомления в ленте (`selectors._FEED_TEMPLATE_TYPES` ключуется
  кодом на строке `Notification`, не топиком) — новых событий с этими кодами
  просто больше не будет.
- `apps/l10n/tests/test_packs_coverage.py` требует перевод только по кодам из
  ОБОИХ действующих реестров — коды, ушедшие из первого реестра, продолжают
  быть переведены (наследие), просто требование о переводе с них снято, если
  их нет больше нигде.
- Миграции не нужны: реестры — данные в `config/settings/base.py`, не БД.

## Тесты

- `apps/notifications/tests/test_subscriber.py` —
  `test_addressee_registry_does_not_fall_back_to_actor` (регресс на сам
  фолбэк), `test_dict_registry_explicit_none_suppresses_notification`
  переписан на явный `notify_user_id`.
- `apps/notifications/tests/test_contract_action_coverage.py` — платёжный
  контур и `negotiation.sent`: актор НЕ получил, контрагент получил;
  дедупликация пересчитана на одно уведомление вместо двух.
- `apps/notifications/tests/test_wiring_e2e.py` — сквозной сценарий целиком
  переписан на «контрагент получил, актор — нет», включая доказательство,
  что автоприёмка (без фолбэка на заказчика) доходит до ОБЕИХ сторон.
- `apps/notifications/tests/test_feed_subjects.py` — тест обогащения payload
  переставлен на контрагента; тест пакетной подгрузки аватара переставлен на
  сторону, у которой после ADR-178 остаётся несколько карточек одного
  договора.
- `apps/contracts/tests/test_amendment_close.py`,
  `apps/disputes/tests/test_notifications.py`,
  `apps/disputes/tests/test_discount.py`,
  `apps/warranty/tests/test_services.py` — каждый тест вида
  `..._notifies_both_sides` на действие С АКТОРОМ переписан на
  «актор не получил / контрагент получил»; тесты на системные события без
  актора (`dispute.cap_reached`, `dispute.window_expired`,
  `warranty.claim_resolved` через auto-исход) оставлены как «обеим».
