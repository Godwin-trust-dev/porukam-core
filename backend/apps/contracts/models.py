"""tech-spec.md §5.2.4 (минус fee-поля — финмодель v2, док 28), §6.1, §6.6, §9;
domain-model.md §6.1-6.2, §6.3, §8, §9. Э4.1 (docs/tasks/etap-4.md) — черновик и
сегментация; Э4.2 — протокол разногласий (RevisionProposal,
PreapprovedAlternative, FSM согласования draft/under_review/терминалы);
Э4.4 — заморозка и подписание (ContractVersion, SignatureRequest, Signature,
`Contract.frozen_version`, переходы в `pending_signature`/`awaiting_signatures`/
`signed`); Э4.5 — допники (`Amendment`, `AmendmentChange`, nullable `amendment`
FK на `SignatureRequest`/`Signature` — та же таблица, ОБЩАЯ FSM согласования/
подписания Э4.2/Э4.4, не дублируется, см. `apps.contracts.services.
NEGOTIATION_FSM` и ADR допника).

`RevisionProposal`/`PreapprovedAlternative` НЕ получают `amendment` FK в этой
ветке — протокол разногласий на допниках вне объёма Э4.5 (etap-4.md её не
упоминает; сеам, не забыто).

`customer_contact`/`contractor_contact` (FK Representative, §5.2.4) не
заведены: apps.authority (Representative/SigningAuthority) — пустой каркас
(этап 3.5, ещё не начат), FK на несуществующую модель завести нельзя. По той
же причине `SignatureRequest.signing_authority` — не FK, а свободный
`UUIDField` (сеам под 3.5, см. докстринг модели). `sphere_id` на Contract —
туда же (Sphere в apps.catalog ещё не заведена как измерение договора).

`form_data` jsonb — П-16 (поля форм по типам) ещё не утверждена (etap-4.md,
общие требования): содержимое договора, специфичное для
`contract_type_code` (включая атрибут ЛПХ для `sale_personal`), хранится как
свободная структура без схемы; дельта П-16 добавит валидацию подключаемыми
схемами без миграции ядра.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from apps.catalog.models import ContractTypeCatalogItem
from common.uuid7 import uuid7


class Contract(models.Model):
    class DealType(models.TextChoices):
        B2B = "b2b", "Бизнес — бизнес"
        B2C = "b2c", "Бизнес — физлицо"
        C2C = "c2c", "Физлицо — физлицо"

    class NegotiationStatus(models.TextChoices):
        """Граф переходов — common/fsm.py StateMachine в apps.contracts.
        services (§6.1). Э4.2 подключает draft->under_review (send),
        under_review->under_review (протокол разногласий) и оба терминала
        (withdrawn_by_initiator, rejected_by_counterparty); PENDING_SIGNATURE
        и далее объявлены заранее как значения поля, но переходы в них FSM
        подключит Э4.4 — поле не мигрируется повторно на каждой ветке."""

        DRAFT = "draft", "Черновик"
        UNDER_REVIEW = "under_review", "На согласовании"
        REJECTED_BY_COUNTERPARTY = "rejected_by_counterparty", "Отклонён контрагентом"
        WITHDRAWN_BY_INITIATOR = "withdrawn_by_initiator", "Отозван инициатором"
        PENDING_SIGNATURE = "pending_signature", "Ожидает выбора подписанта"
        AWAITING_SIGNATURES = "awaiting_signatures", "Ожидает подписей"
        SIGNED = "signed", "Подписан"

    class PaymentMethod(models.TextChoices):
        """СПОСОБ расчёта — КАКИМ ОБРАЗОМ перемещаются деньги (владелец
        03.09: «способ оплаты — это каким способом перемещаются деньги»).
        PLATFORM_SPLIT упразднён — сплит это рельс, не способ (§14 п.15).
        Без «лестницы платности» (etap-4.md Э4.1) — способы доступны
        одинаково независимо от segment, только с честной пометкой уровня
        защиты (см. `Contract.protected`).

        `prepayment` УПРАЗДНЁН (ADR-155, владелец 03.09: «предоплата с
        двусторонним подтверждением — там быть не должно. Можешь смело
        удалять»): это был не способ перемещения денег, а СРОК, и с
        появлением `PaymentOrder` он стал вторым именем того же факта.
        Предоплата теперь живёт ровно в одном месте — `payment_order =
        before_start`."""

        DIRECT_PLATFORM = "direct_platform", "Прямой платёж (наблюдение платформой)"
        HOLD = "hold", "Холд (Р2)"
        CASH = "cash", "Наличные"
        EXTERNAL = "external", "Внешний перевод"

    PROTECTED_PAYMENT_METHODS = frozenset({PaymentMethod.DIRECT_PLATFORM, PaymentMethod.HOLD})

    class PaymentOrder(models.TextChoices):
        """ADR-151: «порядок оплаты» — СРОК оплаты листа-этапа относительно
        его исполнения (замечание владельца 02.09). Отдельная ось от
        `PaymentMethod` (рельсы расчёта). Коды намеренно НЕ
        `prepayment`/`postpayment`: они называют СОБЫТИЕ, к которому привязан
        срок, и до ADR-155 слово `prepayment` было занято одноимённым
        способом расчёта (упразднён там же). Исполнение `before_start` в
        гейте этапа — ADR-155: оплата листа обеими сторонами до старта."""

        BEFORE_START = "before_start", "Предоплата — до начала этапа"
        AFTER_ACCEPTANCE = "after_acceptance", "Постоплата — после приёмки этапа"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    contract_type = models.ForeignKey(
        ContractTypeCatalogItem,
        to_field="code",
        db_column="contract_type_code",
        related_name="contracts",
        on_delete=models.PROTECT,
    )
    deal_type = models.CharField(max_length=3, choices=DealType.choices)
    # ADR-058: каталожно-налоговая роль сохраняется, «платности» сегмент не
    # определяет нигде (финмодель v2, док 28) — excluded сюда никогда не
    # попадает, apps.catalog.services.compute_segment бросает исключение до
    # записи.
    segment = models.CharField(max_length=16, choices=ContractTypeCatalogItem.Segment.choices)

    negotiation_status = models.CharField(
        max_length=32, choices=NegotiationStatus.choices, default=NegotiationStatus.DRAFT
    )

    class ExecutionStatus(models.TextChoices):
        """§6.2: `Contract.execution_status`. Закрытый список объявлен Э4.6
        (etap-4.md) — до этой ветки поле было без `choices` (заводить
        закрытый список раньше сервиса, который его использует,
        преждевременно, Э4.4). `TERMINATED_BY_CUSTOMER`/
        `TERMINATED_BY_CONTRACTOR` — только заглушки переходов (ADR-028,
        полный денежный расчёт расторжения — этап 7)."""

        PENDING_START = "pending_start", "Ожидает старта"
        IN_PROGRESS = "in_progress", "В работе"
        TERMINATED_BY_CUSTOMER = "terminated_by_customer", "Расторгнут заказчиком"
        TERMINATED_BY_CONTRACTOR = "terminated_by_contractor", "Расторгнут исполнителем"
        COMPLETED = "completed", "Завершён"
        WARRANTY = "warranty", "Гарантия"
        CLOSED = "closed", "Закрыт"

    # `null=True` — до первой подписи (Э4.4 пишет "pending_start" только на
    # второй подписи, tech-spec.md §6.2). `choices` — метаданные, миграция
    # 0005 (AlterField) не меняет схему БД (CharField как был).
    execution_status = models.CharField(
        max_length=32, choices=ExecutionStatus.choices, null=True, blank=True
    )

    # Текущая замороженная версия (Э4.4) — null, пока договор редактируется
    # (draft/under_review) либо после reopen (правка вернула на согласование:
    # ссылка снимается, старые ContractVersion НЕ удаляются — append-only
    # история, новая заморозка создаст новую версию). PROTECT: версия не
    # может исчезнуть, пока на неё ссылается договор.
    frozen_version = models.ForeignKey(
        "ContractVersion",
        related_name="contracts_frozen_at_this_version",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )

    payment_method = models.CharField(
        max_length=16, choices=PaymentMethod.choices, null=True, blank=True
    )
    protected = models.BooleanField(default=False)
    # ADR-151: порядок оплаты (срок оплаты этапа). `null` — не выбран
    # (черновик до заполнения; договоры, замороженные до раскатки).
    # Обязателен на `send` для всех клиентских опций, кроме `loan`
    # (`services.payment_order_applicable`): у займа лист-этап — сам
    # денежный транш, «оплата до/после исполнения этапа» смысла не имеет.
    payment_order = models.CharField(
        max_length=16, choices=PaymentOrder.choices, null=True, blank=True
    )
    uses_platform_template = models.BooleanField(default=True)

    jurisdiction = models.CharField(max_length=2)
    title = models.CharField(max_length=300, blank=True, default="")
    form_data = models.JSONField(default=dict, blank=True)
    # ADR-123: дополнительные условия — произвольные пункты, добавленные
    # сторонами через протокол разногласий (`RevisionProposal.item_ref ==
    # "other"`, принятая правка дописывает текст сюда). Список строк в порядке
    # принятия; попадает в canonical snapshot заморозки (`_build_snapshot`) —
    # часть текста договора перед подписанием. Живой список только до
    # заморозки (гейт `_assert_negotiating`), после — как и form_data.
    # ADR-167: тот же список редактируется вручную в мастере создания
    # (`services.patch_draft`, `additional_terms`) — но ТОЛЬКО пока
    # `negotiation_status = draft`; после отправки пункты добавляет лишь
    # принятая правка «Другое», после подписания — допсоглашение.
    additional_terms = models.JSONField(default=list, blank=True)
    # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2, финал) —
    # опциональный явный выбор официального языка договора, PATCH черновика
    # (`apps.contracts.services.patch_draft`), ограничен quality >= reviewed
    # (`LanguageNotEligibleError` иначе). Пусто — официальный язык считается
    # автоматически при заморозке (`services._resolve_official_language`):
    # общий reviewed+ язык интерфейса обеих сторон, иначе фолбэк по
    # jurisdiction. Мастера выбора языка в UI нет — это точечная правка.
    language_override = models.CharField(max_length=8, blank=True, default="")

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="created_contracts", on_delete=models.PROTECT
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # ADR-138: момент последнего ДВИЖЕНИЯ по договору — действия стороны
    # (событие outbox с actor.user_id: этапы, платежи, споры, доказательства,
    # сообщения чата, допники, согласование). Системные срабатывания (свип,
    # автоприёмка, просрочка) движением не считаются. Двигает
    # `services.record_contract_activity` (подписчик `handlers.
    # handle_contract_activity` на «*»); от метки отсчитывается дедлайн
    # `contract_idle` — автозакрытие сделки без движения (ADR-137 треб. 8).
    # Миграция 0009 бэкфиллит max(дата последнего события по договору,
    # created_at).
    last_activity_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "contract"
        verbose_name = "договор"
        verbose_name_plural = "договоры"

    def __str__(self) -> str:
        return f"{self.id} [{self.contract_type_id}]"


class ContractParty(models.Model):
    """Ровно один customer и один contractor (UniqueConstraint ниже; вторая
    сторона создаётся в той же транзакции, что и Contract —
    apps.contracts.services.create_draft). Роль 'subcontractor' упразднена
    (ADR-040) — субподряд станет связями между обычными договорами (Э-раздел
    19, вне Э4)."""

    class Role(models.TextChoices):
        CUSTOMER = "customer", "Заказчик"
        CONTRACTOR = "contractor", "Исполнитель"

    class ActingAs(models.TextChoices):
        PERSON = "person", "Физлицо"
        BUSINESS = "business", "Бизнес"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(Contract, related_name="parties", on_delete=models.CASCADE)
    role = models.CharField(max_length=16, choices=Role.choices)
    profile = models.ForeignKey(
        "profiles.Profile", related_name="contract_parties", on_delete=models.PROTECT
    )
    # null, если физлицо (важно для compute_segment, domain-model.md §6.2) —
    # заполняется, только когда сторона входит в сделку через конкретное
    # BusinessEntity, а не просто как физлицо с has_business_status=True.
    entity = models.ForeignKey(
        "entities.BusinessEntity",
        related_name="contract_parties",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    acting_as = models.CharField(max_length=16, choices=ActingAs.choices)
    # ADR-158: отметка «материалы этапов просмотрены» СВОЕЙ стороной. Живёт на
    # стороне договора, а не на материале/этапе: бейдж «Материалы изменены
    # контрагентом» — договорный (один на карточку), а сторон ровно две
    # (UniqueConstraint contract+role выше), так что «per-side» и «per-row
    # ContractParty» — одно и то же. `null` — сторона ещё ни разу не отмечала
    # просмотр (значит любая чужая правка материалов — непросмотренная).
    # Отметка НЕ юрзначима: это состояние интерфейса, не факт вручения
    # (юрканал — placed_in_cabinet_at уведомления), поэтому она обычное
    # изменяемое поле, а не запись в outbox.
    materials_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "contract_party"
        verbose_name = "сторона договора"
        verbose_name_plural = "стороны договора"
        constraints = [
            models.UniqueConstraint(
                fields=["contract", "role"], name="contract_party_one_per_role"
            ),
            # Значения Role/ActingAs не видны из области Meta (вложенный
            # класс) — литералы дублируют choices намеренно, тот же приём,
            # что apps/profiles/models.py Profile.Meta.
            models.CheckConstraint(
                condition=Q(role="customer") | Q(role="contractor"),
                name="contract_party_role_valid",
            ),
            models.CheckConstraint(
                condition=Q(acting_as="person") | Q(acting_as="business"),
                name="contract_party_acting_as_valid",
            ),
            models.CheckConstraint(
                condition=Q(acting_as="business") | Q(entity__isnull=True),
                name="contract_party_entity_requires_business",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.role}"


class RevisionProposal(models.Model):
    """Протокол разногласий (tech-spec.md §5.2.4, §6.1, §8.4) — Э4.2.

    `amendment` (FK Amendment) не заведён и в Э4.5: протокол разногласий на
    допниках вне объёма этой ветки (etap-4.md её не упоминает) — сеам, не
    забыто. `RevisionProposal` привязывается только к Contract напрямую.

    `item_ref` — адрес правки. ADR-123: адресуемая грамматика —
    `form.<key>` (поле схемы формы типа договора), `title` (название),
    `other` (новое дополнительное условие -> `Contract.additional_terms`);
    принятая правка по такому адресу ПРИМЕНЯЕТСЯ к договору
    (`services.accept_revision`) до заморозки. Свободные строки прежнего
    образца (`"milestones[2].amount"`) по-прежнему принимаются и хранятся —
    без автоматического применения (дерево этапов правится своими ручками).

    `old_value`/`new_value` — «было/стало»: для первого предложения по
    `item_ref` `old_value` может быть передан вызывающим (или не задан —
    ещё не с чем сравнивать), для встречной редакции (`counter`)
    `old_value` = `new_value` предложения, которое встречная редакция
    заменяет (см. `services.counter_revision`) — так цепочка правок остаётся
    согласованной без обращения к состоянию договора.

    `preapproved_alternative_of` — спецификация буквально пишет «FK
    revision_proposal», но это единственная трактовка, которая не
    противоречит тексту задачи (Э4.2: «apply в один клик БЕЗ новой
    итерации» — то есть применение `PreapprovedAlternative` создаёт
    RevisionProposal сразу в статусе `accepted`, а не встречное предложение
    поверх другого RevisionProposal): поле ссылается на применённую
    `PreapprovedAlternative`, а не на другой RevisionProposal.
    """

    class Status(models.TextChoices):
        OPEN = "open", "Открыто"
        ACCEPTED = "accepted", "Принято"
        REJECTED = "rejected", "Отклонено"
        SUPERSEDED = "superseded", "Заменено"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        Contract, related_name="revision_proposals", on_delete=models.CASCADE
    )
    item_ref = models.CharField(max_length=200)
    old_value = models.JSONField(null=True, blank=True)
    new_value = models.JSONField()
    comment = models.TextField(blank=True, default="")
    proposed_by = models.ForeignKey("profiles.Profile", related_name="+", on_delete=models.PROTECT)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    decided_by = models.ForeignKey(
        "profiles.Profile", related_name="+", null=True, blank=True, on_delete=models.PROTECT
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    preapproved_alternative_of = models.ForeignKey(
        "PreapprovedAlternative",
        related_name="applied_as_revisions",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "revision_proposal"
        verbose_name = "предложение правки"
        verbose_name_plural = "протокол разногласий"
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["open", "accepted", "rejected", "superseded"]),
                name="revision_proposal_status_valid",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.item_ref}[{self.status}]"


class PreapprovedAlternative(models.Model):
    """Bonterms-паттерн (tech-spec.md §5.2.4): заранее одобренная альтернатива
    формулировки/значения пункта — применяется в один клик без итерации
    протокола разногласий (см. `services.apply_preapproved_alternative`)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        Contract, related_name="preapproved_alternatives", on_delete=models.CASCADE
    )
    item_ref = models.CharField(max_length=200)
    payload = models.JSONField()
    created_by = models.ForeignKey("profiles.Profile", related_name="+", on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "preapproved_alternative"
        verbose_name = "предодобренная альтернатива"
        verbose_name_plural = "предодобренные альтернативы"

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.item_ref}"


