# ADR-131. Этап 7: контур разногласий (раунды, скидка-допник, окна, потолок) и гарантия

- Статус: принято
- Дата: 2026-08-25
- Ветка: `feat/disputes`
- Связано с: ADR-017 (отклонение только с пунктом чек-листа), ADR-018 (медиация
  без юрсилы), ADR-019 (односторонние утверждения открывают окно, а не
  налагают последствие), ADR-020 (потолок спора 30 дней), ADR-028 (два
  сценария расторжения), ADR-029/030 (гарантийный срок и отдельная метрика
  обращений), ADR-048/075 (контур допников), ADR-057 (ЛК как юрканал и якорь
  дедлайнов), ADR-064 (outbox-реле, at-least-once), ADR-072 (свип доменных
  дедлайнов), ADR-098 (самодостаточный payload), ADR-126 (матрица
  «действие → событие → уведомление»)

## Контекст

Э4.6 оставила `apps.disputes` заглушкой: модель `Dispute` с двумя статусами,
открытие спора подписчиком на `milestone.rejected` и авто-исход `cap_reached`
по дедлайну. Не было ничего из того, ради чего этап 7 вообще существует:
раундов исправления, скидки допником, окон оспаривания, гарантийных заявок.
`apps.warranty` был README-заглушкой без единой строки кода.

Плюс находка отсмотра 25.08: раздел «Споры» на фронте доставал вторую сторону
из кэша `GET /contracts` — `DisputeSerializer` отдавал только `contract_id`.

## Решение

### 1. FSM разногласия — четыре состояния, `resolve` из любого незакрытого

| Переход | Из | В | Кто | Событие |
|---|---|---|---|---|
| `request_fix` | `open` | `awaiting_fix` | заказчик | `dispute.fix_requested` |
| `resubmit_fix` | `awaiting_fix` | `open` | исполнитель | `dispute.fix_resubmitted` |
| `propose_discount` | `open` / `awaiting_fix` | `awaiting_discount` | любая сторона | `dispute.discount_proposed` |
| `decline_discount` | `awaiting_discount` | `open` | вторая сторона | `dispute.discount_declined` |
| `resolve` | `open` / `awaiting_fix` / `awaiting_discount` | `resolved` | сторона либо система | `dispute.resolved` (+ `dispute.cap_reached`) |

`resolve` объявлен из ВСЕХ незакрытых состояний, потому что потолок 30 дней и
согласие сторон приходят в любой момент диалога; из `resolved` он не объявлен
вовсе — повторное закрытие даёт `409 dispute_already_resolved`.

Ответ второй стороны (`respond`) переходом FSM НЕ является: это реплика, она
закрывает окно ответа, но состояния не меняет. Иначе «ответил» и «исправил»
попали бы в один граф и перестали различаться.

### 2. Два раунда исправления — потолок в БД, а не только в сервисе

`Dispute.fix_rounds_used` + `CHECK (fix_rounds_used <= 2)` +
`FixRequest(dispute, round)` с `UNIQUE` и `CHECK (round BETWEEN 1 AND 2)`.
Третий раунд — `409 fix_rounds_exhausted`, код из tech-spec.md §8.8 дословно.

Раунд — ПАРА действий: заказчик просит (`requested_at`), исполнитель сдаёт
(`resubmitted_at`). Сдача возвращает этап в `under_acceptance` и **заново**
открывает окно приёмки (новый дедлайн `milestone_acceptance` со
`starts_from=cabinet_placement` + размещение уведомления заказчику). Без
этого повторная приёмка шла бы без таймера и усиленной серии напоминаний —
то есть автоприёмка после исправления не наступила бы никогда.

### 3. Скидка = допник, принятие = подпись, а не кнопка

`POST /disputes/{id}/discount-proposal` создаёт `Amendment` с одним
изменением `MODIFY_MILESTONE` и сразу отправляет его на согласование. Дальше
работает ОБЩИЙ контур §8.6 (заморозка → маршрутизация подписантов → две
подписи), `apply_amendment` меняет сумму листа, публикуется
`contract.amended`, и подписчик `apps.disputes.handlers` закрывает спор
исходом `discount_accepted`.

