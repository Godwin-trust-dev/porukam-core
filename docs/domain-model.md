# Trust Platform: доменная модель (псевдокод)

> Псевдокод в стиле Python. Цель — показать **связи, логику, справочники и структуру**, а не готовую реализацию.
> Тела методов — упрощённые, показывают намерение. Комментарии на русском.
> Каждый класс — отдельным блоком, чтобы удобно было комментировать.
>
> Базируется на концепции v9.0 (обновлено 22.07.2026: сегменты договоров C2C и комиссия за заключение — ADR-054/055/056/058; делегированная офлайн-съёмка — ADR-053; юрканал ЛК+push — ADR-057; идентичность и соцграф — TrustID/@username/контакты, Часть II-A).
>
> **Обновлено 23.07.2026 — синхронизация с техспецификацией 2.0** (реестр расхождений Р-1…Р-7, док. «Организация разработки» §7):
> - **Р-1:** исправлена семантика `User.has_business_status` — статус даёт только СОБСТВЕННЫЙ бизнес-профиль (СМЗ/ИП), а не представительство чужого юрлица;
> - **Р-2 [Т-решение]:** `PLATFORM_SPLIT` упразднён как способ расчёта — сплит-перевод является техническим РЕЛЬСОМ прямого платежа (`DIRECT_PLATFORM`) и холда, а не отдельным способом (согласовано со спекой §5.2.4 и концепцией §15.2);
> - **Р-3:** `Sphere` в реализации — таблица-справочник (спека §5.2.5), не enum;
> - **Р-4:** `PaymentStatus` дополнен `PROCESSING`/`FAILED` (спека §5.2.6);
> - **Р-5:** класс `AdditionalAgreement` переименован в `Amendment` — единообразно с термином спеки (§1.5) и публичным API.
>
> **Обновлено 24.07.2026 (спека 2.0.3):** добавлен универсальный справочник валют `Currency` и `default_currency_code` в `JurisdictionConfig` (раздел 15). Правило ADR-041 неизменно: валюты по умолчанию в логике нет — `default_currency_code` только подставляется в форму UI при создании договора.

---

# СОДЕРЖАНИЕ

1. Справочники (enums)
2. Базовые типы (value objects)
3. Субъекты: User, BusinessEntity, профили, идентичность и соцграф
4. Полномочия: Representative, SigningAuthority, делегирование
5. Эпохи владения
6. Договор: Contract, версия, стороны, тип/сегмент
7. Этапы (дерево), чек-лист, материалы
8. Подписание
9. Дополнительные соглашения (Amendment)
10. Платежи, комиссия за заключение и гейт
11. Диалог и споры
12. Гарантия
13. Репутация
14. Документы; делегированная офлайн-съёмка доказательств (ContractAssignment, DeviceKey)
15. Юрисдикция и провайдеры (включая справочник типов договоров)
16. Внутренние роли и аудит
17. Уведомления (юрканал — личный кабинет)
18. Мониторинг систематичности C2C
19. Связи между договорами (субподряд)
20. Дашборды ролей (вычисляемые представления)

---

# 1. СПРАВОЧНИКИ (ENUMS)

```python
from enum import Enum


class VerificationLevel(Enum):
    """Уровень верификации личности пользователя."""
    GUEST = 0        # только просмотр
    BASIC = 1        # email + телефон, заказы до лимита
    VERIFIED = 2     # строгая верификация: гос-eID (в РФ — ЕСИА) или документ+liveness
                     # у аккредитованного провайдера; свою биометрию не обрабатываем (ADR-052)
    BUSINESS = 3     # верифицированное юрлицо, корпоративные заказы
```

```python
class EntityType(Enum):
    """Обобщённый тип бизнес-единицы (универсальное ядро, не привязано к стране).
    Локальная форма собственности выбирается из СПРАВОЧНИКА (LocalEntityForm), не вводится текстом."""
    SOLE_PROPRIETOR = "sole_proprietor"        # ИП и аналоги
    SELF_EMPLOYED = "self_employed"            # самозанятый / НПД
    LIMITED_LIABILITY = "limited_liability"    # ООО и аналоги
    CORPORATION = "corporation"                # АО и аналоги
    PARTNERSHIP = "partnership"                # товарищества
    OTHER = "other"
```

```python
# ============================================================
# ЛОКАЛЬНЫЕ СПРАВОЧНИКИ (reference data)
# Пользователь ВСЕГДА выбирает из списка, никогда не вводит текстом.
# Справочники живут в JurisdictionConfig и наполняются при выходе в страну.
# ============================================================

class LocalEntityForm:
    """Справочник форм собственности конкретной страны.
    Связывает локальную форму с универсальным EntityType ядра."""

    def __init__(self):
        self.country_code: str = ""              # ISO 3166-1, напр. 'RU'
        self.code: str = ""                      # машинный код, напр. 'ru_ooo'
        self.label: str = ""                     # что видит пользователь: 'ООО'
        self.full_label: str = ""                # 'Общество с ограниченной ответственностью'
        self.entity_type: EntityType = None      # маппинг на универсальное ядро
        self.required_tax_id_types: list[str] = []      # RU ООО: ['INN', 'OGRN', 'KPP']
        self.allowed_tax_regimes: list[str] = []        # коды LocalTaxRegime
        # Разделены ли юридически роли владельца и исполнителя.
        # True -> ручная экспертиза как основание SigningAuthority ЗАПРЕЩЕНА (см. ADR-004)
        self.has_separated_ownership: bool = False
        self.is_active: bool = True


class LocalTaxRegime:
    """Справочник налоговых режимов конкретной страны.
    Определяет, какие закрывающие документы формируются (см. ADR-037)."""

    def __init__(self):
        self.country_code: str = ""
        self.code: str = ""                      # 'ru_npd', 'ru_usn', 'ru_osn'
        self.label: str = ""                     # 'Самозанятый (НПД)'
        self.description: str = ""
        # Какие документы порождает этот режим — вместо хардкода 'if tax_regime == npd'
        self.closing_document_types: list[str] = []     # ['receipt'] или ['act', 'invoice']
        self.vat_applicable: bool = False
        self.is_active: bool = True
```

```python
class DealType(Enum):
    """Тип сделки — определяет режим регулирования (ФЗ-289 и др.).
    ВНИМАНИЕ: тип сделки (кто стороны) и СЕГМЕНТ монетизации (ContractSegment, платим ли мы комиссию)
    — разные вещи. Тип определяется статусом сторон, сегмент — типом договора + статусом исполнителя (ADR-058)."""
    B2B = "b2b"    # юрлицо <-> юрлицо
    B2C = "b2c"    # юрлицо-исполнитель <-> физлицо-заказчик
    C2C = "c2c"    # физлицо <-> физлицо без предпринимательства (вне ФЗ-289)
```

```python
class ContractSegment(Enum):
    """Сегмент договора по монетизации (ADR-058). Определяется ТИПОМ ДОГОВОРА и СТАТУСОМ СТОРОН.
    Комиссию за заключение (ADR-054) берём только в PAID_BUSINESS и SPECIAL."""
    FREE_C2C = "free_c2c"
    # Бесплатно (0 комиссии): непредпринимательские типы (заём, дарение, мена, продажа личного
    # имущества, продукция ЛПХ, безвозмездная помощь) + возмездные услуги, пока ИСПОЛНИТЕЛЬ —
    # физлицо без бизнес-статуса (заказчик любой) — «плавный вход в предпринимательство».
    PAID_BUSINESS = "paid_business"
    # С комиссией: услуги/работы, где исполнитель — бизнес (СМЗ/ИП/юрлицо). Основной платный сегмент.
    SPECIAL = "special"
    # С комиссией + особая проработка: продажа недвижимости/транспорта, аренда/наём личного имущества.
    EXCLUDED = "excluded"
    # Платформа НЕ готовит: реализация долей в УК, паёв, ценных бумаг. Заведён как «неподдерживаемый»,
    # пользователю НЕ показывается.
```

```python
class RepresentativeRole(Enum):
    """Роль представителя = ПРЕСЕТ прав доступа для UI. Реальные проверки — по permissions."""
    ADMINISTRATOR = "administrator"
    MANAGER = "manager"
    MEMBER = "member"
```

```python
class Permission(Enum):
    """Гранулярные операционные права. ИСТОЧНИК ИСТИНЫ для проверок доступа.
    Право подписи сюда НЕ входит принципиально — оно в SigningAuthority."""
    COMMUNICATE = "communicate"
    MANAGE_CHECKLIST = "manage_checklist"
    UPLOAD_EVIDENCE = "upload_evidence"           # съёмка/загрузка доказательств (см. 14 — ContractAssignment)
    CONFIRM_MILESTONE = "confirm_milestone"
    MANAGE_PROFILE = "manage_profile"
    MANAGE_REPRESENTATIVES = "manage_representatives"
    RESPOND_DISPUTE = "respond_dispute"
```

```python
class SigningBasis(Enum):
    """Основание права подписи. Определяет, нужна ли ручная проверка."""
    REGISTRY_VERIFIED_DIRECTOR = "registry_director"
    NOTARIZED_POA = "notarized_poa"
    CHAINED_DELEGATION = "chained_delegation"
    MANUAL_REVIEW = "manual_review"
```

```python
class NegotiationStatus(Enum):
    """ОБЩИЙ путь согласования для ЛЮБОГО подписываемого соглашения: и для договора, и для допника."""
    DRAFT = "draft"
    UNDER_REVIEW = "under_review"
    REJECTED_BY_COUNTERPARTY = "rejected_by_counterparty"
    WITHDRAWN_BY_INITIATOR = "withdrawn_by_initiator"
    PENDING_SIGNATURE = "pending_signature"
    AWAITING_SIGNATURES = "awaiting_signatures"
    SIGNED = "signed"
```

```python
class ContractExecutionStatus(Enum):
    """Исполнение — ТОЛЬКО у договора. У допника его нет."""
    PENDING_START = "pending_start"
    IN_PROGRESS = "in_progress"
    TERMINATED_BY_CUSTOMER = "terminated_by_customer"
    TERMINATED_BY_CONTRACTOR = "terminated_by_contractor"
    COMPLETED = "completed"
    WARRANTY = "warranty"
    CLOSED = "closed"
```

```python
class MilestoneStatus(Enum):
    """Состояние ОТДЕЛЬНОГО ЭТАПА (листа дерева) — живёт внутри фазы договора IN_PROGRESS."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUSPENDED = "suspended"
    UNDER_ACCEPTANCE = "under_acceptance"
    DISPUTED = "disputed"
    ACCEPTED = "accepted"
    PAID = "paid"
```

```python
def contract_is_suspended(contract) -> bool:
    """Приостановка договора — НЕ отдельный статус, а ВЫЧИСЛЯЕМЫЙ признак."""
    return (contract.execution_status == ContractExecutionStatus.IN_PROGRESS
            and any(m.status == MilestoneStatus.SUSPENDED
                    for m in contract.leaf_milestones()))
```

```python
class PaymentMethod(Enum):
    """Способ расчёта. Определяет уровень защиты и логику гейта.
    Комиссия платформы за сами платежи — 0% (ADR-055); доход — комиссия за ЗАКЛЮЧЕНИЕ договора (ADR-054).

    Р-2 [Т-решение, 23.07.2026]: прежний PLATFORM_SPLIT УПРАЗДНЁН. Сплит-перевод — технический
    РЕЛЬС (как деньги физически едут напрямую исполнителю), а не отдельный способ расчёта:
    им пользуются и DIRECT_PLATFORM (сплит СБП), и HOLD (сплит при капчере). Концепция §15.2
    и так трактует split как «предпочтительное направление»/рельс; CHECK-ограничение
    спеки §5.2.4 содержит ровно эти пять значений."""
    DIRECT_PLATFORM = "direct_platform"  # ЦЕЛЕВОЙ (ADR-056): прямой платёж через платформу,
                                         # аванс+постоплата по этапу, сплит-перевод (рельс СБП);
                                         # защита СРЕДНЯЯ — факт/сумма/дата наблюдаемы, возвратность не гарантирована
    HOLD = "hold"                    # эскроу-авторизация (холд) — опция «полная защита» (Р2)
    CASH = "cash"                    # наличные — без защиты
    EXTERNAL = "external"            # внешний безнал — без защиты
    # PREPAYMENT УПРАЗДНЁН (репо-ADR-155, владелец 03.09: «способ оплаты — это каким способом
    # перемещаются деньги. предоплата с двусторонним подтверждением — там быть не должно»).
    # Это был не рельс, а СРОК, и с появлением PaymentOrder он стал вторым именем того же
    # факта: предоплата = payment_order.BEFORE_START.


class PaymentOrder(Enum):
    """Порядок оплаты (репо-ADR-151): СРОК оплаты листа-этапа относительно его исполнения.
    Независимая ось от PaymentMethod (рельсы расчёта): наличными или холдом можно платить и до,
    и после. Коды намеренно не `prepayment`/`postpayment` — они называют СОБЫТИЕ, к которому
    привязан срок (а на момент ADR-151 слово `prepayment` было ещё занято одноимённым способом
    расчёта, упразднённым в ADR-155). Неприменим к займу (лист-этап займа — сам денежный
    транш). ЕДИНСТВЕННОЕ место, где живёт предоплата (репо-ADR-155)."""
    BEFORE_START = "before_start"          # предоплата — до начала этапа
    AFTER_ACCEPTANCE = "after_acceptance"  # постоплата — после приёмки этапа
```

