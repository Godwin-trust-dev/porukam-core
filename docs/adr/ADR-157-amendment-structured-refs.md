# ADR-157. Структурные `item_ref` протокола разногласий: оплата, этапы, материалы

**Статус:** принято (замечание владельца 2026-09-03)
**Контекст:** apps.contracts (протокол разногласий Э4.2, `propose_revision`/`accept_revision`/
`accept_all_revisions`/`apply_preapproved_alternative`), apps.milestones (фасады
`patch_milestone`/`patch_material`, новый параметр `depends_on`), apps.catalog (проверка кода
позиции каталога материалов), фронт `feat/web-search-select` (комбобокс «Что меняем»)
**Номер:** 157 — следующий свободный по сканированию `docs/adr/` во ВСЕХ ворктри: 155 занят
(`feat/milestones-start-gate`, влит), 156 — за `feat/notifications-materials-changed`
(`ADR-156-materials-changed-notification.md`, ещё не запушена). Строка добавлена в индекс
README.

## Контекст

Замечание владельца 03.09, дословно:

> «в Предложить правку нет ни типа оплаты и условий оплаты. надо чтобы были все пункты»

«Все пункты» = всё, что человек видит в «Обзоре» договора, должно быть выбираемо в правке.

Фронт (`feat/web-search-select`, `contractFields.ts::useRevisionItemOptions`) уже добавил в
комбобокс «Что меняем» секции «Оплата», «Этапы» и «Материалы» с адресами `payment.method`,
`payment.order`, `milestone.<uuid>.{title|amount|deadline|start_gate}`,
`material.<uuid>.{type|quantity|delivery_days}` — и честно пометил их `manual: true`, потому
что бэк с ними ничего не делал.

Что было по коду до этой ветки (`apps/contracts/services.py`):

- `item_ref` — свободная строка (`CharField(max_length=200)`), любой адрес принимался;
- `is_addressable_item_ref` считал адресуемыми только `title`, `other` и `form.*`;
- для остальных `_validate_revision_target` — no-op, `_revision_current_value` -> `None`
  («Было» пустое), `_apply_revision_value` -> `None`.

Итог для человека: правка «поменяем способ расчёта на наличные» проходила согласование,
получала статус `accepted`, попадала в canonical snapshot заморозки — и НЕ применялась.
Договор подписывался с прежним способом расчёта. В событии `negotiation.revised` это видно
(`"applied": false`), в интерфейсе — нет. Это хуже, чем отсутствие пункта в списке:
согласие сторон зафиксировано, а предмет договора ему не соответствует.

## Решение

### 1. Словарь адресуемых `item_ref` расширен

| `item_ref` | Куда применяется | Значение |
|---|---|---|
| `payment.method` | `Contract.payment_method` (+ производный `protected`) | код из `Contract.PaymentMethod` |
| `payment.order` | `Contract.payment_order` | код из `Contract.PaymentOrder` (ADR-151) |
| `milestone.<uuid>.title` | `Milestone.title` | непустая строка ≤ 300 |
| `milestone.<uuid>.amount` | `Milestone.amount`/`amount_currency` | Decimal-строка ≥ 0 либо пара `{"amount","currency"}` |
| `milestone.<uuid>.deadline` | `Milestone.deadline` | ISO 8601 (дата или дата-время) |
| `milestone.<uuid>.start_gate` | `Milestone.depends_on` | uuid этапа этого договора либо пусто |
| `material.<uuid>.type` | `ContractMaterial.catalog_item` | код активной позиции каталога материалов |
| `material.<uuid>.quantity` | `ContractMaterial.quantity` | число > 0 |
| `material.<uuid>.delivery_days` | `ContractMaterial.delivery_days` | целое ≥ 0 |

Грамматика структурного адреса — `<сущность>.<uuid>.<поле>`, разбор в
`parse_structured_ref()`. Плоские `payment.*` — потому что оплата это поля самого
`Contract`, идентификатор им не нужен.

**Почему `start_gate` — это `depends_on`.** «Условие старта» этапа по ADR-155 состоит из трёх
условий (договор подписан / материалы заказчика переданы / финансовое условие выполнено), и
все три ВЫВОДЯТСЯ из фактов — договориться о них правкой нельзя, `gate_status()` их считает.
Единственная задаваемая сторонами часть условия старта — от какого этапа этот зависит
(`Milestone.depends_on`), её и адресует `start_gate`.