Отдельной кнопки «принять скидку» НЕТ сознательно: иначе появилось бы два
источника правды о том, вступила ли скидка в силу — строка
`DiscountAgreement` и статус допника, — и они бы разошлись на первой же
ошибке доставки. `decline` при этом есть: отказ не требует подписи.

**Инвариант «сумма листьев = сумма договора» держится сам собой.** Отдельной
строки «сумма договора» в схеме нет: `effective_terms`/`total_leaf_amount`
считают её ПО ЛИСТЬЯМ (докстринг `apps.contracts.services.effective_terms`:
«total_amount — ЖИВАЯ сумма»). Значит изменение листа допником и есть
изменение суммы договора; отдельного пересчёта не нужно, и тест это
фиксирует (`test_signed_discount_amendment_lowers_leaf_and_resolves_dispute`).

**Анти-waiver §20.3** («скидка закрывает только указанный дефект») лежит в
`AmendmentChange.payload["anti_waiver"]` — то есть в замороженном снимке,
который стороны подписывают, а не только в строке `DiscountAgreement`.

**Фасад в `apps.contracts`.** Знание «скидка выражается MODIFY_MILESTONE с
ключами amount/currency плюс анти-waiver» — знание договорного контура,
поэтому оно живёт в `contracts.services.create_discount_amendment`, а
`apps.disputes` его вызывает. Направление законно: import-linter запрещает
только обратное (`contracts` → `disputes`).

Скидка применима ТОЛЬКО к разногласию по этапу: у гарантийного спора листа
нет, а принятый лист удешевить допником и так нельзя
(`AmendmentTargetsAcceptedMilestoneError`).

### 4. Окна оспаривания — ADR-019 буквально

`DisputeWindow(kind, contract, dispute, subject_ref, deadline_id, contested)`.
Два вида: `dispute_response` (ответ на открытое разногласие) и
`termination_notice` (оспаривание расторжения ИСПОЛНИТЕЛЕМ, ADR-028 —
расторжение заказчиком безусловно и окна не требует).

Три исхода, ровно поле `contested bool NULL` спеки:
- **не оспорено в срок** (`contested=false`, свип) → факт зафиксирован,
  событие `dispute.window_expired`. Именно фиксация, НЕ санкция: спор не
  закрывается, этап никуда не переходит;
- **оспорено** (`contested=true`) → автоматических последствий нет, вопрос
  уходит в диалог;
- **снято досрочно** (`closed_at` есть, `contested` остаётся NULL) — спор
  урегулирован раньше срока, оспаривать нечего. Поэтому CHECK формулируется
  как «исход ⇒ закрыто», а не «закрыто ⇔ исход».

**Якорь окна.** Дедлайн окна создаётся `starts_from=cabinet_placement` и
лежит на субъекте СОБЫТИЯ (`dispute` / `contract`), а не на самом окне:
`place_notification` якорит незаякоренные дедлайны того же субъекта
(ADR-057), и если повесить дедлайн на `dispute_window`, якорить его было бы
нечем — окно никогда бы не начало тикать.

Известная неточность, принятая осознанно: уведомление `dispute.opened`
уходит и актору, и контрагенту в одной волне реле, и якорит окно ПЕРВОЕ из
двух размещений (актора). Разница — доли секунды в пределах одной доставки;
разводить это отдельным «только для отвечающей стороны» шаблоном ради
миллисекунд дороже, чем стоит.

Окно материалов отдельной строкой `DisputeWindow` НЕ дублируется: оно уже
живёт дедлайном `milestone_material_notice` (Э4.6,
`apps.milestones.services.raise_material_problem`). Заводить вторую
сущность на тот же факт значило бы держать два источника правды.

### 5. Потолок 30 дней (ADR-020) доведён

Свип закрывает спор из ЛЮБОГО состояния исходом `cap_reached` и публикует
ОТДЕЛЬНОЕ событие `dispute.cap_reached` рядом с `dispute.resolved` — тем же
приёмом, что `contract.completed` рядом с `contract.warranty_started` (док 31
§7: самостоятельный неизменяемый исход для репутационной карточки).

