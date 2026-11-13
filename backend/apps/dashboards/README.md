# apps.dashboards

Только selectors поверх остальных контекстов (чтение). Не содержит бизнес-логики
(import-linter). `GET /v1/dashboard` — минимальный дашборд запуска: «мои сделки»
+ «что требует моего действия» (подпись/приёмка/сдача этапа), read-only, без
денежной аналитики/периодов (см. ADR-090 — `apps.payments` не существует,
обслуживать нечем).

- `selectors.py` — вся сборка payload'а; прямой импорт `apps.contracts.selectors`/
  `apps.milestones.selectors` (не `import_string` — нет запрещающего
  import-linter-контракта в эту сторону, ADR-090 §4).
- `api/` — тонкий `APIView` + `Serializer[Any]` поверх словарей из `selectors.py`
  (тот же приём, что `apps.reputation.api`).

Read-only — миграций нет и не будет, пока дашборд не заведёт собственные модели.

## `GET /v1/dashboard/search` — две независимые ветки одного ответа

- `profiles`/`groups`/`spheres` (ADR-114/ADR-121/ADR-122) — адресный лукап по `q`
  (@хендл/телефон/текст сферы) с гео-зонами `world|country|city` вокруг зрителя.
- `catalog` (план 11.09 §5, ADR-184) — каталожный поиск исполнителей с явными
  фильтрами: гео на ЛЮБОМ уровне через `apps.profiles.WorkArea`
  (`apps.profiles.selectors.geo_filter_coverage_q`, без фильтра — «весь мир»),
  сферы `apps.catalog.Sphere` (заявленные ИЛИ подтверждённые завершённой сделкой
  исполнителя — `apps.reputation.selectors.contractor_sphere_deal_q`), опыт —
  порог по числу завершённых сделок исполнителем
  (`apps.reputation.selectors.contractor_completed_deals_count_subquery`).
  Фильтры между собой — И, keyset-пагинация по `(created_at, id)`. Считается,
  только если запрошен (`country`/`region`/`city`/`sphere`/`experience_min`/
  `has_experience`/`cursor`/`catalog=1`) — иначе пустой, второй запрос не тратится.
  Подробности и границы задачи — `docs/adr/ADR-184-dashboards-catalog-search-filters.md`.