### 2. Проверка — на ПРЕДЛОЖЕНИИ, а не на применении

`_validate_revision_target` (зовётся из `propose_revision`, `counter_revision` и
`create_preapproved_alternative`) для структурного адреса:

1. резолвит цель ЧЕРЕЗ фасад `apps.milestones.selectors`
   (`find_contract_milestone`/`find_contract_material`) и требует, чтобы она принадлежала
   ЭТОМУ договору — иначе `422 revision_item_unknown`;
2. чистит значение по грамматике поля — иначе `422 revision_value_invalid` с кодом поля
   (`invalid_choice`, `not_applicable`, `currency_mismatch`, `negative`, `not_positive`,
   `not_a_leaf`, `self_reference`, `unknown_catalog_item`, `required`, `invalid`,
   `max_length`).

Одна и та же функция `_clean_structured_value` зовётся и на проверке, и на применении — тот
же приём, что у `_clean_title_value` (ADR-123): «принято, но не применилось» и «принято и
упало 500 на применении» одинаково недопустимы.

Отдельные запреты, стоящие внимания:

- **`prepayment` не пройдёт** — способа с таким кодом больше нет (ADR-155), справочник
  `Contract.PaymentMethod` его не содержит, отдельной проверки не потребовалось;
- **порядок оплаты у займа** — `422 not_applicable` (`payment_order_applicable`, ADR-151:
  у займа лист-этап сам является денежным траншем);
- **сумма у ветки** — `422 not_a_leaf`: ветки только группируют, суммы задаются на ЛИСТЬЯХ
  (tech-spec.md §6.1); тот же инвариант, что у БД-триггера `milestone_amount_guard`;
- **чужая валюта** — `422 currency_mismatch`: валюта в пределах договора одна
  (`assert_single_currency`).

### 3. Применение — через фасады, в одной транзакции

`_apply_revision_value` получил параметр `user` (тот, кто ПРИНИМАЕТ правку) и для
структурного адреса зовёт `apps.milestones.services.patch_milestone`/`patch_material` — те
же функции, что и прямая правка стороной, с тем же стражем `_assert_editable`
(draft/under_review — ADR-155 §7 «пока договор редактируется, материалы тоже»). Прямой
записи в чужие модели нет: CLAUDE.md — приложения общаются через `services.py`-фасады.

Всё внутри `@transaction.atomic` принимающей функции: непроходящее значение откатывает
транзакцию целиком, предложение остаётся `open`. Доменные отказы фасада
(`StructureNotEditableError`, `MilestoneAmountGuardError`, …) переводятся в
`RevisionValueInvalidError` — снаружи это 422 с полем, а не 500.

В событии `negotiation.revised` у применённой правки теперь `"applied": true` и
`"field": "<item_ref>"`.

`patch_milestone` получил параметр `depends_on`. У него `None` — законное ЗНАЧЕНИЕ («условия
старта нет»), поэтому «не менять» несёт часовой `UNSET`, а не `None` как у остальных полей.
Проверки: чужой договор, сам на себя, кольцо в цепочке предшественников
(`MilestoneDependsOnInvalidError`).

### 4. Инвариант «сумма листьев = сумма договора» — держится сам

Отдельного «объявленного итога» у договора в схеме НЕТ: сумма договора ВЫЧИСЛЯЕТСЯ из
дерева (`apps.milestones.services.total_leaf_amount`, тот же расчёт отдаёт
`ContractSerializer.total_amount`). Значит правка суммы листа двигает сумму договора ровно
на свою дельту по построению — доводить дерево вторым действием не нужно, и «правка суммы
этапа = правка суммы договора» не отдельное решение, а следствие схемы.

Что реально требуется охранять — единственную валюту дерева (проверяется на предложении) и
правило «сумма только на листе» (`not_a_leaf`). Инвариант дельты закреплён property-based
тестом (Hypothesis) на произвольных наборах сумм и произвольном выбранном листе.

После заморозки версии правок нет вообще: `_assert_negotiating` отвечает
`409 invalid_negotiation_transition` — подписанный договор неизменяем (CLAUDE.md), изменения
только через Amendment.

### 5. Правки материалов — в хронике ДОГОВОРА

