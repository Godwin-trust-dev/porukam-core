# Glossary (RU <-> EN)

The project documentation and the original design notes are written in Russian. This glossary maps the Russian domain terms to the English names used in code, API and English texts. Code names follow the domain model; where a term is a concept rather than a class, the English phrase is the one used in English documentation.

## Core terms

### Parties and identity

| English term | Russian term | Definition |
|---|---|---|
| User | Пользователь | An individual account on the platform, identified by a login and a verification level. |
| VerificationLevel | Уровень верификации | Level of identity checking of a user: guest, basic (e-mail and phone), verified (state eID or document with liveness check), business (verified legal entity). |
| BusinessEntity | Юрлицо / бизнес-единица | A legal entity or registered business (sole proprietor, self-employed person, limited liability company, corporation, partnership) with its own card, independent of any user. |
| EntityType | Тип бизнес-единицы | Country-neutral type of a business entity; the local legal form is chosen from a reference list, not typed in. |
| Self-employed person (СМЗ) | Самозанятый | A private individual registered for a special tax regime for people who earn from their own work without forming a company (in Russia, the tax on professional income, НПД). It is a tax status of an individual, not a legal entity. |
| Profile | Профиль | Public page and reputation holder; polymorphic: it belongs either to a User or to a BusinessEntity. |
| Customer | Заказчик | The party of a contract that orders the result and pays for it. |
| Contractor | Исполнитель | The party of a contract that delivers the result. |
| Counterparty | Контрагент | The other party of a contract, seen from one party's side. |
| Representative | Представитель | A user with operational access to work on behalf of a legal entity; has no signing right. |
| Permission | Право доступа | A granular operational right (communicate, manage checklist, upload evidence, confirm milestone, and so on); the source of truth for access checks. |
| SigningAuthority | Право подписи | A record that a user may legally sign on behalf of a legal entity, with its basis, optional amount limit and expiry; kept separate from operational permissions. |
| SigningBasis | Основание права подписи | Why the signing right exists: registry-verified director, notarized power of attorney, chained delegation, or manual review. |
| EntityClaim | Подтверждение контроля над юрлицом | Procedure that proves a user controls a legal entity card, to prevent takeover of the card. |
| TrustID | TrustID (идентификатор субъекта) | Stable platform identifier of a user or business entity; it does not change when the public handle changes. |
| Handle (@username) | Хендл (@username) | Public short name of a subject. It is not proof of identity; the verification status is always shown next to it. |
| Contact | Контакт | A confirmed link between two subjects; the basis of the trust graph. |
| Trust graph | Граф доверия | Network of links confirmed by completed work, as opposed to a network of subscriptions. |
| OwnershipEpoch | Эпоха владения | Period during which a profile belongs to a given owner; reputation is split by epochs when the owner changes. |
| Community | Объединение | A guild, professional body or association that a person or a legal entity can join. |
| Portfolio | Портфолио | Set of completed projects a profile chooses to show. |

### Contracts and signing

| English term | Russian term | Definition |
|---|---|---|
| Contract | Договор | The central entity: an agreement between a customer and a contractor, with a negotiation path and an execution path. |
| ContractParty | Сторона договора | Link between a contract and a party; each contract has exactly one customer and one contractor. |
| ContractVersion | Версия договора | Frozen snapshot of the contract text and terms that is sent for signing. |
| integrity_hash | Хеш целостности | Hash of a frozen contract version; every signature is made over this value. |
| NegotiationStatus | Статус согласования | Shared negotiation path for any signable agreement: draft, under review, rejected, withdrawn, pending signature, awaiting signatures, signed. |
| ContractExecutionStatus | Статус исполнения | Execution state of a signed contract: pending start, in progress, terminated by customer or contractor, completed, warranty, closed. |
| Signature | Подпись | A party's signature over an integrity_hash. |
| SignatureRequest | Запрос на подпись | A request to a specific signer to sign a frozen version. |
| Amendment | Дополнительное соглашение (допник) | A separate signed document that changes a signed contract; it goes through the same negotiation path and forms a chain, the original is never overwritten. |
| Immutability of a signed contract | Неизменяемость подписанного договора | Once signed, a contract cannot be edited; changes are made only through amendments. |
| Contract type catalog | Каталог типов договоров | Reference list of contract types per jurisdiction (services, loan, lease, sale, and so on) that drives templates and segment. |
| DealType | Тип сделки | B2B, B2C or C2C: determined by the status of the parties and used to pick the regulatory regime. |
| segment / compute_segment | Сегмент / расчёт сегмента | Classification of a contract (free_c2c, paid_business, special, excluded) computed from contract type and the contractor's status; used for catalog and tax logic. |
| free_c2c | Бесплатный C2C-сегмент | Segment for non-business contract types and for paid services where the contractor is a private person without business status. |
| excluded segment | Исключённый сегмент | Contract types the platform does not support (for example securities); such a contract cannot be created (HTTP 403). |
| has_business_status | Наличие бизнес-статуса | True only when the contractor is registered as a self-employed person or sole proprietor in their own name. Representing someone else's legal entity does not give the status. |
| own-business status | Собственный бизнес-статус | Status held personally by the contractor; representing someone else's legal entity does not give it. |
| Subcontract link (ContractLink) | Связь договоров (субподряд) | A synchronization layer over ordinary two-party contracts; rights and duties do not pass between them, and only the creator sees the link. |
| Contract template | Шаблон договора | Platform text with parameters, filled from the contract form and frozen into a version at signing. |

