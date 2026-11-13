# Architecture overview

One page. Detailed specifications are in Russian: [tech-spec](../tech-spec.md), [domain model](../domain-model.md), [technical overview](../technical-overview.md). Decisions are listed in the [ADR index](adr-index.md); terms in the [glossary](glossary.md).

## Shape

A modular monolith: Django 5.2 LTS with Django REST Framework, Celery for background work, PostgreSQL and Redis. The React web app (`web/`, shared code in `packages/`) talks to the API over HTTP and WebSocket.

Three peripheral services run as separate processes on the same codebase: evidence ingest (`backend/services/evidence_ingest`), notification dispatcher (`backend/services/notification_dispatcher`) and Audit Vault (`backend/services/audit_vault`).

## Bounded contexts

Each Django app under `backend/apps/` is one bounded context, for example `accounts`, `identity`, `entities`, `authority`, `profiles`, `social`, `contracts`, `milestones`, `payments`, `evidence`, `disputes`, `warranty`, `reputation`, `notifications`, `messaging`, `catalog`, `jurisdictions`, `l10n`, `geo`, `dashboards`, `analytics`.

Dependency rules are checked by `import-linter` (`backend/pyproject.toml`). Examples:

- `catalog`, `jurisdictions`, `l10n` and `geo` are the lowest layer and import nothing from other apps.
- `social` depends only on `accounts`.
- `contracts` does not import `payments`, `disputes` or `messaging`; those subscribe to its events.
- `milestones` does not import `payments`.
- `dashboards` and `analytics` only read.

## Layers inside an app

`api/` (thin DRF views and serializers) → `services.py` (use cases: transactions, invariants, events) → `selectors.py` (reads) → `models.py`. Business logic does not live in serializers, views or signals. Django signals are not used for business logic.

## Events: transactional outbox

Apps communicate through `services.py` facades and domain events. An event is written to an outbox table in the same transaction as the state change, then a relay delivers it to subscribers. Subscribers must be idempotent.

## Audit Vault

Audit Vault subscribes to all domain events and stores them in its own database, append-only, linked by a hash chain. A daily checkpoint of the chain root is timestamped by several independent RFC 3161 time-stamping authorities. The main application has no write access to past records.

## Key invariants

- A signature is made on the `integrity_hash` of a frozen `ContractVersion`. A signed contract is immutable; changes go through an `Amendment`.
- Money is always `(amount: Decimal, currency)`, with no default currency; amounts in the API are strings.
- Milestone tree: branches group, leaves are accepted and paid; the sum of leaves equals the contract amount; depth is at most 6.
- Domain deadlines are rows in the database processed by a sweep every minute, not delayed tasks.
- Payments are confirmed by both parties; the platform does not hold funds.
- Personal data is protected by envelope encryption and erased by crypto-shredding. Legally significant entities are never soft-deleted.
- Money and signature `POST` endpoints require an `Idempotency-Key`; webhooks are idempotent.
- Tests on the database invariants run on a live PostgreSQL.
