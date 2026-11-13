# ADR-096: Business-подписание — SigningAuthority в контуре подписания договора

- Статус: принят
- Дата: 2026-08-18
- Связано: domain-model.md §4 (SigningAuthority), §8 (подпись); tech-spec.md §8.4 (signatories);
  etap-3.md 3.5 (authority-profiles); etap-4.md Э4.4 (подписание); ADR-088 (контур сделки)

## Контекст

`apps.authority` (Representative, SigningAuthority, ContractAssignment + грант/отзыв/`is_valid_now`/
`can_sign_amount`) давно в main, но контур подписания её не использует: `apps.contracts.services.
list_signatories` живёт по правилу Р1 — «для business-стороны список подписантов пуст» (с устаревшим
комментарием «SigningAuthority ещё не смёржен»). Итог: подписание от юрлица невозможно вовсе —
пользователь упирается в честный, но тупиковый блок UI. Сеамы под интеграцию заготовлены заранее:
`SignatureRequest.signing_authority_id` (свободный UUID, NULL) и `Signature.signature_basis`
(сейчас пишется грубое `"business"`).

## Решение

Интеграция на трёх точках контура, доменная логика — в `apps.authority` (фасад), `apps.contracts`
только вызывает (границы: import-linter contracts запрещает лишь payments/disputes).

1. **`apps.authority.services.eligible_signatories(entity_id, *, amount, poa_provider)`** — новый
   фасад: действующие права подписи юрлица (`is_valid_now` — с перепроверкой МЧД-оснований по
   реестру), проходящие по лимиту суммы (`can_sign_amount`; `amount=None` — фильтра по сумме нет,
   см. п.5). По одному праву на пользователя — «сильнейшее» действующее основание в порядке
   `registry_verified_director > notarized_poa > chained_delegation > manual_review`.
   Провайдер реестра МЧД — по образцу `DEFAULT_TIMESTAMP_PROVIDER`: модульный
   `DEFAULT_POA_PROVIDER = FakePoaRegistryProvider()` в `apps.authority.providers`, инъекция
   параметром (реальной интеграции с ФНС МЧД нет и не планируется — CLAUDE.md «интерфейсы + фейки»).

2. **`list_signatories`** (contracts): для business-стороны — `eligible_signatories` юрлица стороны
   с `amount` = сумме договора (`total_leaf_amount`); элементы несут `authority_id` (внутренний
   ключ; `SignatoryOptionSerializer` наружу по-прежнему отдаёт только `user_id`/`basis` — API-шейп
   не меняется, `basis` теперь настоящий код основания вместо невозможного ранее случая).
   Person-сторона — без изменений.

3. **`route_signatory` / `route_amendment_signatory`**: выбранный подписант обязан быть в списке
   (как раньше), и его `authority_id` фиксируется в `SignatureRequest.signing_authority_id` —
   какое именно основание маршрутизировано, юрзначимый след. Для допника лимит проверяется по
   ИТОГОВОЙ сумме с учётом дельты (`total + amount_delta`, `compute_amendment_deltas`) — подписант
   авторизует новую сумму договора, не старую.

4. **`sign` / `sign_amendment`**: перед созданием `Signature` право перепроверяется —
   `apps.authority.services.assert_can_sign(authority_id, amount, poa_provider)` (domain-model.md §4:
   МЧД-основания перепроверяются ПРИ КАЖДОМ подписании — доверенность могла быть отозвана между
   маршрутизацией и подписью). Невалидность → `SigningAuthorityNoLongerValidError` → HTTP 409
   `signing_authority_invalid`. `Signature.signature_basis` = код основания (`registry_verified_
   director`/…), `entity_snapshot` дополняется слепком права (`signing_authority: {id, basis,
   poa_registry_id}`) — «что именно видел/предъявлял подписант», проверяемо постфактум.

5. **Сумма неизвестна** (пустое дерево — договор ещё не заморожен): фильтр по лимиту не применяется,
   список информационный. Это не дыра: маршрутизация и подпись возможны только ПОСЛЕ заморозки
   (FSM), где дерево непусто — обе точки перепроверяют лимит по реальной сумме.

## Последствия

- Подписание от business-профиля работает: директор/поверенный в пределах лимита подписывает,
  вне лимита или с отозванной МЧД — не проходит (422 на маршрутизации, 409 на подписи).
- Фронт правок не требует: `SigningPage` уже показывает список и честный блок при пустом
  (`rc-business-blocked-1` в моке остаётся валидным сценарием «прав нет»).
- `signing_authority_id` остаётся свободным UUID (не FK) — как заложено моделью; миграций нет.
- Выбор «сильнейшего» основания при нескольких правах одного пользователя — server-side
  детерминизм; выбор конкретного основания подписантом в UI — вне волны (не нужен для запуска).