```python
class PaymentStatus(Enum):
    """Статусы платёжной операции. Состав — по спеке §5.2.6 (Р-4: добавлены PROCESSING и FAILED)."""
    PENDING = "pending"
    PROCESSING = "processing"  # передано провайдеру, ждём исход (Р-4)
    HELD = "held"            # средства заблокированы (холд активен)
    OBSERVED = "observed"    # прямой платёж проведён и наблюдён платформой (ADR-056)
    CONFIRMED = "confirmed"  # подтверждён (двусторонне, если офлайн)
    CAPTURED = "captured"    # списан в пользу исполнителя
    VOIDED = "voided"        # холд снят
    REFUNDED = "refunded"    # возврат
    DISPUTED = "disputed"    # расхождение в подтверждении
    FAILED = "failed"        # ошибка провайдера; ретраи идемпотентны (Р-4)
```

```python
class DisputeOutcome(Enum):
    RESOLVED_BY_DIALOGUE = "resolved"
    CAP_REACHED = "cap_reached"
    ESCALATED_TO_COURT = "escalated_to_court"
```

```python
class Sphere(Enum):
    """Сфера деятельности. Обязательный атрибут договора/ветки этапов.
    Р-3: в РЕАЛИЗАЦИИ это ТАБЛИЦА-СПРАВОЧНИК (спека §5.2.5: «sphere(...) — справочник, не enum»),
    чтобы сферы добавлялись данными без миграций кода. Enum здесь — упрощение псевдокода."""
    RENOVATION = "renovation"
    DELIVERY = "delivery"
    TUTORING = "tutoring"
    IT = "it"
    HOUSEHOLD = "household"
    DESIGN = "design"
    OTHER = "other"
```

```python
class MaterialSource(Enum):
    CONTRACTOR = "contractor"
    CUSTOMER = "customer"
```

```python
class DocumentType(Enum):
    ACT = "act"
    INVOICE = "invoice"
    RECEIPT = "receipt"
    CONTRACT_PDF = "contract_pdf"
    EVIDENCE_PACKAGE = "evidence_package"
```

```python
class PlatformRole(Enum):
    SUPPORT = "support"
    COMPLIANCE = "compliance"
    FINANCE = "finance"
    ADMIN = "admin"
```

```python
class NotificationChannel(Enum):
    """Каналы уведомлений. ЮРИДИЧЕСКИЙ момент доставки — размещение в личном кабинете (ADR-057)."""
    IN_APP = "in_app"   # размещение в личном кабинете — ЮРИДИЧЕСКИЙ носитель доставки (ADR-057)
    PUSH = "push"       # «звонок в дверь», дублирование; доставку не гарантирует, момента доставки не создаёт
    SMS = "sms"         # fallback для потребителей на правопрекращающих событиях (автоприёмка)
    EMAIL = "email"     # ОПЦИОНАЛЬНОЕ дублирование по желанию пользователя; НЕ юридический канал
```

---

# 2. БАЗОВЫЕ ТИПЫ (VALUE OBJECTS)

```python
class Money:
    """Денежная величина. ВСЕГДА пара сумма+валюта (задел на мультивалютность)."""
    def __init__(self, amount: Decimal, currency: str):
        self.amount = amount
        self.currency = currency

    def __add__(self, other: "Money") -> "Money":
        assert self.currency == other.currency, "Разные валюты складывать нельзя"
        return Money(self.amount + other.amount, self.currency)

    def __le__(self, other: "Money") -> bool:
        assert self.currency == other.currency
        return self.amount <= other.amount
```

```python
class Address:
    def __init__(self):
        self.street: str = ""
        self.city: str = ""
        self.region: str = ""
        self.postal_code: str = ""
        self.country: str = ""       # ISO 3166-1
```

```python
class TaxIdentifier:
    """Налоговый идентификатор. Гибкая пара тип+значение."""
    def __init__(self, id_type: str, value: str):
        self.id_type = id_type   # 'INN', 'OGRN', 'VAT', 'EIN'
        self.value = value
```

```python
class BankDetails:
    def __init__(self):
        self.data: dict = {}   # {'bic':..., 'account':...} или {'iban':..., 'swift':...}
```

```python
class IntegrityHash:
    """Идентификатор целостности замороженной версии."""
    def __init__(self, value: str, algorithm: str = "sha256"):
        self.value = value
        self.algorithm = algorithm
```

---

# 3. СУБЪЕКТЫ

## 3.1. User

```python
class User:
    """Человек с удостоверением личности. Сам по себе НИКОГДА не сторона договора — только через профиль.
    Репутации у User НЕТ (она живёт в профиле). Идентичность (TrustID) — у субъекта, не у роли."""

    def __init__(self):
        self.id: UUID = uuid4()

        # СКВОЗНОЙ ИДЕНТИФИКАТОР СУБЪЕКТА (соцграф, Часть II-A концепции, 10d).
        # Один человек — один TrustID, без привязки к роли. Пока СКРЫТ (в UI не показывается),
        # задел под блокчейн-контур. Закладывается сразу — ретроспективно не добавляется без боли.
        self.trust_id: str = ""

        # Публичный сменяемый хендл (10e). НЕ доказывает личность — рядом всегда виден статус верификации.
        self.handle: str = ""            # '@petrov'; см. Handle-правила в 3.6

        self.phone: str = ""
        self.email: str = ""
        self.full_name: str = ""

        self.verification_level: VerificationLevel = VerificationLevel.BASIC

        # Удостоверение личности — ЗАШИФРОВАНО индивидуальным ключом (crypto-shredding).
        self.identity_document_encrypted: bytes = b""
        self.identity_document_type: str = ""
        self.identity_issuing_country: str = ""
        self.encryption_key_ref: str = ""

        # Р-1: СОБСТВЕННЫЙ бизнес-статус человека (СМЗ/ИП). ХРАНИМЫЙ флаг (спека §5.2.1:
        # user.has_business_status bool). Обновляется при подтверждении/закрытии собственного
        # бизнес-профиля, где субъект — сам человек (SOLE_PROPRIETOR / SELF_EMPLOYED,
        # claim по совпадению ИНН — OWNER_IDENTITY_MATCH).
        self._has_business_status: bool = False

        # Находимость (ADR-059 ФИНАЛ 01.08.2026 + 152-ФЗ-2025: молчание ≠ согласие).
        # discoverable_by_phone заполняется ТОЛЬКО явным выбором на шаге регистрации
        # «Данные и приватность»: NULL до выбора, завершить регистрацию с NULL нельзя,
        # дефолтов в БД НЕТ. История согласий — Consent (см. 3.6, дельта Э3-3.3).
        # Находимость по @handle и прямой ссылке/QR — всегда; контрагент по сделке видит всегда.
        self.discoverable_by_phone: bool | None = None
        self.discoverable_by_handle: bool = True   # не тумблер: хендл находим всегда (ADR-059 §3)

        self.is_active: bool = True
        self.is_banned: bool = False

    def available_entities(self) -> list["BusinessEntity"]:
        """Юрлица, которые пользователь вправе ПРЕДСТАВЛЯТЬ сейчас (операционный доступ).
        ЕДИНСТВЕННЫЙ источник истины — активные Representative.
        ВНИМАНИЕ: представительство ≠ бизнес-статус (см. has_business_status)."""
        return [r.business_entity for r in self.representations if r.is_active]

    def has_business_status(self) -> bool:
        """Р-1 (ИСПРАВЛЕНО 23.07.2026). Есть ли у человека СОБСТВЕННЫЙ бизнес-статус (СМЗ/ИП),
        через который идёт профессиональный доход. Используется в compute_segment (ADR-058, §6.6).

        ПРЕЖНЯЯ РЕДАКЦИЯ БЫЛА ОШИБОЧНОЙ: `any(self.available_entities())` давала статус любому
        активному Representative — наёмный менеджер чужого ООО «становился бизнесом», и его
        ЛИЧНЫЕ возмездные услуги уходили в PAID_BUSINESS вместо FREE_C2C, ломая правило
        «плавного входа в предпринимательство» (§6.6 п. 2).

        ПРАВИЛЬНАЯ семантика: статус есть, только если существует активный СОБСТВЕННЫЙ
        бизнес-субъект (ИП/СМЗ, где владелец — сам человек, claim = OWNER_IDENTITY_MATCH).
        В БД — хранимый флаг; здесь он и возвращается. Обязательный тест:
        «активный Representative чужого ООО + личная возмездная услуга → free_c2c»."""
        return self._has_business_status
```

## 3.2. BusinessEntity

```python
class BusinessEntity:
    """Юрлицо / ИП / самозанятый. Существует НЕЗАВИСИМО от человека.
    Создаётся User'ом, но не принадлежит ему. Может представляться многими людьми."""

    def __init__(self):
        self.id: UUID = uuid4()

        # СКВОЗНОЙ ИДЕНТИФИКАТОР СУБЪЕКТА (10d): одно юрлицо — один TrustID, скрытый, задел под блокчейн.
        self.trust_id: str = ""
        self.handle: str = ""            # публичный хендл юрлица (10e)

        self.country_of_registration: str = ""   # ISO 3166-1 — определяет JurisdictionConfig

        # Форма собственности — ВЫБОР ИЗ СПРАВОЧНИКА LocalEntityForm.
        self.local_form_code: str = ""           # 'ru_ooo' -> LocalEntityForm.code
        # Налоговый режим — ВЫБОР ИЗ СПРАВОЧНИКА LocalTaxRegime (фильтруется по форме).
        self.tax_regime_code: str = ""           # 'ru_npd' -> LocalTaxRegime.code

        self.name: str = ""
        self.short_name: str = ""
        self.tax_identifiers: list[TaxIdentifier] = []
        self.registered_address: Address = Address()
        self.bank_details: BankDetails = BankDetails()
        self.documents_encrypted: list[bytes] = []

        # === ДВА РАЗНЫХ ВОПРОСА — НЕ ПУТАТЬ (см. 3.2.2) ===
        # 1. ПОДЛИННОСТЬ ДАННЫХ (сверка с реестром)
        self.verification_status: str = "draft"
        self.verified_against_registry: bool = False
        self.verified_at: datetime | None = None
        # 2. ПОДТВЕРЖДЕНИЕ КОНТРОЛЯ (не следует из п.1!)
        self.claim_status: "EntityClaimStatus" = None
        self.claimed_by: UUID | None = None
        self.claim_method: "ClaimMethod" | None = None
        self.claimed_at: datetime | None = None

        # --- Директор ---
        self.director_full_name: str = ""
        self.director_position_label: str = ""
        self.director_since: date | None = None
        self.director_source: str = "registry"
        self.director_user: UUID | None = None

        self.created_by: UUID = None

    def registry_verified_directors(self) -> list["SigningAuthority"]:
        return [s for s in self.signing_authorities
                if s.is_active and s.basis == SigningBasis.REGISTRY_VERIFIED_DIRECTOR]

    def form(self) -> LocalEntityForm:
        return jurisdiction_config_by_country(self.country_of_registration) \
                   .entity_forms[self.local_form_code]

    def entity_type(self) -> EntityType:
        """Универсальный тип — ВЫЧИСЛЯЕТСЯ из справочника, не хранится отдельно."""
        return self.form().entity_type

    def tax_regime(self) -> LocalTaxRegime:
        return jurisdiction_config_by_country(self.country_of_registration) \
                   .tax_regimes[self.tax_regime_code]

    def display_form(self) -> str:
        return self.form().label


def validate_entity_reference_data(entity: BusinessEntity):
    """Валидация выбора из справочников — на входе."""
    config = jurisdiction_config_by_country(entity.country_of_registration)
    assert entity.local_form_code in config.entity_forms, "форма не из справочника страны"
    form = config.entity_forms[entity.local_form_code]
    assert form.is_active, "форма больше не доступна для выбора"
    assert entity.tax_regime_code in form.allowed_tax_regimes, \
        "этот налоговый режим недопустим для выбранной формы собственности"
    provided = {t.id_type for t in entity.tax_identifiers}
    for required in form.required_tax_id_types:
        assert required in provided, f"не заполнен обязательный идентификатор: {required}"
```

