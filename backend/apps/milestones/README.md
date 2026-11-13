# apps.milestones

Дерево этапов (ветки/листья, глубина ≤ 6), ChecklistItem, ContractMaterial —
Э4.3 (docs/tasks/etap-4.md).

`Milestone.amount`/`amount_currency` — только у листьев, гарантируется
БД-триггером `milestone_amount_guard` (миграция 0002) + предварительной
проверкой в `services.py` (читаемая 422 до записи). Глубина дерева —
`selectors.level` + `MAX_TREE_DEPTH` (models.py), проверяется в
`services.create_milestone` (не декларативно в PostgreSQL — родитель та же
таблица).

`services.recommend_checklist_items` — рекомендации по материалам листа +
базовые пункты сферы через `apps.catalog.selectors` (ADR-047); ничего не
создаёт, только подсказывает. `services.materialize_loan_schedule` — для
«Займа» график возврата (`form_data.schedule`, П-16) как этапы-листья.
`services.total_leaf_amount`/`assert_leaf_sum_matches` — сервис проверки
«сумма листьев = сумма договора» для заморозки (Э4.4); сама валидация на
переходе здесь не запускается.

Редактирование структуры — только пока договор в draft/under_review
(до заморозки, Э4.4); после — `409 contract_immutable`, правки только
через допник (Э4.5, реализован — ADR-075).

`Milestone.created_by_amendment` (Э4.5) — `None` для этапов исходного
договора, FK на `apps.contracts.Amendment` для этапов, созданных допником
(происхождение видно). `services._create_milestone`/`_create_material` —
общее ядро валидации (родитель/глубина/сумма/каталог/цена) БЕЗ гейта
`_assert_editable`; `create_milestone`/`create_material` (гейт + права
пользователя) и `apply_amendment_milestone_add`/`apply_amendment_material_add`
(без гейта — вызывается ТОЛЬКО из `apps.contracts.services.apply_amendment`
на второй подписи допника, когда договор уже `signed`) переиспользуют его
одинаково, не дублируют.

## Старт листа — автоматический (ADR-162)

Гейт §6.3 — три условия (`services.gate_status`: `signed`/`materials`/
`financial` в состояниях `waiting`/`met`/`not_required`, ADR-155). Лист
входит в работу САМ, как только закрылось ПОСЛЕДНЕЕ из них:
`services._try_auto_start` вызывается в конце каждого use case, который
условие закрывает — `confirm_material_received`, `confirm_payment` (его
зовёт и `apps.payments.services._mirror_into_milestone`), а для подписи —
подписчиком `handlers.handle_contract_signed` на топик `contract.signed`
(`apps.contracts` не имеет права импортировать `apps.milestones`, поэтому
реакция здесь, а не в `sign`).

`_try_auto_start` — тихий no-op, если лист уже не `pending`, если это
ветка, или если хоть одно условие ещё `waiting`; гонка двух одновременных
подтверждений снимается `select_for_update` на строке листа. Оба пути
входа в работу идут через общее тело `_perform_start`: тот же переход
`start`, тот же `started_at`, те же события `milestone.gate_passed` /
`milestone.started`. Отличие автостарта — пустой `actor` и
`payload["auto"] = true` (и, как следствие пустого актора, уведомление
«Этап начался» уходит ОБЕИМ сторонам, ADR-126).

`services.start_milestone` (`POST /milestones/{id}/start`) остаётся —
обратная совместимость и рассинхрон клиента; идемпотентен на
`in_progress`. Дедлайнов старт листа не создаёт: окно приёмки открывает
`submit_milestone`, календарный `Milestone.deadline` задан договором.