### Milestones and acceptance

| English term | Russian term | Definition |
|---|---|---|
| Milestone | Этап | A unit of work in a recursive tree; branches group, leaves are accepted and paid. |
| Leaf milestone | Лист-этап | A milestone without children; the only kind that is accepted and paid. Leaf amounts add up to the contract amount. |
| Milestone tree | Дерево этапов | Hierarchy of milestones with depth at most 6. |
| MilestoneStatus | Статус этапа | Pending, in progress, suspended, under acceptance, disputed, accepted, paid. |
| ChecklistItem | Пункт чек-листа | A verifiable condition inside a milestone; acceptance is decided against the checklist. |
| Acceptance | Приёмка | Confirmation by the customer that a milestone result meets the checklist. |
| Auto-acceptance | Автоприёмка | Acceptance that happens when the customer does not respond within the acceptance period (48 hours by default) after the result is submitted. |
| Fix round | Раунд доработки | A return of a milestone to the contractor for corrections; at most 2 per dispute. |
| Suspension | Приостановка | A computed state: a contract in progress with at least one suspended leaf milestone; not a separate status. |
| Material | Материал | A material item in a contract with its source (customer or contractor) and delivery basis. |

### Payments

| English term | Russian term | Definition |
|---|---|---|
| Payment | Платёж | A payment operation tied to a contract and milestone. |
| Money | Деньги (сумма и валюта) | Always a pair (amount as Decimal, currency); there is no default currency, and amounts in the API are strings. |
| PaymentMethod | Способ расчёта | The rail by which money moves: direct platform payment, hold, cash, external bank transfer. |
| Hold | Холд (блокировка средств) | Authorization that reserves money on the payer's side until capture or release; the platform does not keep the funds. |
| Split transfer | Сплит-перевод | A technical rail in which money goes directly to the contractor; it is not a separate payment method. |
| PaymentOrder | Порядок оплаты | When a leaf milestone is paid relative to its execution: before start or after acceptance. |
| PaymentStatus | Статус платежа | Pending, processing, held, observed, confirmed, captured, voided, refunded, disputed, failed. |
| No funds held | Платформа не хранит средства | The platform does not hold customer money; there is no commission on payments, only the payment operator's own tariff. |
| Idempotency-Key | Ключ идемпотентности | HTTP header required on money and signing POST requests so that a repeated request has no second effect. |
| Idempotent webhook | Идемпотентный вебхук | A provider callback that can be received many times with the same result. |
| Two-sided confirmation | Двустороннее подтверждение | Both payer and payee confirm a payment that the platform cannot observe (cash, external transfer). |

### Evidence and disputes

| English term | Russian term | Definition |
|---|---|---|
| Evidence | Доказательство | A file or record attached to a contract, milestone or checklist item, stored with its hash and a trusted timestamp. |
| EvidenceCapture | Съёмка доказательства | An evidence unit taken in the field, with content hash, device signature, device time and upload time. |
| ContractAssignment | Назначение на договор | Who may capture evidence on which contract and milestones, and for what period. |
| DeviceKey | Ключ устройства | Key of a capture device used to sign evidence at the moment of capture. |
| Upload window | Окно выгрузки | Period (72 hours by default) in which offline evidence should be uploaded; late items are accepted with a visible note. |
| Timestamp (RFC 3161) | Доверенная метка времени | Third-party proof that a file existed no later than a given moment. |
| Evidence package | Доказательный пакет | PDF with a table of contents plus a ZIP with files and a hash manifest, checkable without the platform. |
| Audit Vault | Аудит-хранилище | Separate append-only database with a hash chain that records significant events. |
| AuditLogEntry | Запись аудита | One entry of the audit log; internal roles cannot edit the content of a signed contract or evidence. |
| Dispute | Спор | A dispute over a milestone; the milestone is accepted as a whole or returned as a whole. |
| DisputeOutcome | Исход спора | Result of a dispute, including the cap outcome when the 30-day limit is reached. |
| Dispute cap | Потолок спора | Maximum duration of a dispute (30 days by default). |
| MediationSession | Медиация | Paid mediation; there is no binding arbitration, the mediator's opinion has no legal force, and final disputes go to court. |
| Warranty | Гарантия | Period after completion in which the customer can submit claims; the period is agreed by the parties. |
| WarrantyClaim | Гарантийная заявка | A claim during the warranty period; counted as a separate metric and never recalculates past ratings. |