class ContractVersion(models.Model):
    """Заморозка (Э4.4, domain-model.md §6.3): неизменяемый слепок договора
    на момент `freeze_contract` — снимок формируется каноническим JSON
    (`common.canonical`) и хешируется (`integrity_hash`); подпись всегда
    адресуется этому хешу (`Signature.version_hash`), не FK на строку — «не
    то» подписать невозможно (etap-4.md Э4.4). Append-only: старые версии не
    удаляются и не редактируются даже после `reopen()` — юридическая история
    снимков.

    `snapshot` НЕ включает расшифрованные ПД/реквизиты (bank_details_encrypted
    и т.п. остаются зашифрованными в своих моделях, CLAUDE.md: crypto-
    shredding с первой миграции) — только факт их наличия и ссылки
    (entity_id, encryption_key_ref)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(Contract, related_name="versions", on_delete=models.PROTECT)
    snapshot = models.JSONField()
    integrity_hash = models.CharField(max_length=64)
    hash_algorithm = models.CharField(max_length=16, default="sha256")
    frozen_at = models.DateTimeField()
    # TimestampProvider (common/timestamps.py, Р1): "server" сейчас, задел
    # под "rfc3161" после подключения TSA (Ю-21).
    trusted_timestamp_source = models.CharField(max_length=32)
    trusted_timestamp_at = models.DateTimeField()

    # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2, финал) —
    # официальный язык договора. `services._resolve_official_language`:
    # явный `Contract.language_override` (PATCH черновика) || общий язык
    # интерфейса ОБЕИХ сторон при quality >= reviewed || фолбэк по
    # jurisdiction (RU-контур -> "ru" как было, иначе GLOBAL-дефолт -> "en").
    # Поле называется `canonical_language` по историческому имени из
    # постановки п.1 — наружу (API) отдаётся как `official_language`
    # (`ContractVersionSerializer`), слово "canonical" в API-текстах не
    # используется. НЕ входит в `snapshot`/`integrity_hash` (ADR-078) —
    # подпись остаётся на canonical-структуре Э4.4, обратная совместимость
    # хешей уже подписанных договоров обязательна.
    canonical_language = models.CharField(max_length=8, default="en")
    # Рендеры снепшота по языкам (ADR-078, «тонкий» вариант на эту волну —
    # ClauseTemplate-композиция текста не входит в эту задачу, см. ADR-075):
    # {<language>: {"language": ..., "hash": <sha256>, "document": {...}}} —
    # канон + по одному на каждый РЕАЛЬНО встреченный язык подписанта на
    # момент заморозки (apps.contracts.services._party_locales). Каждый
    # документ — тот же canonical-снимок, что и `snapshot`, с добавленным
    # тегом "language", хешированный ОТДЕЛЬНО от `integrity_hash` (тот же
    # рецепт `common.canonical`, другой вход) — тоже НЕ влияет на подпись.
    renders = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "contract_version"
        verbose_name = "версия договора"
        verbose_name_plural = "версии договора"
        constraints = [
            models.UniqueConstraint(
                fields=["contract", "integrity_hash"], name="contract_version_unique_hash"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}@{self.integrity_hash[:12]}"


class SignatureRequest(models.Model):
    """Запрос подписи по одной стороне договора ИЛИ допника (domain-model.md
    §8, §9) — маршрутизация выбранному подписанту. `signing_authority` — НЕ FK
    (см. докстринг модуля): свободный `UUIDField`, заполняется, когда сторона
    подписывает от business-профиля по лимиту `SigningAuthority` (этап 3.5,
    ещё не смёржен) — до тех пор остаётся NULL, подписант person-стороны
    всегда её собственный `user`.

    `contract` — ВСЕГДА заполнен (сторона его знает безусловно, даже когда
    запрос про допник). `amendment` — NULL для запроса самого договора,
    заполнен для запроса конкретного допника (Э4.5, tech-spec.md §5.2.4:
    `amendment_id FK NULL` рядом с `contract_id`, не вместо него — так спека
    сама предлагает не заводить вторую пару таблиц под допники). Сервисы,
    читающие эту связь СО СТОРОНЫ Contract (`apps.contracts.services.
    route_signatory`/`sign`/`decline_for_revision`), обязаны фильтровать
    `amendment__isnull=True` — иначе раунд подписания договора перепутается с
    раундом допника."""

    class Side(models.TextChoices):
        CUSTOMER = "customer", "Заказчик"
        CONTRACTOR = "contractor", "Исполнитель"

    class Status(models.TextChoices):
        PENDING = "pending", "Ожидает"
        SIGNED = "signed", "Подписан"
        FORWARDED = "forwarded", "Переадресован"
        DECLINED_FOR_REVISION = "declined_for_revision", "Отклонён на доработку"
        EXPIRED = "expired", "Истёк"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        Contract, related_name="signature_requests", on_delete=models.CASCADE
    )
    amendment = models.ForeignKey(
        "Amendment",
        related_name="signature_requests",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    version = models.ForeignKey(
        ContractVersion, related_name="signature_requests", on_delete=models.PROTECT
    )
    side = models.CharField(max_length=16, choices=Side.choices)
    routed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="+", on_delete=models.PROTECT
    )
    signatory = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="signature_requests", on_delete=models.PROTECT
    )
    # Сеам под этап 3.5 (см. докстринг модуля) — не FK.
    signing_authority_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.PENDING)
    sent_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    comment = models.TextField(blank=True, default="")
    # Л.1 (docs/tasks/l10n-wave.md) — locale ПОКАЗАННОГО подписанту рендера,
    # проставляется `apps.contracts.services.sign` в момент подписания (не
    # раньше: "язык из его настройки на момент подписания"). Пусто, пока не
    # подписан. `apps.contracts.selectors.resolve_shown_locale` — тот же
    # резолвер, что решает, какой рендер реально показан (честный фолбэк на
    # canonical_language, если рендера для текущей локали подписанта нет).
    locale = models.CharField(max_length=8, blank=True, default="")

    class Meta:
        db_table = "signature_request"
        verbose_name = "запрос подписи"
        verbose_name_plural = "запросы подписи"
        constraints = [
            # Значения Side/Status не видны из области Meta (вложенный
            # класс) — литералы дублируют choices намеренно (тот же приём,
            # что ContractParty.Meta).
            models.CheckConstraint(
                condition=Q(side="customer") | Q(side="contractor"),
                name="signature_request_side_valid",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.side}[{self.status}]"


class Signature(models.Model):
    """Собственно подпись (domain-model.md §8) — адресована `version_hash`
    (не FK на ContractVersion): тело запроса `/sign` несёт хеш явно, поэтому
    подписать «не ту» версию физически невозможно (etap-4.md Э4.4).
    `entity_snapshot`/`contact_snapshot` — слепок полномочий/контактов
    подписанта НА МОМЕНТ подписи (те же правила отсутствия расшифрованных ПД,
    что у `ContractVersion.snapshot`).

    `contract`/`amendment` — та же пара «всегда заполнен / NULL для договора,
    не-NULL для допника», что у `SignatureRequest` (см. её докстринг, Э4.5)."""

    class Side(models.TextChoices):
        CUSTOMER = "customer", "Заказчик"
        CONTRACTOR = "contractor", "Исполнитель"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(Contract, related_name="signatures", on_delete=models.CASCADE)
    amendment = models.ForeignKey(
        "Amendment", related_name="signatures", null=True, blank=True, on_delete=models.CASCADE
    )
    version_hash = models.CharField(max_length=64)
    side = models.CharField(max_length=16, choices=Side.choices)
    signatory = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="signatures", on_delete=models.PROTECT
    )
    signed_at = models.DateTimeField(auto_now_add=True)
    # "person" (Р1, подпись от своего лица) — задел под коды оснований
    # SigningAuthority.basis (registry_verified_director/notarized_poa/...,
    # этап 3.5).
    signature_basis = models.CharField(max_length=32)
    entity_snapshot = models.JSONField(default=dict, blank=True)
    contact_snapshot = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "signature"
        verbose_name = "подпись"
        verbose_name_plural = "подписи"
        constraints = [
            models.CheckConstraint(
                condition=Q(side="customer") | Q(side="contractor"),
                name="signature_side_valid",
            ),
            # Одна активная подпись на сторону — reopen()/decline_for_revision
            # удаляет строки аннулированного раунда подписания. Раньше был
            # простой UniqueConstraint(contract, side); теперь `amendment`
            # может быть NULL — а в Postgres NULL ≠ NULL, голый
            # UniqueConstraint(contract, amendment, side) пропустил бы дубли
            # на уровне договора (обе строки amendment=NULL). Два partial-
            # индекса вместо одного констрейнта (Э4.5).
            models.UniqueConstraint(
                fields=["contract", "side"],
                condition=Q(amendment__isnull=True),
                name="signature_one_per_side_contract",
            ),
            models.UniqueConstraint(
                fields=["amendment", "side"],
                condition=Q(amendment__isnull=False),
                name="signature_one_per_side_amendment",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.side}"


class Amendment(models.Model):
    """Допник (domain-model.md §9, tech-spec.md §5.2.4/§8.6) — самостоятельный
    документ, изменяющий уже ПОДПИСАННЫЙ договор. Проходит ТОТ ЖЕ путь
    согласования/заморозки/подписания, что и сам договор — `negotiation_status`
    ЯВНО переиспользует `Contract.NegotiationStatus` (тот же класс choices, не
    копия значений), и `apps.contracts.services.NEGOTIATION_FSM` (тот же
    объект `StateMachine`) валидирует переходы для допника точно так же, как
    для договора (etap-4.md Э4.5: «общая FSM ... не дублируется»).

    `frozen_version` — та же таблица `ContractVersion`, что у Contract (НЕ
    отдельная таблица версий допников): `contract_version.contract_id` строки,
    на которую он указывает, равен `self.contract_id` — снимок допника такая
    же версия договора, просто с другим (меньшим) содержимым в `snapshot`.

    Протокол разногласий (`RevisionProposal`) на допниках не заведён — сеам,
    см. докстринг модуля."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(Contract, related_name="amendments", on_delete=models.CASCADE)
    order = models.PositiveIntegerField()
    reason = models.TextField()
    custom_terms = models.TextField(blank=True, default="")
    negotiation_status = models.CharField(
        max_length=32,
        choices=Contract.NegotiationStatus.choices,
        default=Contract.NegotiationStatus.DRAFT,
    )
    frozen_version = models.ForeignKey(
        ContractVersion,
        related_name="amendments_frozen_at_this_version",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="created_amendments", on_delete=models.PROTECT
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "amendment"
        verbose_name = "допник"
        verbose_name_plural = "допники"
        ordering = ["contract_id", "order"]
        constraints = [
            models.UniqueConstraint(fields=["contract", "order"], name="amendment_unique_order"),
        ]

    def __str__(self) -> str:
        return f"{self.contract_id}#{self.order}"


class AmendmentChange(models.Model):
    """Одно изменение в составе допника (domain-model.md §9
    `AmendmentChangeType`) — добавление/правка/удаление этапа или материала,
    либо чисто текстовое условие. `target` — свободный `UUIDField`, НЕ FK
    (тот же приём, что `SignatureRequest.signing_authority_id`): цель бывает
    то `Milestone`, то `ContractMaterial` — разные таблицы, единого FK не
    построить без generic-relations, которых в проекте нет.

    `amount_delta`/`amount_delta_currency` — money-пара (CLAUDE.md: валюты по
    умолчанию нет), ОБА nullable вместе: `custom_term` и чисто-срочные правки
    денежной дельты не несут. Считается СЕРВЕРОМ при создании допника
    (`apps.contracts.services._create_amendment_change`), не принимается от
    клиента — иначе рассинхрон между тем, что клиент посчитал, и тем, что
    реально произойдёт с деревом при применении."""

    class Type(models.TextChoices):
        ADD_MILESTONE = "add_milestone", "Добавить этап"
        MODIFY_MILESTONE = "modify_milestone", "Изменить этап"
        REMOVE_MILESTONE = "remove_milestone", "Убрать этап"
        ADD_MATERIAL = "add_material", "Добавить материал"
        MODIFY_MATERIAL = "modify_material", "Изменить материал"
        REMOVE_MATERIAL = "remove_material", "Убрать материал"
        CUSTOM_TERM = "custom_term", "Прочее условие"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    amendment = models.ForeignKey(Amendment, related_name="changes", on_delete=models.CASCADE)
    type = models.CharField(max_length=24, choices=Type.choices)
    target = models.UUIDField(null=True, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    amount_delta = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    amount_delta_currency = models.CharField(max_length=3, null=True, blank=True)
    days_delta = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "amendment_change"
        verbose_name = "изменение допника"
        verbose_name_plural = "изменения допника"
        ordering = ["amendment_id", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(amount_delta__isnull=True, amount_delta_currency__isnull=True)
                    | Q(amount_delta__isnull=False, amount_delta_currency__isnull=False)
                ),
                name="amendment_change_amount_delta_currency_together",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.amendment_id}:{self.type}"