## 3.2.1. Онбординг юрлица: достаточно одного идентификатора

```python
class RegistryEntityData:
    """Карточка компании из государственного реестра."""
    def __init__(self):
        self.found: bool = False
        self.name: str = ""
        self.short_name: str = ""
        self.local_form_code: str = ""
        self.tax_identifiers: list[TaxIdentifier] = []
        self.registered_address: Address = Address()
        self.director_full_name: str = ""
        self.director_position_label: str = ""
        self.director_since: date | None = None
        self.is_active_in_registry: bool = True
        self.fetched_at: datetime = now()


def register_entity_by_tax_id(tax_id: str, country: str, created_by: User) -> BusinessEntity:
    """Пользователь вводит ОДИН идентификатор — остальное из реестра. Ручной ввод — только fallback."""
    config = jurisdiction_config_by_country(country)
    if not config.registry_director_lookup_available:
        return create_entity_manually(country, created_by)

    data = config.verification_provider.fetch_entity_data(tax_id)
    if not data.found:
        raise NotFound("Компания с таким идентификатором не найдена в реестре")
    if not data.is_active_in_registry:
        raise Forbidden("Компания ликвидирована или недействующая по данным реестра")

    entity = BusinessEntity()
    entity.country_of_registration = country
    entity.created_by = created_by.id
    entity.name = data.name
    entity.short_name = data.short_name
    entity.local_form_code = data.local_form_code
    entity.tax_identifiers = data.tax_identifiers
    entity.registered_address = data.registered_address
    entity.director_full_name = data.director_full_name
    entity.director_position_label = data.director_position_label
    entity.director_since = data.director_since
    entity.director_source = "registry"

    entity.verified_against_registry = True
    entity.verification_status = "verified"
    entity.verified_at = now()
    # КОНТРОЛЬ не подтверждён — карточка ИНЕРТНА (см. 3.2.2)
    entity.claim_status = EntityClaimStatus.UNCLAIMED
    try_auto_claim(entity, created_by)
    return entity
```

## 3.2.2. Подтверждение контроля над юрлицом (защита от захвата карточки)

```python
class EntityClaimStatus(Enum):
    UNCLAIMED = "unclaimed"        # карточка есть, контроль не подтверждён -> ИНЕРТНА
    PENDING = "pending"
    CLAIMED = "claimed"
    DISPUTED = "disputed"


class ClaimMethod(Enum):
    """Способы доказать контроль — по убыванию силы и автоматизируемости."""
    DIRECTOR_IDENTITY_MATCH = "director_identity_match"   # верифиц. пользователь = директор в реестре (авто)
    OWNER_IDENTITY_MATCH = "owner_identity_match"         # ИП/самозанятый: ИНН физлица = ИНН бизнес-единицы (авто)
    ORGANIZATION_ESIGNATURE = "organization_esignature"  # [Л] ЭП организации
    NOTARIZED_POA = "notarized_poa"                       # нотариальная доверенность по реестру
    BANK_ACCOUNT_PROOF = "bank_account_proof"             # контрольный платёж со счёта компании
    POSTAL_TO_LEGAL_ADDRESS = "postal_to_legal_address"   # код письмом на юр. адрес
    MANUAL_REVIEW = "manual_review"                       # ручная экспертиза (fallback)


def try_auto_claim(entity: BusinessEntity, user: User) -> bool:
    """Автоматическое подтверждение контроля — ИП/самозанятые по ИНН, директор по ФИО."""
    if user.verification_level < VerificationLevel.VERIFIED:
        return False
    if entity.entity_type() in (EntityType.SOLE_PROPRIETOR, EntityType.SELF_EMPLOYED):
        if user.personal_tax_id == entity.tax_id_of_type("INN"):
            _apply_claim(entity, user, ClaimMethod.OWNER_IDENTITY_MATCH)
            # Р-1: подтверждён СОБСТВЕННЫЙ ИП/СМЗ -> у человека появляется бизнес-статус
            user._has_business_status = True
            return True
    if entity.director_full_name and user.verified_full_name == entity.director_full_name:
        _apply_claim(entity, user, ClaimMethod.DIRECTOR_IDENTITY_MATCH)
        entity.director_user = user.id
        # ВНИМАНИЕ (Р-1): директорство ЧУЖОГО юрлица бизнес-статуса ФИЗЛИЦУ не даёт —
        # юрлицо само по себе субъект; личные услуги директора как физлица остаются free_c2c.
        return True
    return False


def _apply_claim(entity: BusinessEntity, user: User, method: ClaimMethod):
    entity.claim_status = EntityClaimStatus.CLAIMED
    entity.claimed_by = user.id
    entity.claim_method = method
    entity.claimed_at = now()
    audit_log.append("entity_claimed", entity.id, user.id, method)


def assert_entity_operable(entity: BusinessEntity):
    """ГЕЙТ: карточка без подтверждённого контроля существует, но ИНЕРТНА."""
    if entity.claim_status != EntityClaimStatus.CLAIMED:
        raise Forbidden(
            "Контроль над юрлицом не подтверждён. Недоступно: договоры, выдача полномочий, "
            "портфолио, репутация, показ в поиске."
        )


def dispute_entity_claim(entity: BusinessEntity, claimant: User, proof) -> bool:
    """Возврат захваченной карточки: директор по реестру ВСЕГДА побеждает."""
    entity.claim_status = EntityClaimStatus.DISPUTED
    if claimant.verified_full_name == entity.director_full_name:
        revoke_all_authorities(entity)
        _apply_claim(entity, claimant, ClaimMethod.DIRECTOR_IDENTITY_MATCH)
        entity.director_user = claimant.id
        notify_previous_claimer(entity)
        return True
    return queue_manual_review(entity, claimant, proof)
```

> ⚠ Механизм claim **требует упрощения** (7 способов избыточно; гипотеза — claim = выдача первого SigningAuthority). Пересмотреть до начала разработки. Юрпроверка: ЭП организации, контрольный платёж, порядок возврата.

## 3.3. Профиль (полиморфный: User ИЛИ BusinessEntity)

```python
class Profile:
    """Базовый профиль роли. Принадлежит ЛИБО User, ЛИБО BusinessEntity (ровно одна ссылка).
    Репутация всегда живёт здесь. Идентичность (TrustID) — у субъекта-владельца, не у профиля."""

    def __init__(self):
        self.id: UUID = uuid4()
        self.owner_user: UUID | None = None
        self.owner_entity: UUID | None = None
        self.reputation_by_sphere: dict[Sphere, "SphereReputation"] = {}
        self.memberships: list["Membership"] = []
        self.portfolio: "Portfolio" = None
        # Видимость (ADR-059 финал, Р5/Р6; дельта Э3-3.3 п.4). У person-профиля — настройки;
        # БИЗНЕС-ПРОФИЛЬ настройки игнорирует: всегда public, пока активен (CHECK/гейт + тест).
        self.profile_visibility: str = "public"     # 'public' | 'link_and_deals' (из согласия №2)
        self.hide_from_catalog: bool = False
        self.show_name: bool = True                 # False = «только @handle»
        self.avatar_visibility: str = "public"      # 'public' | 'deals_only'
        self.city_name: str = ""                    # публично — только город (Р6)
        self.works_remotely: bool = False

    def check_exactly_one_owner(self) -> bool:
        return (self.owner_user is None) != (self.owner_entity is None)
```

```python
class CustomerProfile(Profile):
    """Роль заказчика. Для заказчика-посредника — витрина заказчика-посредника (Путь Г).
    Оценка заказчика — на ФАКТАХ (скорость приёмки, доля отклонений, споры), а не отзывах."""
    def __init__(self):
        super().__init__()
        self.default_location: Address | None = None
        self.preferred_categories: list[Sphere] = []
        self.preferred_entity: UUID | None = None      # валидируется против активных Representative
        # Витрина заказчика-посредника
        self.about: str = ""
        self.hiring_spheres: list[Sphere] = []
        self.is_open_to_offers: bool = False


class ContractorProfile(Profile):
    """Роль исполнителя. Членство — в Profile.memberships; портфолио — в Profile.portfolio."""
    def __init__(self):
        super().__init__()
        self.bio: str = ""
        self.categories: list[Sphere] = []
        self.external_links: list[str] = []
        self.preferred_entity: UUID | None = None
```

```python
# ⚠ ЮРИДИЧЕСКИЙ РИСК: ПОДМЕНА ТРУДОВЫХ ОТНОШЕНИЙ.
# Заказчик-посредник, регулярно набирающий одного исполнителя, граничит с трудовыми отношениями.
# Защита по существу: модель на ПОДРЯДЕ (результат + приёмка), а не на труде.
# Опасна ЛЕКСИКА: не лексика трудовых отношений, а «проекты/подряды/заказы/исполнители».
# Механизм — счётчик систематичности (раздел 18), третье применение: одна пара «заказчик-исполнитель»
# систематически -> предупредить ОБЕ стороны (информация, не блокировка). ⚠ ADR + юрпроверка порогов.
```

## 3.4. Портфолио и проекты

```python
class Portfolio:
    """Витрина проектов. У ЛЮБОГО профиля. У исполнителя — «что я сделал», у заказчика — «что я заказывал».
    НЕ заменяет репутацию (та — статистика поведения)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.profile_id: UUID = None
        self.headline: str = ""
        self.projects: list["PortfolioProject"] = []

    def verified_count(self) -> int:
        return len([p for p in self.projects if p.is_verified])


class ProjectSource(Enum):
    MANUAL = "manual"                  # заявлено (проверить нельзя); для холодного старта
    FROM_CONTRACT = "from_contract"    # собран из выполненного договора -> ПОДТВЕРЖДЁН


class PortfolioProject:
    """Проект: описание + фото + факты. Различение факт/заявление — как везде."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.portfolio_id: UUID = None
        self.title: str = ""
        self.description: str = ""
        self.sphere: Sphere = None
        self.completed_at: date | None = None
        self.location_label: str = ""         # ОБОБЩЁННО ('Москва, ЮЗАО'), НЕ точный адрес
        self.media: list["MediaItem"] = []
        self.order: int = 0
        self.source: ProjectSource = ProjectSource.MANUAL
        self.source_contract: UUID | None = None
        self.is_verified: bool = False        # True ТОЛЬКО у FROM_CONTRACT
        self.verified_facts: dict = {}        # не редактируется стороной
        self.is_published: bool = False
        self.counterparty_consent: bool = False   # согласие ВТОРОЙ стороны


def sanitize_for_portfolio(media: "MediaItem") -> "MediaItem":
    """ПРИВАТНОСТЬ: доказательные фото содержат геометку = адрес заказчика. В портфолио — ОЧИЩЕННАЯ копия
    (EXIF снят); оригинал и хеш в доказательной базе НЕТРОНУТЫ."""
    copy = media.clone()
    copy.strip_exif()
    copy.evidence_role = None
    return copy


def publish_project(project: PortfolioProject, profile: Profile):
    """Публикация из договора требует СОГЛАСИЯ ВТОРОЙ СТОРОНЫ (у исполнителя — приватность заказчика,
    у заказчика — атрибуция исполнителя)."""
    if project.source == ProjectSource.FROM_CONTRACT:
        assert project.counterparty_consent, "нужно согласие второй стороны договора"
    assert not contains_personal_data(project), "в проекте не должно быть ПД второй стороны"
    project.is_published = True
```