`apps.contracts.events.NESTED_TOPICS` пополнен тремя топиками
`milestone.material_added/updated/removed`. Это сознательное исключение из правила «в хронику
договора — только ключевые точки, построчный шум остаётся в ленте сущности»: ДО ПОДПИСАНИЯ
материалы входят в текст договора и в хеш замороженной версии, значит их правка — не рабочий
шум, а изменение предмета сделки, и вторая сторона должна видеть её в ленте договора, а не
только открыв этап.

Подписи — те же ключи `ui.timeline.milestone.material_*`, которыми ADR-156 подписал хронику
ЭТАПА: один смысл — один ключ, дублировать формулировку на 29 языков нечего. Ключи долиты
патчем формата ADR-095 (`l10n/patches/adr-157-contract-timeline-materials.json`), значения
идентичны патчу ADR-156 — при мёрже двух веток `apply_pack_patch.py` не перезаписывает
существующее, а расхождения значений не возникнет.

Payload трёх событий дополнен `milestone_title` — той же правкой, что в
`feat/notifications-materials-changed`: событие самодостаточно, за названием этапа не нужно
ходить в БД ни уведомлению, ни хронике.

### 6. Обратная совместимость

Неизвестный `item_ref` — по-прежнему свободная текстовая правка: принимается, хранится,
входит в snapshot, при принятии НЕ применяется (`"applied": false`). Это касается и
неизвестного ПОЛЯ известной сущности (`milestone.<uuid>.color`), и битого uuid
(`milestone.abc.amount`) — `parse_structured_ref` возвращает `None`, а не бросает: иначе
выкатка сломала бы предложения, заведённые до этой ветки, и адрес `other`-подобного вида.

## Последствия

- Правка, о которой стороны договорились, теперь ДЕЙСТВИТЕЛЬНО меняет договор — по всем
  пунктам, которые видны в «Обзоре».
- Часть значений фронт сегодня шлёт не в том виде, который принимает бэк (см. «Что доделать
  фронту» ниже) — до этого такие правки молча не применялись, теперь на них будет честная
  422 с кодом поля.
- Событие `milestone.updated`/`milestone.material_updated` при принятии правки публикуется с
  актором — тем, кто ПРИНЯЛ, а не тем, кто предложил. Это верно юридически (изменение внёс
  тот, чьё решение его применило), но означает, что в хронике этапа рядом стоят
  `negotiation.revised(accepted)` и `milestone.updated` от одного лица.
- Правка `material.<uuid>.type` меняет позицию каталога, сохраняя строку материала (историю
  `handed_over_*`/`received*`) — тот же выбор, что у `patch_material` в ADR-155.

### Что доделать фронту (`feat/web-search-select`)

1. `material.<uuid>.type` — виджет `string` (свободный текст, `current: item.description`)
   заменить на выбор из каталога материалов (`GET /v1/material-catalog`), отправлять КОД
   позиции; «Было» бэк теперь отдаёт кодом.
2. `milestone.<uuid>.start_gate` — виджет `text` с сырым `depends_on_id` заменить на выбор
   этапа договора (список листьев + пункт «нет условия»), отправлять uuid либо пустую строку.
3. Снять `manual: true` со всех девяти адресов — бэк их применяет; текст «правку применяют
   стороны руками» из окна правки убрать.
4. `milestone.<uuid>.amount` — «Было» приходит парой `{"amount","currency"}`, а не строкой.

## Проверено

- `apps/contracts/tests/test_revisions_structured.py` — 61 тест: каждый адрес и каждый запрет
  отдельным тестом, применение к `Contract`/`Milestone`/`ContractMaterial`, событие
  `applied: true`, «принять все», встречная редакция, заранее одобренная альтернатива,
  неизвестный адрес как раньше, 409 после подписания, хроника договора, property-based
  инвариант суммы листьев.
- `apps/milestones/tests/test_services.py` — `depends_on` в `patch_milestone` (установка,
  снятие, «не менять», сам на себя, чужой договор, кольцо) и `milestone_title` в событиях
  материалов.

## Ссылки

- ADR-123 — правки v2 (`form.*`/`title`/`other`, применение принятой правки)
- ADR-151 — `Contract.payment_order`
- ADR-155 — гейт старта этапа, упразднение `payment_method=prepayment`, правка материалов
  до подписания
- ADR-156 — уведомление о правках материалов в согласовании (те же l10n-ключи хроники)
- ADR-095 — патчи l10n-пакетов
- ADR-134 — хроника договора, `kind` и подписи из паков
- tech-spec.md §6.1 (дерево этапов), §8.4 (протокол разногласий)