Денежная часть ADR-020 выполняется без отдельного кода: принятые листья
живут своим `accepted → paid`, а спорный остаётся `disputed` — потому что
`apps.milestones.handlers` возвращает этап в `accepted` ТОЛЬКО для исходов
диалога (`accepted`/`withdrawn`/`discount_accepted`), а `cap_reached` и
`escalated_to_court` в этот список не входят.

### 6. Два поля исхода вместо одного

tech-spec.md §5.2.7 требует `outcome CHECK (in resolved|cap_reached|
escalated_to_court)`. Но `resolution_type` уже читают
`apps.milestones.handlers` и `apps.reputation.subscriber`, и сузить его до
трёх значений спеки нельзя без потери смысла (`accepted` и `withdrawn` — это
разные факты, оба `resolved`). Поэтому: `resolution_type` — детальный код,
`outcome` — классификация спеки с CHECK-констрейнтом, соответствие —
таблица `RESOLUTION_OUTCOME`. CHECK «закрытый спор имеет исход и дату,
открытый — ни того ни другого» не даёт им разъехаться.

### 7. Гарантия — отдельное приложение, общий диалоговый контур

`apps.warranty.WarrantyClaim` (таблица `warranty_claim` из §5.2.7) —
самостоятельное приложение, а не таблица в `apps.disputes`. Причина не
организационная, а доменная: **претензия и разногласие по-разному живут в
репутации**. Спор идёт в две оси карточки (ГВ.4), претензия — в СВОЙ
счётчик и рейтинг задним числом не пересчитывает (ADR-030). Одна таблица на
оба факта означала бы «помни, что вот этот Dispute в рейтинг не считается» —
ровно тот вид неявного знания, который через полгода ломается.

При этом ДИАЛОГ один: претензия открывает `Dispute(kind=warranty)` через
фасад `disputes.services.open_warranty_dispute`. У такого спора нет ни
этапа, ни пункта чек-листа (работы приняты и оплачены, претензия — к
результату договора целиком), поэтому:

- `Dispute.contract` — новое обязательное поле (у гарантийного спора
  `milestone` пуст, а договор нужен всегда);
- CHECK `dispute_kind_subject_consistent`: `kind=milestone` ⇒ этап и пункт
  заполнены; `kind=warranty` ⇒ оба пусты;
- триггер `dispute_milestone_contract_guard` — «этап из этого договора» и
  «пункт из этого этапа». CHECK такое выразить не может (ссылка на другую
  таблицу), тот же случай и тот же приём, что `milestone_amount_guard`,
  включая `USING ERRCODE = '23000'` ради `IntegrityError`.

Гарантийный ПЕРИОД новым кодом не обрастает: он уже реализован Э4.6 —
`complete_execution` публикует `contract.warranty_started` и заводит дедлайн
`contract_warranty`, свип переводит `warranty → closed`. Претензия принимается
только пока `execution_status=warranty` (`422 warranty_period_not_active`).

Исход спора закрывает претензию подписчиком `apps.warranty.handlers` на
`dispute.resolved` — а не вызовом из `apps.disputes`, иначе связка стала бы
двусторонней.

### 8. Границы приложений — всё через outbox

`apps.disputes` **никогда** не вызывает `apps.milestones.services`: прямой
вызов протащил бы транзитивный запрет
`apps.contracts → apps.milestones → apps.disputes`. Полный список
событийных стыков этапа 7:

| Событие | Подписчик | Зачем |
|---|---|---|
| `milestone.rejected` | `disputes.handlers` | открыть спор (было) |
| `dispute.resolved` | `milestones.handlers` | вернуть этап в `accepted` (было) |
| `dispute.resolved` | `warranty.handlers` | закрыть претензию (**новое**) |
| `dispute.fix_resubmitted` | `milestones.handlers` | вернуть этап на приёмку (**новое**) |
| `contract.amended` | `disputes.handlers` | закрыть спор подписанной скидкой (**новое**) |
| `contract.terminated` | `disputes.handlers` | открыть окно оспаривания (**новое**) |
| `domain_deadline.fired` | `disputes.handlers` | потолок + истечение окон (**расширено**) |

Все подписчики идемпотентны по состоянию (ADR-064, at-least-once).