## 3.5. Членство в объединениях (гильдии, СРО, ассоциации)

```python
# ЕДИНЫЙ механизм для человека и юрлица (Profile полиморфен). Различие «личное/организационное» —
# свойство ОБЪЕДИНЕНИЯ (Community.kind), а не повод для двух структур.

class MembershipKind(Enum):
    PERSONAL_QUALIFICATION = "personal_qualification"   # следует за человеком (профиль User)
    ORGANIZATION_MEMBERSHIP = "organization_membership" # принадлежит юрлицу (профиль BusinessEntity)


class Community:
    """Профессиональное объединение: гильдия, СРО, ассоциация, палата.
    v9: объединение может быть АДРЕСУЕМЫМ субъектом-витриной (10i), НО остаётся ТОЛЬКО ГРУППИРОВКОЙ:
    не носит TrustID/@username/репутацию и НЕ является стороной договора (см. AddressableGroup, 3.6)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.name: str = ""
        self.kind: MembershipKind = None
        self.spheres: list[Sphere] = []
        # [Л] Обязательность членства — вопрос законодательства страны (в РФ — СРО в строительстве)
        self.country_code: str = ""
        self.is_mandatory_for: list[Sphere] = []
        self.quality_standards: list[str] = []
        self.registry_url: str = ""
        self.verification_available: bool = False


class Membership:
    """Членство профиля в объединении."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.profile_id: UUID = None
        self.community_id: UUID = None
        self.member_number: str = ""
        self.since: date | None = None
        self.valid_until: date | None = None
        self.is_verified: bool = False
        self.verification_source: str = ""     # 'registry' | 'document' | 'declared'
        self.is_active: bool = True


def check_mandatory_memberships(contract: Contract) -> list[str]:
    """[Л] Обязательное членство: ПРЕДУПРЕЖДАЕМ, но не блокируем (информация вместо наказания)."""
    warnings = []
    config = jurisdiction_config(contract)
    contractor = contract.contractor_profile()
    for sphere in contract.spheres():
        for community in [c for c in config.communities if sphere in c.is_mandatory_for]:
            if not has_active_verified_membership(contractor, community):
                warnings.append(f"нет подтверждённого членства: {community.name}")
    return warnings
```

## 3.6. Идентичность и социальный граф (Часть II-A концепции)

```python
# ПРИНЦИП: строим ГРАФ ДОВЕРИЯ (сеть подтверждённых делом связей), а не граф внимания.
# TrustID и @username — атрибуты СУБЪЕКТА (User/BusinessEntity, см. 3.1/3.2), заведены там.
# Ниже — сущности хендла, контактов, графа и адресуемого объединения.

class Consent:
    """Согласие пользователя (ADR-059 финал, 01.08.2026; 152-ФЗ: с 01.09.2025 согласия — только
    отдельными документами, молчание ≠ согласие). Три типа на регистрации: обработка ПД (без него
    регистрация не завершается), публичность профиля (= согласие на распространение),
    находимость по телефону. История НЕ перезаписывается: новое согласие/отзыв = новая строка.
    Хранится под envelope-ключом пользователя (crypto-shredding покрывает как ПД)."""
    def __init__(self):
        self.user: UUID = None
        self.consent_type: str = ""     # 'pd_processing' | 'profile_public' | 'phone_discoverability'
        self.value: bool = None
        self.text_version: str = ""     # версия текста согласия (док 26 §4)
        self.granted_at: datetime = now()
        self.device_info: str = ""
        self.ip: str = ""


class Handle:
    """Публичный хендл @username. НЕ доказывает личность (10e): рядом всегда виден статус верификации.
    История смен хранится служебно (антифрод — как частая смена директора)."""
    def __init__(self):
        self.value: str = ""                 # без '@', нижний регистр
        self.subject_trust_id: str = ""      # чей
        self.assigned_at: datetime = now()
        self.is_active: bool = True

    # Антифрод и защита:
    # - анти-сквоттинг (лимиты на массовый захват/перепродажу);
    # - запрет вводящих в заблуждение имён (госорганы, банки, чужие ФИО) — по жалобе и проактивно;
    # - неиспользуемые могут высвобождаться по правилам (детализировать — открытый вопрос 16).


def resolve_handle(handle: str) -> dict:
    """Поиск по хендлу ВСЕГДА возвращает вместе со статусом верификации субъекта —
    хендл сам по себе доказательством личности не является."""
    subject = subject_by_handle(handle)
    return {"subject": subject, "verified": subject.verification_level >= VerificationLevel.VERIFIED}


class Contact:
    """Личная адресная книга участника ВНУТРИ платформы (10h).
    Пополняется вручную И автоматически теми, с кем субъект РЕАЛЬНО закрыл договор
    (подтверждённая делом сеть)."""
    def __init__(self):
        self.owner_trust_id: str = ""
        self.contact_trust_id: str = ""
        self.custom_label: str = ""          # переименование контакта владельцем
        self.source: str = "manual"          # 'manual' | 'from_contract'
        self.added_at: datetime = now()


def find_by_phonebook(user: User, hashed_numbers: list[str]) -> list[dict]:
    """[Л] Поиск по контактам (10f). Сверка по НЕОБРАТИМЫМ ХЕШАМ (модель Signal):
    сырая книга на сервер не загружается. Возвращаем только тех, кто РАЗРЕШИЛ находимость по номеру.
    Факт присутствия на платформе не раскрывается без согласия. ⚠ Юрпроверка 152-ФЗ (вопрос 17)."""
    assert user.consented_contact_matching, "нужно явное логируемое согласие на сверку контактов"
    found = []
    for h in hashed_numbers:
        subj = subject_by_phone_hash(h)
        if subj and subj.discoverable_by_phone:
            found.append({"subject": subj})
    return found
    # Приглашения-рассылки по книге НЕ делаем (10k) — только адресная ссылка/QR (share_reputation_link).


def share_reputation_link(subject) -> str:
    """Ссылка/QR ВСЕГДА ведёт на карточку РЕПУТАЦИИ (10g), а не на пустую страницу.
    Реализует офлайн-«по рукам»: отсканировал QR -> видна история выполненных обещаний."""
    return build_public_reputation_url(subject.trust_id)


def trust_graph_hints(viewer, subject) -> dict:
    """Общие связи и «рукопожатия» (10h, задел). Показываем ФАКТ связи, а не оценку,
    без лишних ПД. ⚠ Правила раскрытия — открытый вопрос 19."""
    return {
        "common_verified_contacts": count_common_closed_deal_contacts(viewer, subject),
        "handshake_distance": graph_distance_via_closed_deals(viewer, subject),
    }


class AddressableGroup:
    """Объединение как АДРЕСУЕМЫЙ субъект-ВИТРИНА (10i). Витрина НАД реальными субъектами.
    ЖЁСТКО: не носит TrustID/@username и НЕ имеет своей репутации; НЕ сторона договора.
    Договоры подписывает ЛИДЕР от своего имени (своя репутация и право подписи).
    Хочет группа быть самостоятельным субъектом права — регистрирует BusinessEntity."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.community_id: UUID | None = None   # может опираться на Community (3.5)
        self.display_name: str = ""
        self.share_slug: str = ""               # адресная ссылка/QR БЕЗ собственного @username
        self.leader_trust_id: str = ""          # реальный субъект: организует группу и ПОДПИСЫВАЕТ
        self.admin_trust_id: str = ""           # управляет составом; может совпадать с лидером
        self.member_trust_ids: list[str] = []   # участники — реальные субъекты со своими фактами

    def signing_party(self) -> str:
        """Стороной договора всегда является ЛИДЕР (субъект), не объединение."""
        return self.leader_trust_id
    # ⚠ Полная механика (права лидера/админа, агрегация карточки) — отдельный ADR (вопрос 15).
```

---

# 4. ПОЛНОМОЧИЯ

```python
class Representative:
    """Операционный доступ к работе от имени юрлица. НИЗКИЙ риск. НЕ даёт права подписи."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.user: UUID = None
        self.business_entity: UUID = None
        self.role: RepresentativeRole = RepresentativeRole.MEMBER
        self.permissions: list[Permission] = []
        self.is_active: bool = True
        self.approved_by: UUID | None = None

    def can(self, permission: Permission) -> bool:
        return self.is_active and permission in self.permissions


class SigningAuthority:
    """Право юридически подписывать договор от имени юрлица. ВЫСОКИЙ риск. Только 1-3 человека на юрлицо."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.user: UUID = None
        self.business_entity: UUID = None
        self.basis: SigningBasis = None
        self.max_amount: Money | None = None
        self.poa_registry_id: str | None = None
        self.parent_authority: UUID | None = None
        self.last_verified_at: datetime | None = None
        self.expires_at: datetime | None = None
        self.is_active: bool = True

    def can_sign_amount(self, amount: Money) -> bool:
        if not self.is_active:
            return False
        return self.max_amount is None or amount <= self.max_amount

    def is_valid_now(self) -> bool:
        """Для нотариальной доверенности — перепроверять по реестру при КАЖДОМ подписании."""
        if not self.is_active:
            return False
        if self.expires_at and self.expires_at < now():
            return False
        if self.basis in (SigningBasis.NOTARIZED_POA, SigningBasis.CHAINED_DELEGATION):
            return registry.check_poa_active(self.poa_registry_id)
        return True


def grant_signing_authority(entity: BusinessEntity, user: User, basis: SigningBasis) -> SigningAuthority:
    """Для форм с разделёнными ролями (ООО/АО) ручная экспертиза НЕ допускается."""
    if entity.form().has_separated_ownership and basis == SigningBasis.MANUAL_REVIEW:
        raise Forbidden("Нужен верифицированный директор или нотариальная доверенность")
    if basis == SigningBasis.REGISTRY_VERIFIED_DIRECTOR:
        assert registry.director_matches(entity, user), "ФИО не совпадает с реестром"
    # ... создание и возврат SigningAuthority
```

---

# 5. ЭПОХИ ВЛАДЕНИЯ

```python
class OwnershipEpoch:
    """Период владения юрлицом. Граница — при смене директора по реестру.
    Защищает от «покупки репутации». Отображается ТОЛЬКО если смена реально была."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.business_entity: UUID = None
        self.epoch_number: int = 1
        self.director_identity_hash: str = ""
        self.started_at: datetime = None
        self.ended_at: datetime | None = None
        self.detected_via: str = "initial_verification"
        self.reputation_snapshot: dict | None = None
        self.contracts_count: int = 0


def scheduled_registry_check(entity: BusinessEntity):
    """Периодическая ФОНОВАЯ сверка: контроль мог смениться, а старая SigningAuthority осталась."""
    current = registry.get_director_hash(entity)
    active = get_active_epoch(entity)
    if current != active.director_identity_hash:
        active.ended_at = now()
        active.reputation_snapshot = snapshot_reputation(entity)
        open_new_epoch(entity, current, detected_via="scheduled_registry_check")


def appeal_epoch_transition(entity: BusinessEntity, proof: dict):
    """ФЗ-289: право оспорить снижение рейтинга. Нет реальной смены контроля -> эпохи СЛИВАЮТСЯ обратно."""
    if verify_no_control_change(proof):
        merge_last_two_epochs(entity)
    log_appeal(entity, proof)
```

---

# 6. ДОГОВОР

## 6.1. Contract

