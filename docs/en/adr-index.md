# Architecture Decision Records: English index

The Architecture Decision Records (ADRs) in this repository are written in Russian. This index gives an English title and a one-line summary for each record, with a link to the original file.

Numbering note: the repository log starts at ADR-057. Earlier decisions were kept in an external log that is not published here. Detailed specifications that the ADRs refer to are also written in Russian.

| No. | Title | Summary | File |
|---|---|---|---|
| 057 | Legal notification channel | Notification delivery is counted from placement in the user's cabinet; duplicate channels and a reminder series are layered on top. | [ADR-057](../adr/ADR-057-notification-cabinet-channel.md) |
| 059 | Envelope encryption of personal data | Local envelope-encryption helper in `common/` with master and per-subject keys, so personal data can be erased by destroying keys. | [ADR-059](../adr/ADR-059-envelope-encryption-common.md) |
| 059 | Preparation package for the privacy ADR | Preparation package for the privacy ADR (completed 01.08.2026): legal framing, options, and draft consent texts used to finalize it. | [ADR-059](../adr/ADR-059_finalization_prep.md) |
| 059 | Profile privacy, discoverability and visibility | Two profile access levels (public; by direct link and in deals), explicit consent choices at sign-up with nothing pre-ticked, name and avatar visibility toggles, city-level location only, phone hashes treated as personal data and deleted if unmatched. | [ADR-059](../adr/ADR-059_privacy_findability_visibility.md) |
| 060 | Transactional outbox: minimal implementation | One outbox table written in the same transaction as the domain change; common `publish()` helper in `common/`. | [ADR-060](../adr/ADR-060-outbox-common.md) |
| 061 | Authentication: JWT and phone OTP | SimpleJWT with token blacklist for access and refresh tokens; one-time codes by phone as the login method. | [ADR-061](../adr/ADR-061-jwt-auth-otp.md) |
| 062 | Strict identification: fake provider and progressive KYC gate | A fake identity-verification provider behind a provider interface, plus a gate that raises identification requirements step by step. | [ADR-062](../adr/ADR-062-esia-fake-progressive-kyc.md) |
| 063 | Entities: reduced claim scope, fake registry, ownership epochs | Claim stays a separate entity with all seven methods in the model; flows are implemented for three (two automatic identity matches, one manual review). Fake registry provider; ownership tracked in epochs. | [ADR-063](../adr/ADR-063-entities-claim-scope-fake-registry.md) |
| 064 | Transactional outbox: relay | Relay that delivers outbox events to subscribers with attempt counters, retry timing and a published marker. | [ADR-064](../adr/ADR-064-outbox-relay.md) |
| 065 | Audit Vault | Separate process and database for the audit log: append-only, hash chain, subscribed to all events. | [ADR-065](../adr/ADR-065-audit-vault.md) |
| 066 | CD: one application image | A single application image is built in CI and run as core and celery roles; tagged by short commit hash. | [ADR-066](../adr/ADR-066-cd-image-registry.md) |
| 067 | Social: consent, phonebook matching, minimal profile | Generic consent model, hashed phonebook matching, and a minimal profile needed for visibility rules. | [ADR-067](../adr/ADR-067-social-consent-profile-visibility.md) |
| 068 | Observability | JSON logs without personal data, process-independent metrics, and degraded health reporting; legally relevant state is computed, not counted. | [ADR-068](../adr/ADR-068-observability.md) |
| 069 | Production deployment layout (lean tier 1) | Single-host Docker Compose stack with resource limits, dual TLS and continuous database backup built into the database image. | [ADR-069](../adr/ADR-069-prod-infra-lin-t1.md) |
| 070 | GLOBAL jurisdiction and fallback resolver | A fallback jurisdiction flagged in the database, enforced as unique, used when no specific jurisdiction applies. | [ADR-070](../adr/ADR-070-jurisdiction-global-fallback.md) |
| 071 | Google sign-in and GLOBAL starter consents | Google OAuth as a second login method behind a provider protocol, with English consent texts for the GLOBAL jurisdiction. | [ADR-071](../adr/ADR-071-google-oauth-login-and-global-consents.md) |
| 072 | Domain deadline registry and sweep | Deadlines stored as database rows with configurable durations and a per-minute sweep; downtime is compensated. | [ADR-072](../adr/ADR-072-domain-deadline-sweep.md) |
| 073 | Contract freeze and signing | Canonical hash of a frozen contract version; signatures address the version hash; reopening voids signatures. | [ADR-073](../adr/ADR-073-contract-freeze-signing.md) |
| 074 | Authority and profiles | Representatives, signing authority and portfolios; acting-profile header; accounts stay isolated from profiles. | [ADR-074](../adr/ADR-074-authority-profiles.md) |
| 075 | Contract amendments | Nullable amendment link next to the contract, partial unique indexes, and the same approval flow as the original contract. | [ADR-075](../adr/ADR-075-contract-amendments.md) |
| 075 | Per-jurisdiction language selection and GLOBAL clause templates | Primary locale per jurisdiction, English data, and clause templates for the GLOBAL jurisdiction. | [ADR-075](../adr/ADR-075-global-i18n-locale-clause-templates.md) |
| 076 | Reputation card read model | Reputation card built only from outbox events: profile age, deal counts, counterparties and completed deals; shown to guests. | [ADR-076](../adr/ADR-076-reputation-card-read-model.md) |
| 077 | Language pack infrastructure | Locale and language-pack models with a locale-to-English fallback, in a new lowest-layer app. | [ADR-077](../adr/ADR-077-l10n-packs-locale-fallback.md) |
| 078 | Official contract language and snapshot renders | Contract has an official language; frozen snapshot stores renders in the supported languages; explicit override is possible. | [ADR-078](../adr/ADR-078-contract-official-language-renders.md) |
| 079 | Frontend localization | JSON language packs, English as canonical source, RTL foundation and a language switcher. | [ADR-079](../adr/ADR-079-web-l10n-json-packs-en-canon-switcher.md) |
| 080 | Contract language at signing | Signing screen uses the real Accept-Language header; the language layer does not emphasize the canonical language. | [ADR-080](../adr/ADR-080-signing-language-layer-accept-language.md) |
| 081 | Checklist items: slug versioning and import | Checklist template items get stable slugs for versioning; a command imports checklist content files. | [ADR-081](../adr/ADR-081-checklist-items-versioned-slug-import.md) |
| 082 | RTL enablement (partial) | Left-to-right islands for mixed text, Latin digits for legally significant values, and a direction toggle in Storybook. | [ADR-082](../adr/ADR-082-rtl-ltr-islands-latn-digits.md) |
| 083 | Checklist translations merged at file level | Checklist translations are merged into the language-pack files rather than imported by a second pack import. | [ADR-083](../adr/ADR-083-l10n-checklists-file-level-merge.md) |
| 084 | Google Drive backup scope for evidence | The only Drive scope used is the per-app file scope; the platform keeps hash, thumbnail and metadata, not the original. | [ADR-084](../adr/ADR-084-google-drive-byo-backup-scope.md) |
| 085 | SPA served from the web server image | The web client is built inside a multi-stage web server image produced in CI, not on the host. | [ADR-085](../adr/ADR-085-nginx-spa-ci-build.md) |
| 086 | `GET /v1/users/me` handle composition | Handle and display name are composed through an import-string hook instead of a read model; the JSON key is `display_name`. | [ADR-086](../adr/ADR-086-users-me-handle-composition.md) |
| 087 | Owner profile hub against the real backend | Inventory of fields used by profile screens against the real API; tier A done, tier B deferred. | [ADR-087](../adr/ADR-087-owner-profile-settings-real-contract.md) |
| 088 | Contract and milestone screens on the real REST API | Client-side composition and a phased plan instead of a one-shot rewrite of the aggregate contract object. | [ADR-088](../adr/ADR-088-contracts-execution-flow-real-contract.md) |
| 089 | Launch surfaces in all languages | Lazy-loaded frontend packs and legal documents delivered through language packs, so onboarding and legal text match the user's language. | [ADR-089](../adr/ADR-089-l10n-launch-surfaces-lazy-packs-legal-docs.md) |
| 090 | Minimal launch dashboard | A dashboards app with selectors only; first section is items that need the user's action. | [ADR-090](../adr/ADR-090-dashboard-launch-minimal-selectors.md) |
| 091 | Catalog reference data for the contract wizard | Spheres, work types, materials, units and checklist recommendations served from the catalog app. | [ADR-091](../adr/ADR-091-catalog-wizard-real-api.md) |
| 092 | Handle prefix search | A narrow lookup endpoint by handle prefix for choosing a counterparty; it is not a people search. | [ADR-092](../adr/ADR-092-handles-prefix-search.md) |
| 093 | Reputation card on the real API | Handle-to-profile-id mapping and a defined list of fields hidden from the public card. | [ADR-093](../adr/ADR-093-reputation-card-real-api.md) |
| 094 | Contract types endpoint | Read-only `GET /v1/contract-types` returns type codes of the client-facing tree for the creation wizard. | [ADR-094](../adr/ADR-094-contract-types-endpoint.md) |
| 095 | User interface language | Interface language is an explicit user choice stored as `User.locale`, not derived from country. | [ADR-095](../adr/ADR-095-user-language.md) |
| 096 | Business signing authority | Signing authority checks are wired into the signing flow at three points; domain logic stays in the authority app. | [ADR-096](../adr/ADR-096-business-signing-authority.md) |
| 097 | Fuzzy sphere search and category localization | Pure-Python fuzzy search over spheres and localized category names. | [ADR-097](../adr/ADR-097-catalog-fuzzy-search-categories-l10n.md) |
| 098 | Notification subject and central payload enrichment | Notifications store a subject reference and get their payload enriched centrally so items are clickable. | [ADR-098](../adr/ADR-098-notification-subject-enrichment.md) |
| 099 | Desktop adaptive layout | Layout primitives in the UI package replace separate desktop screens; a single breakpoint is declared. | [ADR-099](../adr/ADR-099-desktop-adaptive-layout.md) |
| 100 | Work-type suggestions in sphere search | Sphere search also returns matching work types; one sphere is renamed. | [ADR-100](../adr/ADR-100-work-type-search-suggestions.md) |
| 101 | Delete a milestone before signing | `DELETE /milestones/{id}` is allowed only while the contract is not signed. | [ADR-101](../adr/ADR-101-milestone-delete-before-signing.md) |
| 102 | Notification feed metadata from the live contract | Feed item metadata is resolved from the current contract at read time, not stored at placement. | [ADR-102](../adr/ADR-102-notification-feed-live-context.md) |
| 103 | Profile photo | Only our own resized copy is stored; the Google picture is used as a starting value only; images are sanitized. | [ADR-103](../adr/ADR-103-profile-avatar.md) |
| 104 | Delete a contract draft | `DELETE /contracts/{id}` returns 204 for drafts only; other states return a conflict error. | [ADR-104](../adr/ADR-104-contract-draft-delete.md) |
| 105 | Schema-driven forms for rent and loan | One renderer driven by the backend form schema replaces separate hand-written essence forms. | [ADR-105](../adr/ADR-105-schema-driven-forms-rent-loan.md) |
| 106 | Deal contacts from the draft | Counterparties become saved contacts from the draft stage, through outbox events carrying party ids. | [ADR-106](../adr/ADR-106-deal-contacts-from-draft.md) |
| 107 | Web session survives reload | Auth tokens are persisted in local storage so a page reload does not log the user out. | [ADR-107](../adr/ADR-107-web-session-persistence.md) |
| 108 | 60-minute access token and refresh rotation grace | Access token lifetime raised from 15 to 60 minutes; a grace window is added for refresh-token rotation. | [ADR-108](../adr/ADR-108-refresh-rotation-grace.md) |
| 109 | Stages and Payments dashboard sections | Cross-contract read-only aggregates for the Stages and Payments sections, kept in the dashboards app. | [ADR-109](../adr/ADR-109-dashboard-sections-stages-payments.md) |
| 110 | Web Push channel | First real duplicate notification channel: push subscriptions stored in the notifications app. | [ADR-110](../adr/ADR-110-web-push-channel.md) |
| 111 | Email channel | Email provider implementation behind the existing provider protocol, used as a duplicate notification channel. | [ADR-111](../adr/ADR-111-email-resend-channel.md) |
| 112 | Contract chat | New messaging bounded context: messages are tied to a contract and kept as part of the deal record. | [ADR-112](../adr/ADR-112-messaging-contract-chat.md) |
| 113 | WebSocket for chat | WebSocket delivery runs on ASGI in addition to polling, not instead of it. | [ADR-113](../adr/ADR-113-chat-websocket.md) |
| 114 | Search section: people and groups, geo zones v1 | Read-only cross-aggregate search of people and groups by handle, with geographic zones. | [ADR-114](../adr/ADR-114-search-geo-zones.md) |
| 115 | Portfolio project photo | One cover photo per portfolio project, stored as a photo key on the existing model. | [ADR-115](../adr/ADR-115-portfolio-project-photo.md) |
| 116 | Collaboration inquiry | Negotiations start from a minimal contract draft, with no new entities; chat stays tied to a contract. | [ADR-116](../adr/ADR-116-collaboration-inquiry.md) |
| 117 | Groups v2 | Group types, mandatory sphere, geography, links, logo, mandatory handle and anonymous public view. | [ADR-117](../adr/ADR-117-groups-v2.md) |
| 118 | Groups v2 in the web client | Creation form with hints, public group card, and groups shown in the header. | [ADR-118](../adr/ADR-118-web-groups-v2.md) |
| 119 | Auth endpoints ignore stale bearer tokens | Login and refresh endpoints do not authenticate by bearer token; standard errors use the client's language. | [ADR-119](../adr/ADR-119-auth-endpoints-ignore-stale-bearer.md) |
| 120 | Portfolio v2 | Gallery of up to 5 photos, mandatory completion date, and editing of projects. | [ADR-120](../adr/ADR-120-portfolio-v2-gallery.md) |
| 121 | Search by sphere | People found by deal facts and groups found by sphere and geography; extends search v1. | [ADR-121](../adr/ADR-121-search-by-sphere.md) |
| 122 | Declared spheres in a profile | A person can declare up to 10 spheres of activity in the profile. | [ADR-122](../adr/ADR-122-profile-spheres.md) |
| 123 | Revisions v2 | Addressable `item_ref`, current value shown as "was", applying an accepted revision, and an "other" option. | [ADR-123](../adr/ADR-123-revisions-apply.md) |
| 124 | Signing stage actions | One "Sign" button, return for rework, and rejection without opening a dispute. | [ADR-124](../adr/ADR-124-signing-stage-actions.md) |
| 125 | Generated evidence thumbnail | If the camera embeds no preview, the thumbnail is generated from the sanitized bytes that are hashed. | [ADR-125](../adr/ADR-125-evidence-generated-thumbnail.md) |
| 126 | Action-to-event-to-notification matrix | Two registries map contract actions to events and notifications, including a second audience and the payment flow. | [ADR-126](../adr/ADR-126-notification-event-matrix.md) |
| 127 | Edit and delete checklist items | `PATCH` and `DELETE /checklist-items/{id}` are allowed before signing. | [ADR-127](../adr/ADR-127-checklist-item-patch-delete.md) |
| 128 | Group portfolio | Portfolio of projects for groups, following the personal portfolio v2 model. | [ADR-128](../adr/ADR-128-group-portfolio.md) |
| 129 | Web actor context | A group becomes a full actor in the shell header and the interface changes with the selected actor. | [ADR-129](../adr/ADR-129-web-actor-context.md) |
| 130 | Payments, wave 1: direct payment with two-sided confirmation | Working payments app for one method; Payment is the source of truth and milestone marks mirror it. | [ADR-130](../adr/ADR-130-payments-direct-two-sided.md) |
| 131 | Disputes and warranty | Four-state dispute FSM with rounds, a discount amendment, time windows and a cap; warranty claims. | [ADR-131](../adr/ADR-131-disputes-warranty-etap7.md) |
| 132 | Advance cancellation is forbidden | A payment of kind advance cannot be cancelled; the service returns a conflict error. | [ADR-132](../adr/ADR-132-payments-advance-cancel-forbidden.md) |
| 133 | Warranty claim confirmation | Contractor reports a fix; the client confirms, denies, or the claim is auto-confirmed on timeout. | [ADR-133](../adr/ADR-133-warranty-claim-satisfaction.md) |
| 134 | Contract timeline kinds | Timeline read model from the outbox with a stable presentation key `kind` and localized titles from the backend. | [ADR-134](../adr/ADR-134-contract-timeline-kinds.md) |
| 135 | Trusted timestamping | The daily checkpoint root is timestamped (RFC 3161) at four independent authorities; two of four make a quorum. | [ADR-135](../adr/ADR-135-trusted-timestamping.md) |
| 136 | Evidence foundation | Manifest fields on evidence, encryption of originals at rest, geotag stored as ciphertext only, WORM mode, retention timer, and a 72-hour upload window. | [ADR-136](../adr/ADR-136-evidence-etap6-foundation.md) |
| 137 | Data retention | Hot storage 3 months after a contract ends, archive up to 1 year, hashes and timestamps indefinitely; archive handed to the parties with a 10-day notice; extended during an open dispute by at most 6 months. | [ADR-137](../adr/ADR-137-data-retention.md) |
| 138 | Auto-close of idle contracts | Last-activity mark on the contract, an idle deadline, and a warning two weeks before closing. | [ADR-138](../adr/ADR-138-contract-idle-autoclose.md) |
| 139 | Evidence package and archive delivery | New archive app builds the package asynchronously from five contexts and delivers it to both parties. | [ADR-139](../adr/ADR-139-evidence-export-archive.md) |
| 140 | Acceptance window from contract terms | Milestone acceptance window comes from the contract terms through a per-deadline duration override. | [ADR-140](../adr/ADR-140-acceptance-window-from-contract.md) |
| 141 | Informative emails and pushes | Placeholders are substituted from the payload, deal metadata is included, and a link opens the deal. | [ADR-141](../adr/ADR-141-informative-email-and-push-texts.md) |
| 142 | Default formatter locale follows interface language | The default locale of core formatting helpers is changeable and synchronized with the UI language. | [ADR-142](../adr/ADR-142-ui-formatters-default-locale.md) |
| 143 | Overlays render in a portal | `Modal` and `Sheet` render into `document.body` instead of in place. | [ADR-143](../adr/ADR-143-overlays-render-in-portal.md) |
| 145 | Analytics marts and internal metrics | A separate reader app with no imports from other apps; marts are SQL over outbox and domain tables. | [ADR-145](../adr/ADR-145-analytics-marts-and-internal-metrics.md) |
| 146 | Compact density layer | A separate token layer for interface density and list rows instead of cards. | [ADR-146](../adr/ADR-146-compact-density-layer.md) |
| 147 | Trust anchors for archived timestamp chains | An explicit list of trust anchors is stored in the repository, including older SHA-1 roots. | [ADR-147](../adr/ADR-147-tsa-trust-anchors.md) |
| 148 | Language fixed at sign-in; country not guessed | Request language is stored in the profile on first sign-in; country is not filled in from the jurisdiction. | [ADR-148](../adr/ADR-148-signup-locale-and-honest-country.md) |
| 149 | Compact v2 | Status shown as a word, two tabs with a funnel, and actions by gesture. | [ADR-149](../adr/ADR-149-compact-v2-row-tabs-gestures.md) |
| 150 | Store distribution and shell cache policy | Trusted web activity wrapper over the live site for app stores, and a cache policy for the app shell. | [ADR-150](../adr/ADR-150-pwa-store-distribution-and-cache.md) |
| 151 | Payment order | `Contract.payment_order` (prepayment or after acceptance) is a separate axis from the settlement method. | [ADR-151](../adr/ADR-151-contract-payment-order.md) |
| 152 | Header slots and full-width lists | The phone header belongs to the screen via portals; lists use full width; three tabs for deals. | [ADR-152](../adr/ADR-152-shell-header-slots-and-reference-pass.md) |
| 153 | Ranking of acceptance criteria suggestions | Suggestions are ranked by how often they are picked, using a counter table keyed by slug. | [ADR-153](../adr/ADR-153-checklist-recommendations-ranking.md) |
| 154 | Stage materials in wizard and card | Materials can be edited in the wizard and on the card while the contract is still editable. | [ADR-154](../adr/ADR-154-stage-materials-in-wizard-and-card.md) |
| 155 | Milestone start gate | Prepayment as a start condition, a three-state condition model, and two-way material handover. | [ADR-155](../adr/ADR-155-milestone-start-gate-prepayment-materials.md) |
| 156 | Materials changed notification | Material edits during negotiation do not open a revision round but trigger a notification. | [ADR-156](../adr/ADR-156-materials-changed-notification.md) |
| 157 | Structured amendment references | The set of addressable `item_ref` values is extended to payment terms, stages and materials. | [ADR-157](../adr/ADR-157-amendment-structured-refs.md) |
| 158 | Server-side "materials seen" mark | One mark per party on the contract records when materials were last viewed. | [ADR-158](../adr/ADR-158-materials-seen-server-mark.md) |
| 159 | Template code in the notification feed | Each feed item carries `template_code` so the client can tell the notification kind. | [ADR-159](../adr/ADR-159-feed-template-code.md) |
| 160 | Evidence draft on the device | Files attached by the contractor stay on the device and are uploaded only when the stage is submitted. | [ADR-160](../adr/ADR-160-evidence-draft-on-device.md) |
| 161 | Amendments tab and draft lifecycle | A separate tab on the contract card for amendments, with a defined life of a draft before sending. | [ADR-161](../adr/ADR-161-amendments-tab-draft-lifecycle.md) |
| 162 | Milestone auto-start | A leaf milestone starts by itself when the last start-gate condition is satisfied. | [ADR-162](../adr/ADR-162-milestone-auto-start.md) |
| 163 | Reputation dashboard by role | Separate scoring axes for contractor and customer roles, shown as done/total fractions with no single score; color zones are presentation only; some figures hidden from others and shown only to the owner as insights. | [ADR-163](../adr/ADR-163-reputation-dashboard-role-axes.md) |
| 164 | Required evidence is advice, not a gate | The checklist's required evidence no longer blocks submission; uncovered items are listed instead. | [ADR-164](../adr/ADR-164-required-evidence-is-advice-not-gate.md) |
| 165 | Phone login feature flag | `PHONE_LOGIN_ENABLED` setting controls phone login; for publication only Google sign-in is shown. | [ADR-165](../adr/ADR-165-phone-login-flag.md) |
| 167 | Additional terms in the wizard | Manual free-text additional terms are entered in the wizard and stored in the same `additional_terms` list. | [ADR-167](../adr/ADR-167-wizard-additional-terms.md) |
| 168 | Email code login | Sign-in and registration by a one-time code sent by email; no password and no magic link. | [ADR-168](../adr/ADR-168-email-code-login.md) |
| 169 | Account deletion | `DELETE /v1/users/me` lets a user delete the account and data from the app and from a public web page. | [ADR-169](../adr/ADR-169-account-deletion.md) |
| 170 | Notification deep links | One template-to-target map opens the relevant section of a deal for all channels. | [ADR-170](../adr/ADR-170-notification-deep-links.md) |
| 171 | Install and active user statistics | App installs and active users are counted as a second and last analytics input. | [ADR-171](../adr/ADR-171-install-analytics.md) |
| 172 | Latin brand in emails | The brand name is written in Latin letters in transport strings; the sign-in code email is re-laid out. | [ADR-172](../adr/ADR-172-email-brand-latin.md) |
| 173 | Counterparty photo in section aggregates | `avatar_url` is returned next to `display_name` in counterparty blocks, so no second client request is needed. | [ADR-173](../adr/ADR-173-counterparty-avatar-in-sections.md) |
| 175 | Push permission is per device | Push permission and subscription are device state, not account state. | [ADR-175](../adr/ADR-175-push-permission-per-device.md) |
| 176 | Native push in the app wrapper | A native push layer through universal push providers is added in the wrapper, next to Web Push. | [ADR-176](../adr/ADR-176-native-push-universal-providers.md) |
| 177 | App wrapper detection and default browser hint | Three independent signs show the app runs inside an installed wrapper; a hint about the default browser is shown. | [ADR-177](../adr/ADR-177-app-wrapper-detection-and-default-browser.md) |
| 178 | Notifications only for counterparty actions | The actor no longer gets notifications about their own actions; the actor registry is narrowed to addressed ones. | [ADR-178](../adr/ADR-178-notifications-counterparty-only.md) |
| 179 | Geography directory | Backend directory of country, region and city replaces a free-text city string. | [ADR-179](../adr/ADR-179-geo-directory.md) |
| 180 | Push card layout | Push title shows the contract name, the photo is the counterparty's, and one logo is used. | [ADR-180](../adr/ADR-180-push-card-layout.md) |
| 181 | Geo names in the viewer's language | Separate table of alternate names; search works in any supported language. | [ADR-181](../adr/ADR-181-geo-alternate-names.md) |
| 182 | Profile work areas | Work area is stored separately from jurisdiction, on top of the geo directory. | [ADR-182](../adr/ADR-182-profile-work-areas.md) |
| 183 | Colloquial and short geo names | Colloquial and short flags are stored from the source, and Latin transliteration is used under foreign locales. | [ADR-183](../adr/ADR-183-geo-name-colloquial-short-native-script.md) |
| 184 | Catalog search with filters | A second, independent `catalog` branch of `GET /dashboard/search` finds contractors with filters. | [ADR-184](../adr/ADR-184-dashboards-catalog-search-filters.md) |
| 185 | Catalog filter panel in the web client | Filter panel on `/search` keeps its state in the URL using backend parameter names. | [ADR-185](../adr/ADR-185-web-search-catalog-filters.md) |
| 186 | Filtered-search counter | The backend records searches with filters through a facade call; no browser event is used. | [ADR-186](../adr/ADR-186-catalog-search-filters-metric.md) |
| 187 | Empty states of catalog search | Five kinds of empty result get their own messages instead of one generic message. | [ADR-187](../adr/ADR-187-web-search-catalog-empty-states.md) |
| 188 | Catalog sphere name cleanup | Author notes in parentheses are stripped by the parser and are not part of the name; `name_i18n` is a fallback only. | [ADR-188](../adr/ADR-188-catalog-sphere-name-author-note-strip.md) |
| 189 | Search screen simplification | One zone control, one sphere label, and comments moved into a help hint. | [ADR-189](../adr/ADR-189-web-search-declutter.md) |
| 190 | Work types in profile and catalog search | Work types are existing checklist categories, not a new model; profiles store work type codes. | [ADR-190](../adr/ADR-190-profile-search-work-types.md) |
| 191 | Work types in the web client | Shared chips editor for work types in profile and search. | [ADR-191](../adr/ADR-191-web-work-types.md) |
| 192 | Search screen polish | The contact-book search is removed; colors and layout are aligned. | [ADR-192](../adr/ADR-192-web-search-polish.md) |
| 193 | Catalog: self-exclusion and local-first order | The viewer's own profile is excluded from catalog results and local contractors are listed first. | [ADR-193](../adr/ADR-193-catalog-local-first-and-self-exclusion.md) |
| 194 | Geo filter levels and sorting | The filter can stop at any level, is sorted alphabetically for the viewer, and fills in the region from a city. | [ADR-194](../adr/ADR-194-web-geo-filter-levels-and-sorting.md) |
| 195 | Public site contour | Landing and project pages readable without sign-in, with the language in the URL. | [ADR-195](../adr/ADR-195-public-site-contour.md) |
| 196 | Prerendering of public pages | Static HTML for public pages in 29 languages is generated next to the SPA shell. | [ADR-196](../adr/ADR-196-prerender-public-pages.md) |
| 199 | Website visit statistics | A third-party web analytics snippet is added to count visits that never reach the backend. | [ADR-199](../adr/ADR-199-web-cloudflare-web-analytics.md) |
| 201 | Production settings guard | The production settings module refuses to start on fake or development defaults. | [ADR-201](../adr/ADR-201-prod-settings-guard.md) |
| 202 | Public mirror | The public repository is built from the private one by an allowlist; one snapshot commit per publication; Apache-2.0 with DCO. | [ADR-202](../adr/ADR-202-public-mirror.md) |
| 203 | Terminology before publication | The member role and the backoffice app replace labour-flavoured names across code and docs. | [ADR-203](../adr/ADR-203-terminology-member-backoffice.md) |
