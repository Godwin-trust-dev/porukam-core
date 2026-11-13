# apps.disputes

Разногласия, окна оспаривания, инструменты диалога (tech-spec.md §4, §5.2.7,
§8.8; domain-model.md §11; ADR-017/018/019/020, ADR-131).

## Что здесь

- `Dispute` — разногласие по этапу (`kind=milestone`, единственный вход —
  отклонение приёмки с пунктом чек-листа и доказательством, ADR-017) либо по
  гарантии (`kind=warranty`, открывается фасадом из `apps.warranty`).
- `FixRequest` — раунды исправления, **максимум два** (`409
  fix_rounds_exhausted`; БД-инвариант `dispute_fix_rounds_within_cap`).
- `DiscountAgreement` — скидка = **допник** с `MODIFY_MILESTONE` через общий
  контур подписания `apps.contracts` (§8.6). Принятие = две подписи под
  допником, а не отдельная кнопка. Анти-waiver §20.3 уходит в payload
  изменения, то есть в подписываемый снимок.
- `DisputeReply` — реплики `POST /disputes/{id}/respond` (карточка спора,
  поле `replies`); ответ стороны — юрзначимое заявление (ADR-019), поэтому
  своя строка, а не поиск по outbox. Не переход FSM.
- `DisputeWindow` — окна оспаривания (ADR-019): ответ по разногласию и
  оспаривание расторжения исполнителем (ADR-028). Тайм-аут — строка
  `apps.deadlines.DomainDeadline` со `starts_from=cabinet_placement`
  (ADR-057: отсчёт от размещения уведомления в ЛК).
- Потолок 30 дней (ADR-020) — тот же реестр дедлайнов, свип раз в минуту.

## Границы

`apps.disputes` **никогда** не вызывает `apps.milestones.services`: любое
действие над этапом (вернуть в приёмку после исправления, принять по исходу)
едет через outbox и подписчиков `apps.milestones.handlers`. Прямой вызов
протащил бы транзитивный запрет import-linter
`apps.contracts -> apps.milestones -> apps.disputes`.

Обратные направления тоже событийные: спор открывается подписчиком на
`milestone.rejected`, скидка закрывает спор подписчиком на `contract.amended`,
окно расторжения открывается подписчиком на `contract.terminated`.