```python
class Contract:
    """Договор. После подписания НЕИЗМЕНЯЕМ — изменения только цепочкой допников."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.negotiation_status: NegotiationStatus = NegotiationStatus.DRAFT
        self.execution_status: ContractExecutionStatus | None = None   # None до подписания
        self.deal_type: DealType = None   # B2B/B2C/C2C — режим регулирования

        # --- Тип договора и сегмент монетизации (ADR-058) ---
        # Тип выбирается из справочника (ContractTypeCatalogItem, см. 15). Сегмент ВЫЧИСЛЯЕТСЯ
        # из типа + статуса исполнителя (см. compute_segment). Определяет, берём ли комиссию (раздел 10).
        self.contract_type_code: str = ""            # напр. 'services', 'loan', 'realty_sale', 'lease'
        self.segment: ContractSegment | None = None  # вычисляется при создании/подписании

        # Стороны — через ContractParty (ровно один customer и один contractor)
        self.customer_contact: UUID = None
        self.contractor_contact: UUID = None

        self.payment_method: PaymentMethod = None
        # Порядок оплаты (репо-ADR-151): условие договора, обязателен при отправке на
        # согласование для услуги/продажи/аренды, None у займа. Входит в snapshot заморозки.
        # Фаза 1 — только условие (текст договора); исполнение предоплаты «до начала этапа»
        # в FSM этапа (сейчас единственный денежный переход — accepted -> paid) — фаза 2,
        # открытый вопрос владельцу.
        self.payment_order: PaymentOrder | None = None
        self.protected: bool = False   # есть ли защита платежа (для метки и репутации)
        self.uses_platform_template: bool = True
        self.frozen_version: UUID | None = None
        self.created_at: datetime = now()

    def total_amount(self) -> Money:
        return sum_money(m.amount for m in self.leaf_milestones())

    def leaf_milestones(self) -> list["Milestone"]:
        return [m for m in self.all_milestones() if m.is_leaf()]

    def effective_terms(self) -> dict:
        terms = self.frozen_version.snapshot
        for amendment in self.amendments_ordered():
            terms = apply_amendment_terms(terms, amendment)
        return terms
```

```python
def compute_segment(contract: Contract) -> ContractSegment:
    """Сегмент монетизации (ADR-058) = тип договора + статус исполнителя.
    Комиссию за заключение берём только в PAID_BUSINESS и SPECIAL (см. compute_contract_fee, раздел 10)."""
    cfg = jurisdiction_config(contract)
    ctype = cfg.contract_types[contract.contract_type_code]

    if ctype.segment == ContractSegment.EXCLUDED:
        raise Forbidden("Этот тип сделки платформа не готовит")   # и в UI не показывается

    if ctype.segment == ContractSegment.SPECIAL:
        return ContractSegment.SPECIAL                       # недвижимость/транспорт, аренда — комиссия

    if ctype.always_free:
        return ContractSegment.FREE_C2C                      # заём, дарение, ЛПХ, продажа личного и т.п.

    # Возмездные услуги/работы: бесплатно, ПОКА исполнитель — физлицо без СОБСТВЕННОГО
    # бизнес-статуса (Р-1: представительство чужого юрлица статуса НЕ даёт).
    contractor = contract.contractor_party()
    if contractor.entity is None and not user_of(contractor.profile).has_business_status():
        return ContractSegment.FREE_C2C                      # «плавный вход»; счётчик систематичности ведёт к СМЗ
    return ContractSegment.PAID_BUSINESS                     # исполнитель — бизнес -> комиссия
```

## 6.2. ContractParty (структура сторон)

```python
class ContractParty:
    """Сторона договора. Роль 'subcontractor' УПРАЗДНЕНА (ADR-040): субподряд — это СВЯЗИ между
    обычными двухсторонними договорами (ContractLink, раздел 19). Валидация: ровно один customer и один contractor."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.role: str = ""   # 'customer' | 'contractor'
        self.profile: UUID = None
        self.entity: UUID | None = None   # null, если физлицо (важно для compute_segment)
        self.share: Decimal | None = None  # не используется (наследие)
```

## 6.3. ContractVersion (замороженный снимок)

```python
class ContractVersion:
    """Неизменяемый снимок содержимого на момент заморозки. Подпись — на ЕГО идентификатор целостности."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        # Снимок: текст, параметры, чек-лист, материалы, приложения, признак бланка,
        # реквизиты сторон, основания подписи, ТИП ДОГОВОРА и СЕГМЕНT (ADR-058), тип сделки — НА МОМЕНТ заморозки
        self.snapshot: dict = {}
        self.integrity_hash: IntegrityHash = None
        self.frozen_at: datetime = now()
        self.trusted_timestamp: str | None = None   # RFC 3161
```

---

# 7. ЭТАПЫ, ЧЕК-ЛИСТ, МАТЕРИАЛЫ

## 7.1. Milestone (рекурсивное дерево)

```python
class Milestone:
    """Этап — узел дерева. Ветки группируют, ЛИСТЬЯ принимаются и оплачиваются."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.parent: UUID | None = None
        self.order: int = 0
        self.title: str = ""
        self.status: MilestoneStatus = MilestoneStatus.PENDING
        self.created_by_amendment: UUID | None = None   # None — из исходного договора; UUID — из допника
        self.amount: Money | None = None                # ТОЛЬКО у листьев
        self.sphere: Sphere | None = None               # может задаваться на ветке (мультисферность)
        self.deadline: datetime | None = None
        self.depends_on: UUID | None = None
        self.frozen_days: int = 0

    def is_leaf(self) -> bool:
        return len(self.children()) == 0

    def computed_amount(self) -> Money:
        if self.is_leaf():
            return self.amount
        return sum_money(child.computed_amount() for child in self.children())

    def effective_sphere(self) -> Sphere:
        node = self
        while node is not None:
            if node.sphere is not None:
                return node.sphere
            node = node.parent_node()
        return Sphere.OTHER

    def can_start(self) -> bool:
        """Гейт — проверяется на входе в КАЖДЫЙ лист."""
        assert self.is_leaf()
        return self.contract_signed() and self.materials_ready() and self.financial_condition_met()
```

**Состояние условий гейта (ADR-155).** Наружу (`GET /milestones/{id}/gate`) гейт отдаёт не
только `can_start`, но и СОСТОЯНИЕ каждого из трёх условий: `waiting` (ждём) / `met`
(готово) / `not_required` (условия нет вовсе — у листа нет материалов заказчика; платить до
старта не надо). Пока договор не подписан, все три условия — `waiting`: до подписи
обязательства не возникли, и «Готово» по материалам или деньгам вводило бы в заблуждение.
`can_start` = все три в `{met, not_required}`.

**Порядок оплаты и гейт (ADR-151 + ADR-155).** При `Contract.payment_order = before_start`
финансовое условие листа — ОПЛАТА ЭТОГО ЛИСТА, подтверждённая обеими сторонами (способ
расчёта задаёт рельсы, но не срок). Счёт по листу выставляется сразу после подписания, а не
после приёмки; отдельного «аванса» при этом не бывает — платёж по листу ОДИН. Лист
проходит те же статусы, что и при постоплате, и закрывается `paid` В МОМЕНТ ПРИЁМКИ (деньги
пришли раньше, приёмка — последнее недостающее условие). При `after_acceptance` и у займа
(`payment_order = null`) финансовое условие считается по способу расчёта, как раньше.

## 7.2. ChecklistItem

```python
class ChecklistItem:
    """Пункт чек-листа = измеримый критерий приёмки. Привязан к листу. После подписания не редактируется."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.milestone: UUID = None
        self.source_template: UUID | None = None  # ChecklistTemplateItem, из которого сделан пункт
        self.description: str = ""
        self.measurable_criterion: str = ""
        self.required_evidence: list[str] = []
```

`source_template` (репо-ADR-153) — из какой РЕДАКЦИИ шаблонного пункта каталога (§15,
`ChecklistTemplateItem`, версионирование по `slug` — репо-ADR-081) сделан этот пункт; `None` —
сторона написала критерий сама. Определяется в момент создания по точному совпадению текста
(id шаблона до вызывающей стороны не доезжает: подсказки мастера — плоский список формулировок)
и дальше не пересчитывается: поле фиксирует происхождение, а не текущее совпадение. Тем же
сопоставлением создание пункта двигает счётчик востребованности шаблона
(`catalog.ChecklistTemplatePickStat`, ключ — `slug`, общий для всех редакций пункта) через фасад
`apps.catalog.services.record_checklist_pick` — каталог нижний слой и читать чек-листы этапов не
может, поэтому знание едет к нему, а не он за ним. Из этого счётчика строится порядок подсказок
критериев приёмки в мастере: сначала дефолтные, внутри — по убыванию востребованности.

## 7.3. Материалы и справочник

```python
class MaterialCatalogItem:
    """УНИВЕРСАЛЬНАЯ номенклатура (переводится). ЗАЧЕМ обязательна: по материалам этапа платформа
    РЕКОМЕНДУЕТ пункты чек-листа (материал -> чек-лист -> объективная приёмка -> меньше споров).
    ПРИНЦИП: справочник подсказывает, но НЕ ограничивает (единицы не валидируются)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.code: str = ""
        self.sphere: Sphere = None
        self.name_i18n: dict[str, str] = {}
        self.suggested_checklist_items: list[UUID] = []
        self.suggested_unit: str = ""       # только подсказка, не валидируется
        self.spec_template: list[str] = []
        self.is_active: bool = True
    # В каждой сфере есть позиция «Прочее» (code='other_<sphere>') — запасной выход;
    # частое «Прочее» с похожими описаниями -> сигнал, какой позиции не хватает (рост из спроса).


class DeliveryBase(Enum):
    CONTRACT_SIGNING = "contract_signing"
    PREPAYMENT = "prepayment"
    STAGE_START = "stage_start"


class ContractMaterial:
    """Материал в рамках договора. Часть замороженной версии. Привязан к ЭТАПУ (листу)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.milestone: UUID = None
        self.catalog_item: UUID = None            # ОБЯЗАТЕЛЬНО (минимум «Прочее»)
        self.description: str = ""                # ОБЯЗАТЕЛЬНО: производитель, характеристики, артикул
        self.external_url: str = ""
        self.photos: list["MediaItem"] = []
        self.quantity: Decimal = Decimal(0)
        self.unit: str = ""                       # полный список + возможность своей
        self.unit_price: Money = None             # 0 допустим ТОЛЬКО при source == CUSTOMER
        self.source: MaterialSource = None
        # Срок поставки — УСЛОВИЕ, а не дата: N дней от события (дата ВЫЧИСЛЯЕТСЯ)
        self.delivery_days: int = 0
        self.delivery_base: DeliveryBase = DeliveryBase.CONTRACT_SIGNING
        # ADR-155: передача материала — ДВА факта ДВУХ сторон, а не один флаг.
        # «Передал» ставит сторона-ИСТОЧНИК (`source`), «получил» — другая.
        # Порядок НЕ обязателен: получение отмечается односторонне
        # (владелец 03.09), «передано» — необязательный сигнал источника.
        self.handed_over_at: datetime | None = None
        self.handed_over_by: UUID | None = None
        self.received: bool = False
        self.received_at: datetime | None = None
        self.received_by: UUID | None = None

    def delivery_deadline(self, contract: Contract) -> date | None:
        base = {
            DeliveryBase.CONTRACT_SIGNING: contract.signed_at,
            DeliveryBase.PREPAYMENT:       contract.prepayment_confirmed_at,
            DeliveryBase.STAGE_START:      milestone_by_id(self.milestone).started_at,
        }[self.delivery_base]
        if base is None:
            return None          # событие не наступило -> срок не течёт (задержка предоплаты не жжёт срок)
        return base + timedelta(days=self.delivery_days)


def validate_material(m: ContractMaterial):
    assert m.catalog_item, "выберите позицию справочника (или «Прочее»)"
    assert m.description, "опишите материал: производитель, характеристики, артикул"
    if m.source == MaterialSource.CONTRACTOR:
        assert m.unit_price.amount > 0, "исполнитель не может поставлять материал по нулевой цене"
    assert m.delivery_days >= 0


def notify_material_problem(material: ContractMaterial, reason: str, evidence: list):
    """НЕ приостанавливает односторонне. Открывает окно на оспаривание (симметрично приёмке)."""
    notification = create_material_notification(material, reason, evidence)
    open_dispute_window(notification)


def hand_over_material(material: ContractMaterial, by_party: Party):
    """ADR-155: сторона-источник заявляет, что передала. Гейт этим шагом НЕ двигается —
    заявление одной стороны не факт (тот же принцип, что notify_material_problem).
    Шаг НЕОБЯЗАТЕЛЕН: получение можно отметить и без него."""
    assert by_party.role == material.source, "передачу отмечает поставляющая сторона"
    material.handed_over_at = now()


def confirm_material_received(material: ContractMaterial, by_party: Party):
    """ADR-155: получение подтверждает ТОЛЬКО принимающая сторона — иначе поставщик
    материалов открывал бы гейт этапа сам себе. Предварительное «передано» НЕ требуется
    (владелец 03.09: «исполнитель может в одностороннем порядке поставить получены»):
    факт фиксирует сторона, которой он невыгоден. `materials_ready()` смысла не менял —
    он по-прежнему смотрит на `received`."""
    assert by_party.role != material.source, "получение подтверждает принимающая сторона"
    material.received = True
    material.received_at = now()
```

