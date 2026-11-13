# ADR-062. Строгая идентификация: фейк-ЕСИА + гейт progressive KYC

**Статус:** принято
**Дата:** 2026-07-27
**Контекст этапа:** 3.2 (`identity`)

## Контекст

tech-spec.md §7.2/§7.4/§9.1 задаёт требования (провайдерский интерфейс
`IdentityVerificationProvider`, ЕСИА OAuth с state+PKCE, поднятие
`verification_level` до `verified`, гейт `require_verification(level)` с
`403 verification_required`), но не фиксирует конкретную реализацию флоу —
это первое приложение, реализующее строгую идентификацию, решение нужно
принять здесь. Настоящей интеграции с ЕСИА нет и не будет в рамках Р1
(CLAUDE.md: «внешние провайдеры — только интерфейсы + фейки»).

## Решение

- **`FakeEsiaProvider`** (`apps.identity.providers`) — единственная
  реализация `IdentityVerificationProvider`. Код авторизации сам кодирует
  результат верификации: `"<ФИО>|<ИНН>"` — тесты полностью управляют тем,
  что «вернёт ЕСИА», не полагаясь на внешний сервис и не требуя отдельного
  тестового режима эмуляции.
- **State + PKCE — только на сервере.** `build_authorize_url()` генерирует
  `state` и `code_verifier`, кладёт пару `{user_id, code_verifier}` в Redis
  (`django.core.cache`, TTL 5 мин) под ключом `esia:state:<state>`, в
  `authorize_url` уходит `code_challenge` (SHA-256 от verifier, base64url).
  Клиенту verifier не передаётся вообще — сервер сам инициирует и
  завершает обмен (backend — confidential OAuth-клиент, а не браузер);
  единственное, что публично — `authorize_url` и `state`.
  `complete_verification()` сверяет `state` (найден, не истёк, принадлежит
  вызывающему пользователю) и удаляет запись сразу после первого чтения —
  **state одноразовый**, включая случай, когда сам код авторизации
  оказался невалиден (повторная попытка требует нового
  `authorize-url`) — так же, как одноразовый OTP-код в ADR-061.
- **Разделение «заявлено» / «доказано».** `IdentityVerification.
  verified_full_name_encrypted` — ФИО, подтверждённое провайдером,
  отдельно от `user.full_name_encrypted` (self-service, `apps.accounts`).
  `complete_verification()` НЕ трогает `user.full_name_encrypted` —
  только `IdentityVerification` (новая запись на каждую верификацию,
  история сохраняется) и `user.verification_level`/`personal_tax_id_hash`
  через единственный санкционированный мутатор.
- **`apps.accounts.services.set_verified_identity()`** — по аналогии с
  `set_business_status()` (обещанным для `apps.entities`, 3.4):
  `apps.identity` не пишет напрямую в поля `User`, а зовёт facade в
  `apps.accounts`, которое ими владеет. `apps.accounts` при этом ничего не
  знает про ЕСИА (CLAUDE.md: «приложения общаются через services.py-
  фасады… не через прямой импорт чужих моделей» — здесь FK на `User` через
  `settings.AUTH_USER_MODEL` неизбежен, но МУТАЦИЯ полей идёт только через
  facade, не напрямую).
- **Гейт `require_verification(level)`** (`apps.identity.permissions`) —
  фабрика DRF `BasePermission`: при недостаточном уровне поднимает
  `common.api.exceptions.DomainAPIError` (403, `code=
  verification_required`, `context={"required_level": level}`) прямо из
  `has_permission()`, а не возвращает `False` — иначе DRF отдал бы
  обобщённый `permission_denied` без нужного кода и контекста
  (tech-spec.md §7.4 п.1 требует именно код и требуемый уровень в ответе).
  Применён пока к одному демонстрационному эндпоинту
  (`GET /v1/identity/verification-gate-demo`) — реальные применения:
  claim (3.4), лимиты `SigningAuthority` (3.5).

## Отклонённые варианты

- **Передавать `code_verifier` клиенту** (классический публичный PKCE-
  клиент) — отклонено: здесь backend сам ходит в ЕСИА и сам же принимает
  callback, роль публичного клиента (мобильное приложение/браузер) не
  участвует в обмене кода на токен — держать verifier только на сервере
  проще и не менее безопасно.
- **Писать `verified_full_name` сразу в `user.full_name_encrypted`** —
  отклонено: это стёрло бы разницу между тем, что человек указал сам, и
  тем, что подтвердил провайдер, а `IdentityVerification` как таблица
  истории верификаций потеряла бы смысл (нельзя было бы посмотреть, что
  именно подтвердил ЕСИА в конкретной верификации, если пользователь потом
  поменяет отображаемое имя).
- **`require_verification` как декоратор view-функции** — отклонено в
  пользу DRF `permission_classes`: так гейт единообразно комбинируется с
  `IsAuthenticated` и другими permission-классами (claim, SigningAuthority)
  без ручной обвязки в каждой view.

## Последствия

- Новая таблица `identity_verification` (миграция `apps.identity.0001_
  initial`), FK на `settings.AUTH_USER_MODEL`.
- `apps.identity` зависит от `apps.accounts` (FK на `User` + вызов
  `set_verified_identity`) — не запрещено текущим import-linter контрактом
  (только `catalog`/`jurisdictions` — нижний слой без зависимостей,
  `social` ограничен `accounts`, `contracts` не может импортировать
  `payments`/`disputes`).
- `require_verification` будет импортироваться другими приложениями
  (`entities`, `authority`) в следующих под-задачах — сознательно оставлен
  в `apps.identity`, а не в `common/`, так как понятие progressive KYC
  (уровни верификации) — домен `apps.identity`/`apps.accounts`, не общая
  инфраструктура.