### 9. `counterparty` в `DisputeSerializer`

`{profile_id, display_name, role}` второй стороны ОТНОСИТЕЛЬНО читателя,
через тот же `apps.profiles.selectors.public_display_name`, что у дашбордов
и репутационной карточки (`show_name=False` → `display_name: null` — это
согласие профиля, а не ошибка). Фронт перестаёт зависеть от кэша
`GET /contracts`.

## Уведомления (реестры ADR-126)

Десять новых кодов, ВСЕ нейтральны к точке зрения, поэтому один код на оба
реестра — суффикс `.counterparty` не заводится (правило именования ADR-126 §2):

`dispute.fix_requested`, `dispute.fix_resubmitted`, `dispute.responded`,
`dispute.window_contested`, `dispute.discount_proposed`,
`dispute.discount_declined`, `dispute.window_expired`, `dispute.cap_reached`,
`warranty.claim_submitted`, `warranty.claim_resolved`.

Системные события без актора (`window_expired`, `cap_reached`,
`warranty.claim_resolved`) уходят ОБЕИМ сторонам.

Осознанно НЕ маппится `dispute.discount_accepted` — такого топика нет:
подписанная скидка это исход `dispute.resolved`, второе уведомление о том же
моменте было бы дублем (граница ADR-126 §4). По той же причине
`respond_to_dispute` закрывает окно БЕЗ события `dispute.window_contested`:
о реплике уже говорит `dispute.responded`; отдельное событие остаётся за
окнами без собственной реплики (расторжение).

Тексты долиты во ВСЕ 29 пакетов
(`l10n/patches/adr-131-disputes-warranty.json` → `l10n/apply_pack_patch.py`),
`pack_version` каждого +1, `l10n/packs.lock.json` обновлён. Строки
`NotificationTemplate` — миграция
`notifications/0017_seed_dispute_warranty_templates` с пустым `body_i18n`.
Новых ТИПОВ ленты не появляется: всё спроецировано на существующие
(`dispute` → группа «Разногласия», `deadline`, `stage_submitted`).

## Длительности окон

`dispute_response_window` и `termination_dispute_window` — 7 суток,
`DeadlineKindConfig` (данные, не константы кода). Обоснование границ: окно
обязано быть заметно короче потолка спора (30 дней — иначе ответ приходит,
когда разбирательство уже закрыто) и заметно длиннее окна приёмки/материалов
(48 ч — там сторона ждала действия и следит за ним, а тут утверждение
прилетает без предупреждения, и «не открывал ЛК неделю» не должно стоить
позиции). Финальные значения — предмет согласования с юристом (tech-spec.md
§11 п.4).

## Последствия и осознанные хвосты

- Отклонённое предложение скидки оставляет допник в `under_review`
  неподписанным. Отзыв допника — отдельный контур §8.6, которого в Р1 нет;
  повторное предложение заводит новый допник. Зафиксировано как хвост, а не
  забыто.
- Медиация (ADR-018, `POST /disputes/{id}/mediation`, `GET /disputes/{id}/
  experts`) и денежный расчёт расторжения по §30–31 в эту волну НЕ вошли:
  первое требует внешнего института аккредитации, второе — денежных
  операций поверх платёжного контура Э5 (ADR-130 дал волну 1 — прямой
  платёж; возвратов и перерасчётов в ней нет). Оба остаются в §8.8 как
  непокрытые строки.
- Связка `Payment.disputed` <-> `Dispute` — отдельной задачей. ADR-130
  §«dispute-статус платежа» объявил статус `disputed` без переходов и отложил
  wiring до появления контура споров; контур появился, но переходы живут в FSM
  платежа (`apps.payments`), и здесь они не делаются.
- `apps.evidence.api` теперь берёт договор из `dispute.contract`, а не из
  `dispute.milestone.contract` — иначе загрузка контрдоказательств по
  гарантийному спору падала бы на `None`.
- Объём ленты по активному разногласию вырастает: каждое действие видят обе
  стороны. Это прямое продолжение ADR-126 («не знал о действии контрагента»
  дороже, чем длинная лента).

## Дополнение 26.08 (хвосты волны 4, `feat/disputes-tails-aug26`)