Материалы (как и этапы с чек-листом) редактируются, пока договор редактируется —
draft/under_review; после заморозки версии правка возможна только допником (ADR-155).

---

# 8. ПОДПИСАНИЕ

```python
class SignatureRequest:
    """Адресный запрос подписи. Инициатор ЯВНО выбирает подписанта (фильтр по лимиту суммы). Рассылки «всем» нет."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.version: UUID = None
        self.side: str = ""          # 'customer' | 'contractor'
        self.routed_by: UUID = None
        self.signatory: UUID = None
        self.signing_authority: UUID = None
        self.status: str = "pending"  # pending|signed|forwarded|declined_for_revision|expired
        self.sent_at: datetime = now()
        self.expires_at: datetime | None = None
        self.comment: str = ""


def choose_signatories(contract: Contract, side: str) -> list[User]:
    entity = contract.entity_of_side(side)
    amount = contract.total_amount()
    return [s.user for s in entity.signing_authorities
            if s.is_valid_now() and s.can_sign_amount(amount)]


def on_signatory_response(request: SignatureRequest, action: str, comment: str = "", forward_to: UUID = None):
    if action == "sign":
        create_signature(request)
        if both_sides_signed_same_version(request.contract):
            c = request.contract
            c.negotiation_status = NegotiationStatus.SIGNED
            c.execution_status = ContractExecutionStatus.PENDING_START
            charge_contract_fee(c)   # комиссия за ЗАКЛЮЧЕНИЕ списывается в момент подписания (ADR-054)
    elif action == "forward":
        request.status = "forwarded"
        create_signature_request(request.contract, request.side, signatory=forward_to)
    elif action == "decline_for_revision":
        request.status = "declined_for_revision"
        request.comment = comment
        unfreeze_and_return_to_review(request.contract)   # аннулирует уже поставленные подписи


class Signature:
    """Подпись. Привязана к ИДЕНТИФИКАТОРУ ВЕРСИИ. Хранит снепшот основания на момент подписания."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.version_hash: str = ""
        self.side: str = ""
        self.signatory: UUID = None
        self.signed_at: datetime = now()
        self.signature_basis: SigningBasis = None
        self.entity_snapshot: dict = {}
        self.contact_snapshot: dict = {}
```

---

# 9. ДОПОЛНИТЕЛЬНЫЕ СОГЛАШЕНИЯ (AMENDMENT)

```python
class AmendmentChangeType(Enum):
    ADD_MILESTONE = "add_milestone"          # НОВЫЕ работы -> создаёт этап в дереве
    MODIFY_MILESTONE = "modify_milestone"
    REMOVE_MILESTONE = "remove_milestone"    # дельта ОТРИЦАТЕЛЬНАЯ
    ADD_MATERIAL = "add_material"
    MODIFY_MATERIAL = "modify_material"
    REMOVE_MATERIAL = "remove_material"
    CUSTOM_TERM = "custom_term"


class AmendmentChange:
    def __init__(self):
        self.type: AmendmentChangeType = None
        self.target: UUID | None = None
        self.payload: dict = {}
        self.amount_delta: Money = None   # может быть ОТРИЦАТЕЛЬНОЙ (скидка/убрали работы)
        self.days_delta: int = 0


class Amendment:
    """Допник — самостоятельный подписанный документ (мини-договор). Исходный НЕ перезаписывается — цепочка.
    Проходит ТОТ ЖЕ путь (NegotiationStatus). СОЗДАЁТ этапы (ADD_MILESTONE), но сам этапом не является.

    Р-5 (23.07.2026): класс переименован из AdditionalAgreement в Amendment — единообразно
    с термином спеки (§1.5), таблицей `amendment` (§5.2.4) и публичным API (/amendments)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.order: int = 0
        self.reason: str = ""
        self.changes: list[AmendmentChange] = []
        self.custom_terms: str = ""
        self.frozen_version: UUID | None = None
        self.status: NegotiationStatus = NegotiationStatus.DRAFT
        self.signatures: list["Signature"] = []

    def amount_delta(self) -> Money:
        return sum_money(c.amount_delta for c in self.changes)

    def days_delta(self) -> int:
        return sum(c.days_delta for c in self.changes)

    def creates_milestones(self) -> bool:
        return any(c.type == AmendmentChangeType.ADD_MILESTONE for c in self.changes)

    def requires_signing_authority(self) -> bool:
        return True
# AmendmentStatus УДАЛЁН — дублировал NegotiationStatus (путь согласования один).


def apply_amendment(amendment: Amendment, contract: Contract):
    assert amendment.status == NegotiationStatus.SIGNED
    for change in amendment.changes:
        if change.type == AmendmentChangeType.ADD_MILESTONE:
            m = create_milestone_from(change.payload)
            m.created_by_amendment = amendment.id
            contract.milestone_tree.attach(m, parent=change.payload.get("parent"))
    delta = amendment.amount_delta()
    if delta.amount > 0:
        if not create_additional_hold(contract, delta):   # только для холд-способа
            amendment.status = NegotiationStatus.PENDING_SIGNATURE
            raise PaymentRequired("недостаточно средств для дополнительной блокировки")
    elif delta.amount < 0:
        release_excess_hold(contract, abs(delta))
    # Комиссия за заключение по допнику: увеличение суммы -> доплата по шкале; уменьшение -> без возврата (ADR-054)
    charge_amendment_fee(contract, amendment)
```

---

# 10. ПЛАТЕЖИ, КОМИССИЯ ЗА ЗАКЛЮЧЕНИЕ И ГЕЙТ

```python
# ДВЕ РАЗНЫЕ ВЕЩИ (ADR-054/055):
#   1. Комиссия за ЗАКЛЮЧЕНИЕ договора — ЕДИНСТВЕННЫЙ основной доход. Списывается при ПОДПИСАНИИ,
#      платит исполнитель-бизнес (сегменты PAID_BUSINESS/SPECIAL). C2C-free — 0.
#   2. Комиссия платформы за сами ПЛАТЕЖИ — 0% (ADR-055). Стороны несут только тариф оператора (СБП),
#      по стандарту эквайринга его платит ПОЛУЧАТЕЛЬ.

class ContractFee:
    """Разовая комиссия за заключение договора (ADR-054). Невозвратна (в т.ч. при досрочном расторжении)."""
    def __init__(self):
        self.contract: UUID = None
        self.base_amount: Money = None       # сумма договора, от которой считали
        self.fee: Money = None               # по убывающей маржинальной шкале
        self.charged_at: datetime | None = None   # момент ПОДПИСАНИЯ
        self.payer_side: str = "contractor"  # платит исполнитель-бизнес


def compute_contract_fee(amount: Money, segment: ContractSegment, cfg) -> Money:
    """Убывающая МАРЖИНАЛЬНАЯ шкала (значения — параметр юрисдикции): 1,0% до 50 тыс; далее
    0,8/0,6/0,5/0,4/0,3/0,25%; 0,2% свыше 5 млн. Скачков на границах нет. C2C-free -> 0."""
    if segment == ContractSegment.FREE_C2C:
        return Money(Decimal(0), amount.currency)
    return apply_marginal_scale(amount, cfg.contract_fee_scale)   # PAID_BUSINESS и SPECIAL


def charge_contract_fee(contract: Contract):
    """Списание при подписании. Промо: первый договор новому верифицированному исполнителю — бесплатно."""
    contract.segment = compute_segment(contract)
    if contract.segment == ContractSegment.FREE_C2C:
        return   # C2C бесплатно
    if is_first_contract_promo(contract.contractor_party()):
        return   # промо (один раз, после верификации)
    cfg = jurisdiction_config(contract)
    fee = compute_contract_fee(contract.total_amount(), contract.segment, cfg)
    show_fee_before_signing_already_done()   # цена показана ДО подписания
    ContractFee(contract=contract.id, base_amount=contract.total_amount(),
                fee=fee, charged_at=now())
```

```python
class Payment:
    """Платёжная операция. Платформа НЕ хранит деньги (direct/hold). Комиссия платформы за платёж — 0%.
    Сплит-перевод — технический рельс, не отдельный способ (Р-2)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.milestone: UUID = None
        self.method: PaymentMethod = None
        self.amount: Money = None
        self.status: PaymentStatus = PaymentStatus.PENDING
        # Двустороннее подтверждение — ТОЛЬКО где платёж не наблюдаем (наличные/внешний безнал)
        self.confirmed_by_payer: bool = False
        self.confirmed_by_payee: bool = False
        self.hold_expires_at: datetime | None = None
        self.gateway_id: str = ""
        # Тариф платёжного оператора (не наша комиссия). По стандарту эквайринга — на получателе.
        self.operator_fee: Money | None = None

    def is_settled(self) -> bool:
        if self.method == PaymentMethod.DIRECT_PLATFORM:
            return self.status in (PaymentStatus.OBSERVED, PaymentStatus.CAPTURED)  # наблюдаем, подтверждение не нужно
        if self.method == PaymentMethod.HOLD:
            return self.status == PaymentStatus.CAPTURED
        return self.confirmed_by_payer and self.confirmed_by_payee   # офлайн


def financial_condition_met(milestone: Milestone) -> bool:
    """Финансовое условие гейта. Первым решает ПОРЯДОК оплаты (репо-ADR-155), и только
    если предоплаты нет — способ расчёта."""
    payment = milestone.payment()
    method = milestone.contract.payment_method
    if milestone.contract.payment_order == PaymentOrder.BEFORE_START:
        # Предоплата: условие ОДНО и от способа не зависит — оплата ЭТОГО листа
        # подтверждена обеими сторонами. Исключение — рельсы, которые платформа
        # наблюдает сама (партнёра нет, наблюдать нечем).
        if method in (PaymentMethod.DIRECT_PLATFORM, PaymentMethod.HOLD):
            return False
        return payment.confirmed_by_payer and payment.confirmed_by_payee
    if method == PaymentMethod.DIRECT_PLATFORM:
        return payment.status in (PaymentStatus.OBSERVED, PaymentStatus.CAPTURED)  # наблюдён (ADR-056)
    if method == PaymentMethod.HOLD:
        return payment.status == PaymentStatus.HELD
    return True   # постоплата наличными/внешним — метка «без защиты платежа»


def reauthorize_hold(payment: Payment):
    """Продление ХОЛДА (опция «полная защита») до истечения авторизации. Прозрачно для клиента."""
    if payment.hold_expires_at - now() < REAUTH_THRESHOLD:
        new_hold = gateway.create_hold(payment.amount, payment.gateway_id)
        gateway.void(payment.gateway_id)
        payment.gateway_id = new_hold.id
        payment.hold_expires_at = new_hold.expires_at


def payment_operator_fee_bearer(payment: Payment) -> str:
    """Комиссия ПЛАТФОРМЫ за платёж = 0% (ADR-055). Тариф ОПЕРАТОРА (СБП/эквайринг) несёт ПОЛУЧАТЕЛЬ.
    Полная раскладка «сумма -> тариф оператора -> к получению» показывается ДО операции."""
    return "payee"
```

---

# 11. ДИАЛОГ И СПОРЫ

