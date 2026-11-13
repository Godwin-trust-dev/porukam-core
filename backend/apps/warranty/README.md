# apps.warranty

Гарантийные периоды и заявки (tech-spec.md §4, §5.2.7; domain-model.md §12).

Реализовано в этапе 7 (docs/plan.md, ADR-131):

- `WarrantyClaim` — претензия в течение гарантийного периода
  (`POST /contracts/{id}/warranty-claims`). **Отдельная метрика: рейтинг задним
  числом не пересчитывается** (ADR-030) — событие `warranty.claim_resolved`
  несёт `affects_reputation: false`, и `apps.reputation` эти топики не слушает.
- Диалог по претензии идёт в общем контуре разногласий: заявка открывает
  `Dispute(kind=warranty)` в `apps.disputes` через services-фасад
  (`open_warranty_dispute`), исход спора закрывает заявку подписчиком
  `handlers.handle_dispute_resolved`.
- Отказ исполнителя по претензии — `POST /warranty-claims/{id}/decline`
  (`services.decline_warranty_claim`): закрывает спор исходом
  `warranty_declined` и заявку в одной транзакции, событие
  `warranty.claim_declined` (вместо `warranty.claim_resolved` — один момент,
  одно уведомление, ADR-126 §4). Только исполнитель (`403 wrong_dispute_side`),
  только из `submitted` (`409 warranty_claim_already_resolved`).
- Сам гарантийный **период** живёт в контуре исполнения `apps.contracts`:
  `complete_execution` публикует `contract.warranty_started` и заводит дедлайн
  `contract_warranty`, свип `apps.deadlines` переводит договор
  `warranty -> closed` (`apps.contracts.handlers`). Длительность —
  `DeadlineKindConfig`, данные, а не константа кода (ADR-029: срок по
  согласованию сторон, платформа подсказывает по категории).
