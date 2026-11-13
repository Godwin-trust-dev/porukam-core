# apps.social

Идентичность и граф доверия (tech-spec.md §5.2.1b, §8.1b; docs/tasks/
etap-3.md 3.3 + docs/tasks/etap-3-delta-adr059.md — дельта первична при
расхождении). Зависит ТОЛЬКО от apps.accounts (import-linter).

- `Handle` — @username, user XOR group, смена освобождает старый
  (частичный уникальный индекс, история строкой).
- `Contact` — приватное ребро графа доверия (видит только owner, чужое —
  404 не 403); `source=phonebook` создаётся сверкой телефонной книги.
- `PhonebookHash` + `services.reconcile_phonebook` — сверка ТОЛЬКО против
  `discoverable_by_phone=True`; несматченные хеши удаляются в той же
  транзакции (152-ФЗ, Р8 дельты). Сырые номера — 422.
- `AddressableGroup`/`GroupMembership` — объединение-витрина, НЕ сторона
  договора, репутации не несёт.
- `Consent` — универсальная модель согласия (pd_processing/profile_public/
  phone_discoverability/reputation_history_basis — четвёртое добавлено ГВ.2),
  append-only история, `text_version` — из `settings.CONSENT_TEXT_VERSIONS`
  (теперь per-locale: `{consent_type: {"ru": ..., "en": ...}}`, ГВ.2/ADR-071).
  `services.complete_privacy_step` — шаг регистрации «Данные и приватность»
  RU (три согласия, locale по умолчанию "ru", без изменений).
  `services.complete_global_privacy_step` — тот же шаг для GLOBAL (все
  четыре, locale="en", ГВ.2). Изменение `profile_public` публикуется в
  outbox (`social.consent_recorded`) — `apps.profiles` подписан и реагирует
  сам (import-linter запрещает apps.social импортировать apps.profiles
  напрямую). `discoverable_by_phone` (apps.accounts.User) обновляется
  синхронно через facade `apps.accounts.services.set_phone_discoverability`
  — работает одинаково из обоих шагов privacy.

См. `docs/adr/ADR-067-social-consent-profile-visibility.md`,
`docs/adr/ADR-071-google-oauth-login-and-global-consents.md` (ГВ.2).