```python
def reject_acceptance(milestone: Milestone, checklist_item: ChecklistItem, evidence: list) -> "Dispute":
    """Отклонение — ТОЛЬКО с указанием невыполненного пункта чек-листа + доказательство.
    Нет пункта -> нечего оспаривать -> работа принята."""
    assert checklist_item.milestone == milestone.id, "Пункт не из этого этапа"
    assert evidence, "Нужно доказательство"
    return open_dispute(milestone, checklist_item, evidence)


class Dispute:
    """Спор по этапу. Качество этапа ЦЕЛОСТНО: этап либо принят целиком, либо возвращён целиком."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.milestone: UUID = None
        self.checklist_item: UUID = None
        self.evidence: list = []
        self.opened_at: datetime = now()
        self.deadline: datetime = None     # потолок 30 дней (параметр категории)
        self.outcome: DisputeOutcome | None = None
        self.fix_rounds_used: int = 0      # максимум 2


def resolve_dispute_cap(dispute: Dispute):
    """Потолок (30 дней): принятые этапы оплачиваются, спорный целиком возвращается,
    обе стороны — референсные последствия (не штраф)."""
    contract = dispute.milestone_contract()
    for m in contract.accepted_milestones():
        capture_payment(m)
    void_payment(dispute.milestone)
    dispute.outcome = DisputeOutcome.CAP_REACHED
    record_dispute_reference_metric(contract)


class MediationSession:
    """Платная медиация. Обязывающего арбитража НЕТ. Мнение медиатора без юридической силы.
    Асимметрия оплаты: платит сторона, чью позицию не поддержали. Финальные споры — в суде."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.dispute: UUID = None
        self.mediator: UUID = None
        self.opinion: str = ""
        self.cost: Money = None
        self.cost_bearer: str = ""
```

---

# 12. ГАРАНТИЯ

```python
class WarrantyClaim:
    """Гарантийная заявка. Гарантийные обращения — ОТДЕЛЬНАЯ метрика; рейтинг задним числом НЕ пересчитывают."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.description: str = ""
        self.evidence: list = []
        self.status: str = "submitted"
        self.resolution_type: str | None = None


def warranty_period_for(contract: Contract) -> int:
    """Срок — по согласованию сторон; платформа подсказывает из конфигурации (по категории).
    Законодательный минимум — это ОГРАНИЧЕНИЕ, а не рекомендация."""
    return jurisdiction_config(contract).warranty_recommendation(contract.primary_sphere())
```

---

# 13. РЕПУТАЦИЯ

```python
class SphereReputation:
    """Репутация профиля в ОДНОЙ сфере. Две оси: количество и объём. Единого балла НЕТ."""
    def __init__(self):
        self.sphere: Sphere = None
        self.total_deals: int = 0
        self.completed_deals: int = 0
        self.on_time_deals: int = 0
        self.right_first_time: int = 0
        self.total_volume: Money = None
        self.discount_rate: float = 0.0
        self.dispute_rate: float = 0.0
        self.warranty_claim_rate: float = 0.0
        self.protected_payment_rate: float = 0.0
        self.epochs: list[dict] = []   # заполняется ТОЛЬКО при смене владельца


def update_reputation_on_completion(contract: Contract):
    """Начисляется ПРОФИЛЮ подписавшей стороны, раздельно по сферам. Экспоненциальное затухание (~3 года)."""
    for side in ("customer", "contractor"):
        profile = contract.signing_profile(side)   # НЕ личный профиль представителя
        for sphere, volume in contract.volume_by_sphere().items():
            rep = profile.reputation_by_sphere.setdefault(sphere, SphereReputation())
            rep.total_deals += 1
            rep.total_volume = (rep.total_volume or zero(volume.currency)) + volume


def what_is_published(profile: Profile) -> dict:
    """Публикуются ТОЛЬКО факты (всегда с абсолютным числом сделок и объёмом).
    Отзыв существует, но НЕ публикуется (влияет на выдачу на срок)."""
    return {sphere: rep.public_facts() for sphere, rep in profile.reputation_by_sphere.items()}
```

---

# 14. ДОКУМЕНТЫ; ДЕЛЕГИРОВАННАЯ ОФЛАЙН-СЪЁМКА ДОКАЗАТЕЛЬСТВ

```python
class Document:
    """Универсальное ядро документа. Тип — по юрисдикции и налоговому статусу. ПД зашифрованы (crypto-shredding)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.doc_type: DocumentType = None
        self.contract: UUID = None
        self.milestone: UUID | None = None
        self.agreement: UUID | None = None
        self.file_encrypted: bytes = b""
        self.file_hash: str = ""             # хеш — БЕССРОЧНО (даже если файл удалён)
        self.encryption_key_ref: str = ""
        self.status: str = "draft"


def generate_closing_documents(contract: Contract):
    """Тип зависит от налогового режима ИСПОЛНИТЕЛЯ (из справочника LocalTaxRegime).
    ВАЖНО (ADR-058): если сегмент FREE_C2C и исполнитель — физлицо без статуса, закрывающего документа НЕТ
    (доход под НПД не подпадает; налог — НДФЛ на пользователе)."""
    if contract.segment == ContractSegment.FREE_C2C and contract.contractor_party().entity is None:
        return   # нет бизнес-профиля -> платформа документов не формирует
    provider = jurisdiction_config(contract).accounting_provider
    entity = contract.contractor_entity()
    for doc_type in entity.tax_regime().closing_document_types:
        provider.issue(contract, doc_type)   # 'receipt' | 'act' | 'invoice'


def delete_personal_data(subject_id: UUID):
    """Удаление ПД: уничтожается КЛЮЧ, а не файл (crypto-shredding). Хеши и место в цепочке — сохраняются."""
    destroy_encryption_key(subject_id)
```

```python
# ДЕЛЕГИРОВАННАЯ СЪЁМКА И ОФЛАЙН-РЕЖИМ (ADR-053).
# Доказательства снимает не подписант, а человек на объекте (прораб/представитель заказчика),
# где сети может не быть. Файл на телефоне до выгрузки — окно для подмены; закрываем криптографией.

class ContractAssignment:
    """Назначение на договор: КТО имеет право снимать доказательства, на каком договоре/этапах, когда.
    Часть доказательной базы («этот человек имел право находиться на объекте»).
    Отзыв НЕ аннулирует материал, снятый в период действия (снепшот полномочий, как при подписании)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.contract: UUID = None
        self.representative: UUID = None     # с правом Permission.UPLOAD_EVIDENCE
        self.milestones: list[UUID] = []     # на какие этапы (пусто = все)
        self.assigned_by: UUID = None
        self.valid_from: datetime = now()
        self.valid_until: datetime | None = None

    def covers(self, milestone_id: UUID, at: datetime) -> bool:
        return ((not self.milestones or milestone_id in self.milestones)
                and self.valid_from <= at and (self.valid_until is None or at <= self.valid_until))


class DeviceKey:
    """Ключ устройства (User + устройство). Отснятый материал сразу на устройстве: сжат (сжатый = оригинал),
    хеширован, упакован с метаданными и ПОДПИСАН этим ключом. Хранится в зашифрованном контейнере."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.user: UUID = None
        self.device_fingerprint: str = ""
        self.public_key: str = ""
        self.issued_at: datetime = now()


class EvidenceCapture:
    """Единица доказательства с делегированной съёмки. Метки показываются РАЗДЕЛЬНО, не склеиваются."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.assignment: UUID = None                 # ContractAssignment
        self.milestone: UUID = None
        self.checklist_item: UUID | None = None
        self.device_key: UUID = None
        self.content_hash: str = ""                  # + подпись DeviceKey -> целостность с момента съёмки
        self.device_time: datetime = None            # заявленное время (сверка с NTP ловит перевод часов)
        self.geo: tuple | None = None
        self.captured_at_offline: bool = True
        self.uploaded_at: datetime | None = None     # RFC 3161 при получении -> «существовало не позже»
        self.upload_delay_note: str = ""             # «загружено с задержкой N дней», если вне окна


def upload_window_zone(capture: EvidenceCapture, milestone: Milestone, cfg) -> str:
    """Три зоны окна выгрузки (по умолчанию 72 ч — параметр категории). Информация вместо наказания."""
    delay = (capture.uploaded_at or now()) - capture.device_time
    if milestone.status in (MilestoneStatus.ACCEPTED, MilestoneStatus.PAID):
        return "post_acceptance"   # только в архив спора; на состоявшуюся автоприёмку не влияет
    if delay <= cfg.evidence_upload_window(milestone):
        return "in_window"         # обычный материал
    return "late"                  # принят с видимой пометкой «загружено с задержкой N дней»
```

```python
def export_evidence_package(contract: Contract) -> "EvidencePackage":
    """PDF с оглавлением + ZIP с файлами и МАНИФЕСТОМ ХЕШЕЙ — проверяется без участия платформы.
    Базовое хранение (3 мес с окончания) и выгрузка в этот срок — бесплатны; расширенное/экспорт — заложены,
    по умолчанию выключены (ADR-036)."""
    ...
```

---

# 15. ЮРИСДИКЦИЯ И ПРОВАЙДЕРЫ

```python
class ContractTypeCatalogItem:
    """Справочник ТИПОВ ДОГОВОРОВ с сегментом монетизации (ADR-058). Наполняется по юрисдикции.
    EXCLUDED-типы заведены, но пользователю НЕ показываются (доли/паи/ценные бумаги)."""
    def __init__(self):
        self.code: str = ""                          # 'services','loan','gift','barter','personal_sale',
                                                     # 'lph_produce','realty_sale','vehicle_sale','lease','securities'
        self.name_i18n: dict[str, str] = {}
        self.segment: ContractSegment = None         # FREE_C2C / PAID_BUSINESS(услуги) / SPECIAL / EXCLUDED
        self.always_free: bool = False               # True для непредпринимательских типов (заём, ЛПХ, дарение...)
        self.tax_note_i18n: dict[str, str] = {}      # налоговая пометка для пользователя (НДФЛ / ЛПХ и т.п.)
        self.visible_to_user: bool = True            # EXCLUDED -> False
        self.needs_special_flow: bool = False        # SPECIAL: недвижимость/транспорт, аренда — отдельная проработка


class Currency:
    """Справочник валют (ISO 4217). УНИВЕРСАЛЬНЫЙ — одна таблица на все страны; данные, не код.
    ADR-041: справочник НЕ создаёт «валюту по умолчанию» — каждая Money несёт валюту явно."""
    def __init__(self):
        self.code: str = ""            # 'RUB' (alpha-3, PK)
        self.numeric_code: str = ""    # '643'
        self.name_i18n: dict[str, str] = {}
        self.symbol: str = ""          # '₽'
        self.decimal_places: int = 2   # для форматирования/округления в UI
        self.is_active: bool = True    # Р1: активна только RUB


class JurisdictionConfig:
    """Конфигурация страны (плагин). Универсальное ядро одно, поведение — здесь."""
    def __init__(self):
        self.country_code: str = ""
        self.entity_forms: dict[str, LocalEntityForm] = {}
        self.tax_regimes: dict[str, LocalTaxRegime] = {}
        self.contract_types: dict[str, ContractTypeCatalogItem] = {}   # ADR-058
        self.contract_fee_scale: list = []           # ступени убывающей маржинальной шкалы (ADR-054)
        # Валюта юрисдикции — ТОЛЬКО подстановка в форму UI при создании договора
        # (автозаполнение: подставили — человек видит и подтверждает). НЕ дефолт логики:
        # Money всегда несёт валюту явно (ADR-041). Валюта договора валидируется
        # против allowed_currency_codes; один договор — одна валюта (§46 концепции).
        self.default_currency_code: str = ""         # РФ: 'RUB'
        self.allowed_currency_codes: list[str] = []  # Р1: ['RUB']
        self.registry_director_lookup_available: bool = False
        self.poa_notarization_registry_available: bool = False
        self.verification_provider: "VerificationProvider" = None
        self.esignature_provider: "ESignatureProvider" = None
        self.accounting_provider: "AccountingDocumentProvider" = None
        self.warranty_by_sphere: dict[Sphere, dict] = {}

    def warranty_recommendation(self, sphere: Sphere) -> int:
        return self.warranty_by_sphere.get(sphere, {}).get("recommended", 30)

    def evidence_upload_window(self, milestone) -> timedelta:
        return timedelta(hours=72)   # параметр категории договора (ADR-053)

    def form_options(self) -> list[LocalEntityForm]:
        return [f for f in self.entity_forms.values() if f.is_active]

    def tax_regime_options(self, form_code: str) -> list[LocalTaxRegime]:
        form = self.entity_forms[form_code]
        return [self.tax_regimes[c] for c in form.allowed_tax_regimes if self.tax_regimes[c].is_active]

    def contract_type_options(self) -> list[ContractTypeCatalogItem]:
        """Для выпадающего списка типов договора — БЕЗ EXCLUDED (их не показываем)."""
        return [t for t in self.contract_types.values() if t.visible_to_user]


# Провайдеры — общие ИНТЕРФЕЙСЫ, реализации по стране.
class VerificationProvider:      # ЕГРЮЛ/ЕГРИП (РФ) / Companies House (UK) / ...
    def fetch_entity_data(self, tax_id: str) -> "RegistryEntityData": ...
    def director_matches(self, entity, user) -> bool: ...
    def get_director_hash(self, entity) -> str: ...
    def check_poa_active(self, poa_id) -> bool: ...

class ESignatureProvider:        # Госуслуги/Госключ (РФ) / eIDAS (ЕС) / ...
    def sign(self, version_hash, signatory) -> Signature: ...

class AccountingDocumentProvider:  # ФНС (самозанятые) / Контур, Диадок (ЮЛ) / ...
    def issue(self, contract, doc_type: str): ...
```

