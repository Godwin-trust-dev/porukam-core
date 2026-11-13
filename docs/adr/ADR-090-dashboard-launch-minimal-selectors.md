# ADR-090. `apps.dashboards`: минимальный дашборд запуска — только «требует моего действия» (новая cross-cutting агрегация); «мои сделки» на экране — переиспользование уже реального `GET /v1/contracts`, не второй агрегат тех же данных

**Статус:** принято
**Дата:** 2026-08-17
**Контекст этапа:** `docs/tasks/Задача_feat_dashboard-real-api.md` — `apps.dashboards` не
имел `api/urls.py` вообще (0 роутов, подтверждено
`docs/tasks/audit-web-api-contract-sweep-report.md` §2 «Дашборд»); фронт
(`features/dashboard/api.ts`, `GET /v1/dashboard?role=&period=`) целиком на
моке. Первый экран после входа. `docs/plan.md` относит `dashboards` к этапу 8
(«чистые селекторы, каждый элемент с action-ссылкой») — здесь этот этап
реализуется для дашборда впервые.

## Контекст

Мок-контракт (`DashboardData` в `packages/core/src/api/types.ts`) — богатый
агрегат: полоса «внимание», список договоров, денежная панель с процентами
и периодом (`day/week/month/halfyear`), карточка хранения доказательств,
лента активности. Ничего из этого не подкреплено реальными моделями:
денежные «заработано/получено/ожидается за период» потребовали бы агрегации
платежей — `apps.payments` не существует вообще; «хранение доказательств» —
`apps.evidence`/`audit_vault` не считают такую метрику; лента активности по
сути дублирует `GET /v1/notifications`. Постановка задачи прямо ограничивает
объём: «мои сделки» + «что требует моего действия», без графиков/периодов.