### Reputation

| English term | Russian term | Definition |
|---|---|---|
| Reputation card | Карточка репутации | Public set of facts about a profile, shown per sphere with absolute deal count and volume. |
| SphereReputation | Репутация по сфере | Reputation of a profile in one sphere of work; there is no single overall score. |
| Sphere | Сфера | Area of work (for example construction) in which reputation is counted. |
| Facts, not ratings | Факты, а не оценки | Only measurable facts are published; reviews exist but are not published. |
| ActivityCounter | Счётчик активности | Counter of deals of a private person without business status; used for registration suggestions, fraud detection and repeated-pair warnings. |
| Systematic activity warning | Предупреждение о систематичности | Information shown to the parties when one pair works together regularly; it informs and does not block. |

### Platform and infrastructure

| English term | Russian term | Definition |
|---|---|---|
| Modular monolith | Модульный монолит | Django application split into bounded-context apps with enforced import boundaries. |
| services.py / selectors.py | Сервисы / селекторы | Layers inside an app: use cases that change state, and read-only queries. |
| Outbox event | Событие outbox | Domain event written in the same transaction as the data change and published later by a relay worker. |
| Deadline sweep | Sweep дедлайнов | Domain deadlines are rows in the database checked every minute, not delayed tasks; this allows shifting them after downtime. |
| Legal channel | Юридически значимый канал | The in-app personal cabinet is the legal channel for notifications; e-mail and push only duplicate. |
| placed_in_cabinet_at | Момент размещения в кабинете | Timestamp of placing a notification in the cabinet; timeouts are counted from it. |
| Timeout pause | Пауза тайм-аутов | Active deadlines are extended by the length of a platform outage. |
| Crypto-shredding | Крипто-удаление | Personal data is encrypted per subject (envelope encryption); deleting the key makes the data unreadable. |
| No soft delete | Нет мягкого удаления | Legally significant entities are never marked as deleted; they stay as they are. |
| Platform role | Внутренняя роль | Internal role (support, compliance, finance, admin); none can edit signed content. |
| Dashboard | Дашборд | Computed role view over contract data; it holds no state of its own. |

### Localization

| English term | Russian term | Definition |
|---|---|---|
| Jurisdiction | Юрисдикция | A country configuration (forms, tax regimes, contract types, currencies, providers) plugged into a single universal core. |
| JurisdictionConfig | Конфигурация юрисдикции | The object that holds the country's reference data and rules. |
| GLOBAL | GLOBAL (глобальная юрисдикция) | Default jurisdiction configuration, used when the user has no country or the country has no plugin. Exactly one configuration is flagged as the global default (database constraint). It switches off legal-force and tax statements and the SMS channel; currencies come from migration data. |
| Provider | Провайдер | Country-specific implementation of a common interface (registry check, e-signature, accounting documents, payments). |
| Locale pack | Языковой пакет | Set of translated interface strings and texts for one language. |
| Reference list | Справочник | List a user chooses from instead of typing free text (legal forms, tax regimes, spheres). |
| Terminology lint | Линтер терминологии | CI check that rejects forbidden wording in code, API and UI strings. |

## Terms we do not use

The platform models contracts for a result: a customer orders, a contractor delivers, the customer accepts. It does not model labour relations. Wording from that area in the code, API or texts can create a legal risk that a contract is requalified as employment, so it is avoided everywhere. The CI terminology lint (`scripts/lint-terms.mjs`) fails the build when such words appear in localization strings, UI literals, URL tokens or analytics event names.

| Avoided word (RU) | Avoided word (EN) | Reason |
|---|---|---|
| персонал | staff, workforce | Suggests a permanent team under the platform or customer instead of independent contractors. |
| вакансии | vacancy, vacancies, hire, hiring | Suggests recruitment for a position rather than an order for a result. |
| зарплата | salary, payroll | Describes pay for time in a position; contracts pay for accepted results. |
| найм | hiring | A labour-law notion; the relation here is a contract for work. |
| работодатель | employer | Implies subordination of the contractor, which the model does not have. |
| сотрудник | employee, employees | Implies an employment relation with the party, not a contract party. |

Preferred words: projects, orders, contractors, customers (clients), parties, work, contract for work, acceptance.

The lint matches Russian stems by word start and Latin tokens by word boundary. The Russian "персональные данные" (personal data) is allowed and is not treated as the avoided word.