---

# 16. ВНУТРЕННИЕ РОЛИ И АУДИТ

```python
class AuditLogEntry:
    """Аудит-лог: append-only, отдельное хранилище, цепочка хешей. Доказывает, что лог не редактировался."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.actor: UUID = None
        self.action: str = ""
        self.target: str = ""
        self.timestamp: datetime = now()
        self.prev_hash: str = ""
        self.this_hash: str = ""


def access_personal_data(operator, subject_id: UUID):
    """Причину указывать НЕ требуется, но КАЖДЫЙ просмотр ПД логируется (кто, когда, чьи данные)."""
    assert operator.role in (PlatformRole.COMPLIANCE, PlatformRole.ADMIN)
    append_audit_log(actor=operator.id, action="view_pd", target=subject_id)
    return decrypt_pd(subject_id)
# Ни одна внутренняя роль НЕ редактирует содержание подписанного договора/доказательства.
```

---

# 17. УВЕДОМЛЕНИЯ (ЮРКАНАЛ — ЛИЧНЫЙ КАБИНЕТ, ADR-057)

```python
class Notification:
    """Тайм-аут отнимает право -> уведомление юридически значимо.
    ЮРИДИЧЕСКИЙ момент доставки = РАЗМЕЩЕНИЕ В ЛИЧНОМ КАБИНЕТЕ (in-app), а не отправка push/email (ADR-057)."""
    def __init__(self):
        self.id: UUID = uuid4()
        self.recipient: UUID = None
        self.placed_in_cabinet_at: datetime | None = None   # ОТ НЕГО считается тайм-аут (юр. доставка)
        self.content_hash: str = ""                         # доказательный пакет уведомления
        self.push_gateway_response: str = ""                # ответ FCM/APNS (push — дублирование)
        self.opened_at: datetime | None = None
        self.fallback_sms_sent: bool = False


def place_notification(recipient, message) -> Notification:
    """Размещение в ЛК = юридическая доставка. Push — «звонок в дверь» (доставку не гарантирует).
    Email — опциональное дублирование по желанию пользователя, НЕ юридический канал."""
    n = Notification(recipient=recipient.id)
    n.placed_in_cabinet_at = now()          # <-- момент, от которого течёт тайм-аут
    n.content_hash = hash_content(message)
    n.push_gateway_response = try_push(recipient, message)   # дублирование
    if recipient.email_duplication_enabled:
        try_email(recipient, message)       # опционально
    return n


def acceptance_reminders(milestone: Milestone):
    """УСИЛЕННАЯ серия перед автоприёмкой (самый чувствительный тайм-аут), нарастающая частота:
    при сдаче, 50%, 75%, 90%, финальное. Юрноситель — размещение в ЛК + push.
    Для ПОТРЕБИТЕЛЕЙ на финальном: если push не доставлен и входа в ЛК нет — ОДНА fallback-SMS (ADR-057)."""
    schedule_reminders(milestone, points=[0.0, 0.5, 0.75, 0.9, 0.99])


def timeouts_pause_on_downtime():
    """Пауза тайм-аутов при недоступности платформы (простой ЛК = недоставка), по метрикам аптайма."""
    ...
# Право на восстановление срока: при доказанной невозможности доступа к ЛК автоприёмка оспаривается.
# Новые обременяющие условия НЕ вводятся «уведомлением в ЛК» — только акцептом новой оферты.
```

---

# 18. МОНИТОРИНГ СИСТЕМАТИЧНОСТИ C2C

```python
class ActivityCounter:
    """Счётчик активности физлица БЕЗ бизнес-статуса. При превышении порога — мягко ПРЕДЛАГАЕМ СМЗ.
    Пять применений одного механизма: (1) систематичность C2C -> НПД; (2) обнаружение накрутки репутации;
    (3) подмена трудовых отношений (пара «заказчик-исполнитель»); (4) конвейер сегментной модели (6.1);
    (5) честность выбора: систематические возмездные услуги «как физлицо» -> вести к оформлению СМЗ (ADR-058)."""
    def __init__(self):
        self.user: UUID = None
        self.deals_in_window: int = 0
        self.window_days: int = 30
        self.threshold: int = None   # оценочный, уточняется с юристом

    def check_and_suggest(self):
        if self.deals_in_window >= self.threshold:
            suggest_self_employment_registration(self.user)   # Information > Punishment
```

---

# 19. СВЯЗИ МЕЖДУ ДОГОВОРАМИ (СУБПОДРЯД)

```python
# Субподряд — НЕ многосторонний договор, а СИСТЕМА СВЯЗЕЙ между обычными двухсторонними (ADR-040).
# Каждый договор в связке — обычный двухсторонний; связь — слой синхронизации ПОВЕРХ. Права/обязанности
# между договорами НЕ перетекают. ПРИВАТНОСТЬ: связь видит ТОЛЬКО её создатель (генподрядчик).

class ContractLink:
    def __init__(self):
        self.id: UUID = uuid4()
        self.parent_contract: UUID = None
        self.child_contract: UUID = None     # субподряд (создатель связи в нём — заказчик)
        self.kind: str = "subcontract"
        self.created_by: UUID = None         # ЕДИНСТВЕННЫЙ, кто видит связь
        self.created_at: datetime = now()
        self.milestone_map: list["MilestoneMapping"] = []


class MilestoneMapping:
    def __init__(self):
        self.parent_milestone: UUID = None
        self.child_milestones: list[UUID] = []


def create_contract_link(parent: Contract, child: Contract, user: User) -> ContractLink:
    assert user_is_party(user, parent) and user_is_party(user, child)
    link = ContractLink()
    link.parent_contract = parent.id
    link.child_contract = child.id
    link.created_by = user.id
    return link


def on_parent_milestone_shift(link: ContractLink, parent_milestone: Milestone, days: int):
    """Синхронизация — ПОДСКАЗКИ, а не автодействия (договор меняется только допником)."""
    for mapping in link.milestone_map:
        if mapping.parent_milestone == parent_milestone.id:
            for child_ms_id in mapping.child_milestones:
                suggest_amendment_to_creator(link.created_by, link.child_contract, child_ms_id,
                                             reason=f"этап родительского договора сдвинут на {days} дн.")


def linked_margin(parent: Contract, user: User) -> Money:
    """Родительский договор МИНУС субподряды = маржа генподрядчика. ВИДНА ТОЛЬКО создателю связей."""
    links = links_created_by(user, parent)
    subs = sum_money(contract_by_id(l.child_contract).total_amount() for l in links)
    return parent.total_amount() - subs
```

---

# 20. ДАШБОРДЫ РОЛЕЙ (ВЫЧИСЛЯЕМЫЕ ПРЕДСТАВЛЕНИЯ)

```python
# Дашборд — ПРОИЗВОДНОЕ от данных договоров (не отдельное состояние). Каждый элемент -> действие в один клик.
# Финансовая детализация — ТОЛЬКО СВОЯ (маржа генподрядчика скрыта, приватность связей).

def contractor_dashboard(profile: Profile) -> dict:
    contracts = active_contracts(profile, side="contractor")
    return {
        "under_acceptance": [m for c in contracts for m in c.leaf_milestones()
                             if m.status == MilestoneStatus.UNDER_ACCEPTANCE],
        "blocked_by_gate":  [m for c in contracts for m in c.leaf_milestones()
                             if m.status == MilestoneStatus.PENDING and not m.can_start()],
        "money": {
            "awaiting_hold": sum_by_status(contracts, PaymentStatus.PENDING),
            "on_hold":       sum_by_status(contracts, PaymentStatus.HELD),
            "received":      sum_by_status(contracts, PaymentStatus.CAPTURED),
        },
        "open_disputes":   disputes_with_time_to_cap(contracts),
        "project_financials": [project_financials(c, side="contractor") for c in contracts],
        "linked_margins": [{"parent": c.id, "margin": linked_margin(c, profile.owner())}
                           for c in contracts if has_links_created_by(profile.owner(), c)],
        "evidence_expiring": evidence_retention_expiring(profile),
    }


def customer_dashboard(profile: Profile) -> dict:
    contracts = active_contracts(profile, side="customer")
    return {
        # КРИТИЧНО: таймер приёмки (48ч). Бездействие = автоприёмка, заказчик теряет право оспорить.
        "awaiting_my_acceptance": [{"milestone": m, "hours_left": acceptance_hours_left(m)}
                                   for c in contracts for m in c.leaf_milestones()
                                   if m.status == MilestoneStatus.UNDER_ACCEPTANCE],
        "suspended_because_of_me": [{"milestone": m, "idle_days": m.frozen_days}
                                    for c in contracts for m in c.leaf_milestones()
                                    if m.status == MilestoneStatus.SUSPENDED],
        "budgets": [project_financials(c, side="customer") for c in contracts],
        "warranties": [{"contract": c.id, "until": c.warranty_until}
                       for c in all_contracts(profile, side="customer")
                       if c.execution_status == ContractExecutionStatus.WARRANTY],
        # [Л] Для юрлица-заказчика — блок рисков переквалификации (см. 6.2 концепции)
    }
```

---

# СВЯЗИ (краткая карта)

```
Субъект (User | BusinessEntity) ──1── TrustID (скрытый), @username (Handle)   [идентичность — у субъекта]
User ──< Representative >── BusinessEntity
User ──< SigningAuthority >── BusinessEntity
User / BusinessEntity ──1:1── CustomerProfile / ContractorProfile   (полиморфно; репутация — здесь)
BusinessEntity ──< OwnershipEpoch
Субъект ──< Contact (граф доверия; автопополнение из завершённых сделок)
AddressableGroup ── витрина над участниками (лидер подписывает; не носитель TrustID/репутации, не сторона)

Contract ──1── ContractTypeCatalogItem (тип -> ContractSegment)   [комиссия за заключение: ADR-054/058]
Contract ──< ContractParty >── Profile (+ BusinessEntity)
Contract ──1── ContractVersion (замороженная)
Contract ──< Milestone (ДЕРЕВО) ; лист ──< ChecklistItem, ContractMaterial, Payment
Contract ──< Amendment (цепочка)
Contract ──< SignatureRequest ──1── Signature
Contract ──1── ContractFee (комиссия за заключение; платежи — 0% комиссии платформы)
Contract ──< ContractAssignment ; EvidenceCapture(DeviceKey) — делегированная офлайн-съёмка (ADR-053)
Contract ──< Dispute ──< MediationSession ; ──1── WarrantyClaim ; ──< Document
Contract(родительский) ──< ContractLink >── Contract(субподряд)   [связь приватна]

JurisdictionConfig ──1── {LocalEntityForm, LocalTaxRegime, ContractTypeCatalogItem, провайдеры, contract_fee_scale}
Уведомления: юрдоставка = размещение в личном кабинете (ADR-057); push/email — дублирование.
```

---

*Псевдокод. Показывает структуру и логику, не является исполнимым кодом.
Обновлено под концепцию v9.0 и синхронизировано с техспецификацией 2.0 (23.07.2026, правки Р-1…Р-5).
Открытые вопросы (обеспечение гарантии, пороги C2C, механика объединений,
правила хендлов, юрпроверка контактов 152-ФЗ, схема TrustID под блокчейн) помечены там, где всплывают.*
