# apps.authority

Полномочия (tech-spec.md §5.2.2, §8.2; domain-model.md §4; docs/tasks/etap-3.md 3.5).

- `Representative` — операционный доступ (низкий риск), пресеты
  `Role -> Permission`, проверки ТОЛЬКО по `permissions`.
- `SigningAuthority` — право подписи (высокий риск): `is_valid_now()`
  перепроверяет МЧД по фейк-реестру (`providers.FakePoaRegistryProvider`)
  для `notarized_poa`/`chained_delegation`; `grant_signing_authority`
  запрещает `manual_review` для форм с разделённой собственностью
  (`BusinessEntity.has_separated_ownership()`, ADR-004) и проверяет ФИО
  директора для `registry_verified_director`
  (`apps.entities.services.director_full_name_matches`).
- `ContractAssignment` — модель + `services.assign_to_contract`/
  `revoke_assignment`, БЕЗ HTTP-эндпоинта (tech-spec не описывает путь;
  реально заработает в apps.evidence). `contract_id` — plain UUID, без FK
  (apps.contracts не существует до этапа 4).
- Гейт `apps.entities.services.assert_entity_operable()` — на выдаче
  представительства и права подписи (тот же список ADR-042, что и
  `update_business_entity` из 3.4).
- `apps.entities.services.dispute_claim()` зовёт
  `revoke_all_signing_authorities()` при возврате карточки директору
  (отложенный импорт — во избежание цикла с `apps.entities.services`,
  которая, наоборот, импортируется здесь напрямую).

Эндпоинты §8.2: `GET/POST /business-entities/{id}/representatives`,
`PATCH/DELETE .../representatives/{rid}`, `GET/POST .../signing-authorities`,
`DELETE .../signing-authorities/{sid}`.

См. `docs/adr/ADR-074-authority-profiles.md`.
