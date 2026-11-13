# apps.identity

`IdentityVerification` (provider-код, level, `verified_full_name_encrypted`
+ envelope-шифрование, `verified_attributes` jsonb, status, verified_at/
expires_at) — подтверждённая, а не заявленная, личность; отдельно от
`user.full_name_encrypted` (apps.accounts). Протокол
`IdentityVerificationProvider` (`providers.py`, ADR-052) + единственная
реализация — `FakeEsiaProvider` (детерминированный: код авторизации сам
кодирует `"ФИО|ИНН"`).

Флоу (`services.py`): `build_authorize_url()` — state+PKCE (code_verifier)
кладутся в Redis на TTL 5 мин, клиенту отдаётся только `authorize_url` и
`state`; `complete_verification()` — сверяет state, зовёт
`apps.accounts.services.set_verified_identity()` (единственный
санкционированный мутатор `verification_level`/`personal_tax_id_hash`),
пишет `IdentityVerification`, публикует `identity.verified` в outbox.

Гейт progressive KYC (`permissions.py::require_verification`, tech-spec.md
§7.4 п.1) — DRF permission-фабрика, поднимает `403 verification_required`
с требуемым уровнем в `context`. Сейчас применён к одному демонстрационному
эндпоинту (`api/views.py::VerificationGateDemoView`) — переиспользуется
дальше: claim (3.4), лимиты SigningAuthority (3.5).

Реализовано по docs/tasks/etap-3.md §3.2. Решение: docs/adr/ADR-062
(фейк-ЕСИА, PKCE-флоу, единственный мутатор в apps.accounts).
