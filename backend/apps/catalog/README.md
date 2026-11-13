# apps.catalog

Нижний слой: `Currency` (ISO 4217, tech-spec.md §5.2.5 ревизия 2.0.3, сид RUB)
и `ContractTypeCatalogItem` (закрытый список типов договоров, ADR-058,
tech-spec.md §6.6, docs/catalog-v2.md — сид Р1 клиентского дерева).
`services.compute_segment` — фасад сегментации (ADR-058) для будущего
apps.contracts; `services.resolve_service_contract_type_code` — автовыбор
кода в ветке «Услуга» по статусу исполнителя.
`Sphere`/`MaterialCatalogItem`/`ChecklistTemplateItem` (Э4.3,
docs/tasks/etap-4.md) — механизм рекомендаций чек-листа по материалам
(ADR-047) для apps.milestones; `selectors.recommended_checklist_template_items`.
Сид — минимальный набор (7 сфер-плейсхолдеров из apps.contracts.forms,
пара позиций материалов для «ремонта»); полное наполнение всех 17 сфер —
отдельный контентный трек (П-03/Б9, docs/contract-forms.md §8 п.1).

`name_i18n`/`description_i18n` EN (ГВ.5, docs/tasks/global-wave.md, ADR-075)
— механизм + текущий реальный набор (7 типов Р1, 7 сфер, 4 пункта
чек-листа), не полное наполнение (то же «отдельный контентный трек», текст
«начисто» придёт позже). `ChecklistTemplateItem.description_i18n` — НОВОЕ
поле рядом с `description`, не взамен (тот остаётся ключом сида и читается
apps.milestones напрямую).

`ClauseTemplate` (country_code, block_code, text, legal_anchors) — текст
пункта договора по К/V-блоку конструктора (`apps.contracts.forms.
FormField.kv_block`), per-контур; сейчас засеян только `country_code=
"GLOBAL"` (legal_anchors пустые — юрсилу не заявляем), RU — отдельный,
ещё не начатый трек генерации юртекста. `selectors.assemble_clauses(
country_code, block_codes)` — выборка пунктов договора для набора блоков.

Ни от кого не зависит (import-linter).