- **Реплики диалога хранятся.** `POST /disputes/{id}/respond` писал текст
  ответа только в payload `dispute.responded`; карточка спора его не
  показывала. Теперь строка `DisputeReply` (`dispute_reply`, миграция
  disputes/0003), в `DisputeSerializer` — `replies[{id, author_id, comment,
  evidence, created_at}]`. Реплика по-прежнему не переход FSM.
- **Отказ по гарантийной претензии — своя кнопка.** `resolution_type=
  warranty_declined` существовал, но выбирался только через общий
  `/disputes/{id}/resolve` без проверки роли. Добавлены
  `warranty.services.decline_warranty_claim` и `POST /warranty-claims/{id}/
  decline`: только исполнитель (сторона, к которой претензия; тот же гард в
  `resolve_dispute` для этого исхода), спор и заявка закрываются в одной
  транзакции, подписчик `handle_dispute_resolved` на закрытой заявке — NOOP.
  Событие `warranty.claim_declined` публикуется ВМЕСТО `warranty.claim_resolved`
  (один момент — одно уведомление, ADR-126 §4); потребители метрики претензий
  (ADR-030) слушают оба топика. Уведомление обеим сторонам, тексты — во всех
  29 пакетах (`l10n/patches/warranty-claim-declined.json`, `pack_version` +1,
  `NotificationTemplate` — notifications/0018).

## Дополнение 26.08 (`feat/disputes-warranty-followups`): отказ от скидки закрывает допник

Решение владельца 26.08 (в6-6): «автоматически». Хвост «отклонённое
предложение скидки оставляет допник в `under_review`» закрыт.

- `decline_discount` (`POST /disputes/{id}/discount-proposals/{did}/decline`,
  тело теперь `{comment?}`) в той же транзакции вызывает фасад
  `contracts.services.reject_amendment(amendment, user=<отказавший>,
  reason=comment, cause="discount_declined")`: допник — `rejected_by_
  counterparty`, актор — отказавшая сторона (по определению вторая сторона
  допника: предложивший скидку и есть его инициатор), из заморозки — с
  аннулированием раунда подписания допника (как ручной reject). Прямой вызов,
  а не outbox: направление disputes → contracts import-linter разрешает
  (`propose_discount` уже ходит в `create_discount_amendment`).
- **Одно действие — одно уведомление (ADR-126 §4).** О моменте говорит
  `dispute.discount_declined` (обеим сторонам, как раньше; в payload добавлены
  `comment` и `amendment_rejected`). `amendment.rejected` публикуется — он
  нужен хронике допника (`GET /amendments/{id}/timeline`) и Audit Vault — но с
  `cause="discount_declined"`, и оба реестра уведомлений держат для топика
  словарь `{"discount_declined": None, "*": "amendment.rejected"}`: явный
  `None` под ключом-дискриминатором глушит уведомление
  (`apps.notifications.subscriber._resolve_template_code` теперь читает
  `payload["action"]`, иначе `payload["cause"]`; отсутствующий ключ — "*").
  Оставлен именно `dispute.discount_declined`, а не `amendment.rejected`:
  человек нажал «отказаться от скидки», и текст «Скидка отклонена»
  описывает его действие, а «Допсоглашение отклонено» — следствие. В
  обратном пути (ручной reject/withdraw допника, дополнение 26.08 к ADR-075)
  первично действие над допником — там по-прежнему звучит `amendment.*`, а
  `dispute.discount_cancelled` не маппится. Симметрия: в каждом пути
  уведомляет событие того действия, которое совершил человек.
- Подписчик `handlers.handle_amendment_closed` получает рождённый отказом
  `amendment.rejected`, находит предложение уже `declined` и выходит (та же
  NOOP-ветка, что при повторной доставке, ADR-064) — зацикливания и второго
  `dispute.discount_cancelled` нет. Повторный `decline` — 409
  `discount_already_decided`, допник остаётся отклонённым один раз.
- Следствие для фронта: после отказа от скидки допник закрыт, кнопки
  «отозвать»/«отклонить» на нём — 409 `invalid_negotiation_transition`;
  новое предложение скидки заводит новый допник.
