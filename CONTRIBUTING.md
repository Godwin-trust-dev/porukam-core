# Contributing

Pull requests are welcome. Porukam is free to use, and the code is open under the Apache License 2.0.

Note: `main` here is synchronised by snapshots from the maintainers' main repository, and an accepted pull request is carried over into that repository, so it is not lost by the next snapshot.

## Set up

See "Run locally" and "Tests and lint" in the [README](README.md). Backend commands run from `backend/` through `uv`; the root `Makefile` forwards `up`, `migrate`, `run`, `test`, `lint`, `fmt` to `backend/Makefile`. Database invariants (CHECK, EXCLUDE, triggers) are tested on a live PostgreSQL, not on SQLite.

## Branches and commits

- Branch from the latest `main`. Suggested names: `feat/<django-app>` for backend, `feat/web-<topic>` for frontend, `chore/<topic>` for docs and infrastructure.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`.
- Comments may be in Russian where they use domain terms; new public text (README, API messages, docs under `docs/en/`) in English.
- Never commit secrets. Settings come from environment variables; `.env` is ignored by git.
- Migrations that are already applied are never edited, add a new one.

## Developer Certificate of Origin (DCO)

Every commit must be signed off to certify the [DCO](https://developercertificate.org/):

```bash
git commit -s -m "fix: short description"
```

This adds a `Signed-off-by: Name <email>` line. There is no CLA.

## Before opening a pull request

1. `make test` passes.
2. `make lint` is clean (ruff, mypy strict, import-linter).
3. For frontend changes: `npm test`, `npm run typecheck`, `npm run lint:terms`, `npm run lint:i18n`.
4. Every FSM transition and every prohibition has its own test. Money and the milestone tree have property-based tests (Hypothesis).
5. A new architectural decision comes with a file `docs/adr/ADR-NNN-<topic>.md` in the same pull request. Take the next free number after scanning open pull requests.

## Code layout rules

- Each backend app has the layers `api/` (thin DRF views and serializers) → `services.py` (use cases: transactions, invariants, events) → `selectors.py` (reads) → `models.py`. No business logic in serializers, views or signals.
- Apps do not import each other's models. They call `services.py` facades and publish domain events through the transactional outbox. Django signals are not used for business logic.
- Import boundaries are checked by `import-linter` (see `backend/pyproject.toml`).

## Key invariants

1. A signature is always made on the `integrity_hash` of a frozen `ContractVersion`. A signed contract is immutable; changes go through an `Amendment`.
2. Money is always a pair `(amount: Decimal, currency)`. There is no default currency anywhere. Amounts in the API are strings.
3. The milestone tree: branches group, leaves are accepted and paid. The sum of leaves equals the contract amount. Maximum depth is 6.
4. Domain deadlines are rows in the database, processed by a sweep every minute, not delayed Celery tasks.
5. Money and signature `POST` endpoints require an `Idempotency-Key`. Webhooks are idempotent.
6. No soft delete of legally significant entities. Personal data is erased only by crypto-shredding (envelope encryption).
7. Audit Vault is a separate append-only database with a hash chain.

## Terminology

The platform models contracts for a result (work, acceptance), not labour relations. Do not use words of the employment domain in code, API, UI or docs, in any language. Use: projects, orders, contractors, clients, parties, work. The list of avoided terms is in [docs/en/glossary.md](docs/en/glossary.md) and is enforced by `npm run lint:terms`.

## Conduct and security

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in public issues.

## Operator identity in legal texts

Operator identity in the legal texts (`l10n/packs/*.json`) is a placeholder (`[OPERATOR NAME]`); a deployment must set its own.