**Находка, изменившая план по ходу реализации.** На момент постановки задачи
предполагалось, что «мои сделки» на дашборде придётся строить с нуля тем же
приёмом, что `attention` — новый read-агрегат в `apps.dashboards`. Проверка
текущего `main` (аудит был проведён ДО мержа `redesign/contracts-execution-
flow-real-api`, `-phase-signing`, PR #94–95) показала, что это уже не так:
`GET /v1/contracts` (`apps.contracts.api.views`, `ContractSerializer`) —
давно реальный, `ContractsListPage.tsx` (`web/src/features/contracts/
realApi.ts`, `useRealContractsList`) уже показывает список «мои сделки» по
живым данным: статус через `realStatus.ts` (`realCardStatus`/`bucketOf` —
НЕТРИВИАЛЬНАЯ логика свёртки `execution_status`/`negotiation_status`,
докстринг прямо помечен «общая логика… не дублируем»), имя контрагента —
`useOwnProfileSettings(profile_id)` на строку (`GET /v1/profiles/{id}`,
ADR-087), способ оплаты — `PAY_LABEL_KEY` по реальным 5 значениям
`Contract.PaymentMethod`. Это ТОТ ЖЕ архитектурный приём, что ADR-088
решение 1 закрепило для карточки договора: «вид собирается НА КЛИЕНТЕ
композицией из раздельных реальных вызовов, не один агрегатный ответ».

## Решения

1. **`GET /v1/dashboard` отдаёт ТОЛЬКО `attention`.** «Мои сделки» на экране
   дашборда — переиспользование уже существующего `useRealContractsList()`
   (компонент `RealContractRow`, вынесенный из `ContractsListPage.tsx` в
   `web/src/features/contracts/RealContractRow.tsx` — тот же приём ADR-088,
   применённый к самой странице: композиция на клиенте из раздельных РЕАЛЬНЫХ
   источников, не второй бэкенд-агрегат тех же данных под другим путём).
   Рассмотрено и отклонено: собственная секция `contracts` в `/v1/dashboard`
   с сервер-стороны вычисленными `status`/`counterparty`/`progress`/`amount`.
   Отклонено, потому что:
   - `status` пришлось бы либо отдавать СЫРЫМ `execution_status`/
     `negotiation_status` (тогда фронту нужен ВТОРОЙ маппинг рядом с
     `realCardStatus` — `pending_start`/`closed`/`warranty` не совпадают с
     `ContractCardStatus` 1:1, ИМЕННО класс ошибки, который аудит и искал:
     «эндпоинт есть, но форма ответа расходится»), либо дублировать
     `realCardStatus` логику НА БЭКЕНДЕ (два места одной и той же свёртки —
     `realStatus.ts` буквально документирует «не дублируем» о ДРУГОЙ
     фронт-странице, заводить дубликат вопреки этому в третьем месте не
     имеет смысла);
   - имя контрагента сервер-стороны (селектор `_display_name` через
     `apps.accounts.selectors.get_full_name`/`entity.short_name`) работало
     бы ИНАЧЕ, чем уже принятый клиентский приём
     `useOwnProfileSettings(profile_id)` — два способа получить одно и то же
     имя в одном приложении, без выгоды;
   - `progress`/`amount` — реально дёшевы через `apps.milestones.selectors`
     (`children_map`/`computed_amount`/`is_leaf`), но раз статус и имя всё
     равно приходится брать с реального `/contracts`, оставлять на дашборде
     ЧАСТИЧНО пересчитанный второй объект контракта (одни поля оттуда, одни
     отсюда) хуже, чем взять контракт целиком из одного места.

   Итог: `apps.dashboards` реализует РОВНО ту агрегацию, которой раньше
   нигде не было — «что требует моего действия по всем моим сделкам разом»
   (`SignatureRequest`/`Milestone` cross-cutting queries, ни `apps.contracts`,
   ни `apps.milestones` такого готового среза не отдают). «Мои сделки» на
   экране — не новый бэкенд-код, а видимость уже готового.

   Форма ответа:
   ```json
   {
     "attention": [
       {
         "id": "signature:<uuid>",
         "kind": "signature" | "acceptance" | "submission",
         "side": "customer" | "contractor",
         "contract_id": "<uuid>",
         "title": "<заголовок договора/этапа>",
         "deadline_at": "2026-08-20T10:00:00Z" | null
       }
     ]
   }
   ```
   `action_label`/`route` НЕ отдаются — фронт строит их локально по `kind`
   (таблица enum → i18n-ключ + маршрут, тот же приём, что `FEED_ICON` в
   старой `DashboardPage.tsx`) — презентация остаётся на фронте.

2. **`attention` — три типа, ровно те, что перечислены в задаче, каждый —
   существующий, уже реализованный переход/статус, БЕЗ новых моделей:**
   - `signature` — `SignatureRequest.objects.filter(signatory=user,
     status=PENDING)` (и по договору, и по допнику — тот же ресурс,
     фильтр по `signatory` не различает раунд намеренно: «ждёт моей подписи»
     верно для обоих).
   - `acceptance` — листья (`children__isnull=True`, domain-model.md §7.1:
     принимаются только листья) в статусе `UNDER_ACCEPTANCE` на договорах,
     где я — сторона `CUSTOMER`.
   - `submission` — листья в статусе `IN_PROGRESS` на договорах, где я —
     сторона `CONTRACTOR` («в работе на моей стороне» — честная, не
     завышающая срочность метка; отдельного «пора сдавать» флага в модели
     нет, `IN_PROGRESS` — весь диапазон между гейтом старта и сдачей).
   Дедлайн (`deadline_at`) для `acceptance` — `apps.milestones.selectors.
   acceptance_window_status` (уже существует); для `signature` —
   `SignatureRequest.expires_at`; для `submission` — `Milestone.deadline`
   (сырое поле).

   `side` — не читается лишним запросом: у `acceptance`/`submission` она
   КОНСТАНТНА самим смыслом действия (принимает только `CUSTOMER`, сдаёт
   только `CONTRACTOR`, domain-model.md §7/§7.1); у `signature` — уже
   загруженное поле `SignatureRequest.side`. Позволяет переиспользовать на
   фронте существующий `AttentionCard` (`@porukam/ui`) с его бейджем
   «Заказчик/Исполнитель» без изменений компонента — тот же UX-сигнал, что
   был у мок-версии «единая полоса, сторона показана на карточке».

3. **Прямой импорт `apps.contracts.selectors`/`apps.milestones.selectors` из
   `apps.dashboards.selectors`, БЕЗ `import_string`-композиции ADR-086.**
   ADR-086 использовал `import_string` там, где import-linter ЯВНО запрещает
   статический импорт (`apps.accounts` → `apps.social`). Для `apps.dashboards`
   такого запрещающего контракта нет и не планируется в обратную сторону —
   `apps.dashboards` архитектурно верхний слой («только selectors поверх
   остальных», CLAUDE.md; `docs/plan.md` этап 8), никто не имеет права
   импортировать `apps.dashboards` в ответ. Обходить несуществующий барьер
   `import_string` было бы искусственным усложнением без выгоды.

   **Формальный import-linter-контракт «`apps.dashboards` — только
   `.selectors`» рассмотрен и НЕ заведён.** `ForbiddenContract` в
   `importlinter` по умолчанию проверяет импорты ТРАНЗИТИВНО
   (`allow_indirect_imports=False`) — запрет `apps.contracts.models` для
   источника `apps.dashboards` сработал бы не только на прямой импорт, но и
   на легитимную цепочку `apps.dashboards.selectors → apps.milestones.
   selectors → apps.contracts.models` (сам `apps.milestones.selectors`
   импортирует `apps.contracts.models` ради типа `Contract` — это ЕГО
   собственная, давно существующая и корректная зависимость, а не нарушение
   границ дашбордом). Инструмент не различает «дашборд импортирует чужую
   модель напрямую» и «дашборд импортирует чужой селектор, у которого своя
   внутренняя зависимость» — контракт был бы либо постоянно красным, либо
   потребовал `ignore_imports` на каждую внутреннюю зависимость milestones/
   contracts, что обесценивает саму проверку. Дисциплина
   (`apps.dashboards.selectors` импортирует ТОЛЬКО `... import selectors as
   ..._selectors` чужих приложений, никогда их `.models`/`.services`)
   остаётся конвенцией кода, без отдельного автоматического контракта.
   Комментарий-заглушка в `backend/pyproject.toml` про «этап 8» оставлен как
   есть — формальный контракт по-прежнему не имеет практичной формы, а не
   «ещё не наступил срок».

4. **`role`/`period` из мок-контракта убраны целиком, не просто
   проигнорированы.** `period` — некому обслуживать (нет денежной аналитики
   по периодам). `role` фильтровал бы `contracts`, которых в этом ответе
   больше нет вообще — фильтровать нечего. Фильтрация «мои сделки по роли»
   уже есть на `/contracts` (`useRealContractsList({ role })`,
   `ContractsListPage.tsx`) — дашборд использует ту же функцию без изменений.

5. **Навигация из карточки внимания — на `ContractDetailPage`
   (`/contracts/{id}`), НЕ на специализированные `AcceptancePage`/
   `StagePage`.** Проверено по факту: `SigningPage.tsx` (`/contracts/{id}/
   sign`) уже реальная (`useRealContract`, redesign phase-signing, PR #95) —
   `kind="signature"` ведёт туда. `AcceptancePage.tsx`
   (`/contracts/{id}/milestones/{mid}/accept`) и `StagePage.tsx`
   (`/contracts/{id}/stages/{sid}`) — ВСЁ ЕЩЁ на старом мок-агрегате
   (`features/acceptance/api.ts`/`features/stageExecution/api.ts`,
   `useAcceptanceApi`/`useStageExecution`, ждут отдельную задачу — та же
   ветка `redesign/contracts-execution-flow-phase-stages-evidence`, не
   смёржена на момент этого ADR). Скормить им РЕАЛЬНЫЙ `milestone.id` из
   `apps.dashboards` было бы тихой поломкой (страница ждёт мок-форму данных,
   не найдёт нужную запись в `stageExecutionDb`/`acceptanceDb`) — честнее
   и безопаснее вести на уже-реальную страницу договора, откуда пользователь
   продолжит тем, что реально работает сегодня. `kind="acceptance"` и
   `kind="submission"` оба ведут на `/contracts/{contract_id}`.

6. **`apps.dashboards` добавлен в `INSTALLED_APPS`** (`backend/config/
   settings/base.py`, после `apps.reputation` — читает данные обоих
   контекстов; порядок в списке приложений на миграции не влияет, `apps.
   dashboards` их не имеет, но логическая позиция «после источников чтения»
   зафиксирована по тому же принципу, что уже применён к `apps.reputation`).

## Не рассматривалось / отложено

- **Денежная панель, периоды, карточка хранения доказательств, лента
  активности** — прямо исключены постановкой задачи.
- **Собственная секция `contracts` в `/v1/dashboard`** — рассмотрена и
  отклонена, см. решение 1 (не второй агрегат тех же данных).
- **`RoleSwitch` на дашборде** — убран вместе с секцией `contracts`: дашборд
  показывает КОРОТКИЙ превью-срез всех моих сделок (без фильтра по роли),
  «Все сделки» ведёт на `/contracts`, где фильтр по роли уже есть и работает.
- **Пагинация/лимит на `attention`** — не введена (тот же недо-объём, что у
  `list_my_contracts`, уже без пагинации используется в проде); при реальном
  росте данных — отдельная задача.
- **Отдельный счётчик `attention` в ответе** — не заведён: секция уже
  массив, `.length` фронт посчитает сам.

## Последствия

- Backend: `apps/dashboards/{selectors,api/*}.py` — только `attention`,
  никакого `_contract_total`/`_display_name`/`progress` кода (тот, что был
  написан на первом проходе реализации, до этой находки, — удалён).
- Фронт: `packages/core/src/api/types.ts` — `DashboardData`/`DashboardPeriod`/
  `DashboardSide`/`DashboardMoney`/`DashboardEvidence`/`DashboardFeedKind` и
  весь их шлейф заменены узким `DashboardAttentionItem`/`DashboardAttentionKind`/
  `DashboardResponse`. `useDashboard()` — без параметров вовсе (было
  `role`/`period`).
- `web/src/pages/DashboardPage.tsx` — переписана: полоса «внимание» (новый
  `GET /v1/dashboard`) + короткий превью-срез `useRealContractsList()`
  (первые N по `-created_at`, тот же порядок, что бэк уже отдаёт) через
  вынесенный `RealContractRow`; `PeriodFilter`/`MoneyPanel`/
  `EvidenceStorageCard`/`ActivityFeed`/`RoleSwitch` больше не используются
  этой страницей (компоненты `@porukam/ui` не удаляются — могут
  понадобиться другим экранам).
- `ContractsListPage.tsx` — импортирует `RealContractRow`/`STATUS_LABEL_KEY`/
  `PAY_LABEL_KEY` из нового `features/contracts/RealContractRow.tsx` вместо
  локально определённых — поведение и разметка не меняются, только источник
  импорта (0 визуальных изменений на `/contracts`).
- Моки: `web/src/mocks/dashboardDb.ts`/`dashboardHandlers.ts` переписаны под
  новый узкий контракт, вычисляют `attention` из уже существующего
  `realContractsDb` (signature-requests + milestones мок-стора) — тот же
  приём, что бэкенд-селекторы, но на TS. Старый `dashboardDb.ts` (богатый
  seed-набор с деньгами/фидом) удалён.
