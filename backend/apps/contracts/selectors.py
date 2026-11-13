"""Read-слой apps.contracts."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db.models import Q, QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User
from apps.accounts.selectors import get_user_locale
from apps.entities.models import BusinessEntity
from apps.l10n import selectors as l10n_selectors
from apps.profiles.models import Profile
from common.models import OutboxEvent
from common.money import Money

from . import events
from .models import (
    Amendment,
    AmendmentChange,
    Contract,
    ContractParty,
    ContractVersion,
    PreapprovedAlternative,
    RevisionProposal,
    SignatureRequest,
)


def user_owned_profile_ids(user: User) -> set[Any]:
    """Профили, от лица которых пользователь вправе выступать стороной
    договора: свой person-профиль + business-профили юрлиц, контроль над
    которыми он подтвердил (claim_status=claimed, claimed_by=user;
    директорство без claim прав на сделки не даёт — CLAUDE.md)."""
    return set(
        Profile.objects.filter(
            Q(kind=Profile.Kind.PERSON, owner_user=user)
            | Q(
                kind=Profile.Kind.BUSINESS,
                owner_entity__claim_status=BusinessEntity.ClaimStatus.CLAIMED,
                owner_entity__claimed_by=user,
            )
        ).values_list("id", flat=True)
    )


def list_my_contracts(
    user: User,
    *,
    role: str | None = None,
    negotiation_status: str | None = None,
    segment: str | None = None,
) -> QuerySet[Contract]:
    """GET /contracts (tech-spec.md §8.4): «мои договоры» — где пользователь
    сторона через один из своих профилей (см. `user_owned_profile_ids`)."""
    owned = user_owned_profile_ids(user)
    qs = Contract.objects.filter(parties__profile_id__in=owned).distinct()
    if role is not None:
        qs = qs.filter(parties__profile_id__in=owned, parties__role=role)
    if negotiation_status is not None:
        qs = qs.filter(negotiation_status=negotiation_status)
    if segment is not None:
        qs = qs.filter(segment=segment)
    return qs.order_by("-created_at")


def get_contract(contract_id: UUID) -> Contract | None:
    """Толерантный вариант get_contract_or_404 для фоновых потребителей
    (apps.notifications: обогащение payload при размещении, ADR-098) —
    там Http404 неуместен, отсутствие договора — штатный случай."""
    return Contract.objects.filter(pk=contract_id).first()


def list_contracts_by_ids(contract_ids: set[UUID]) -> QuerySet[Contract]:
    """Батч для ленты уведомлений (apps.notifications.selectors
    .feed_contract_contexts): договоры со сторонами одним запросом, чтобы
    resolve_counterparty не ходил в БД на каждый пункт."""
    return Contract.objects.filter(pk__in=contract_ids).prefetch_related(
        "parties__profile__owner_entity", "parties__profile__owner_user"
    )


def get_contract_or_404(contract_id: UUID) -> Contract:
    return get_object_or_404(
        Contract.objects.select_related("contract_type").prefetch_related(
            "parties__profile", "parties__entity"
        ),
        pk=contract_id,
    )


def idle_deadline_at(contract: Contract) -> Any:  # noqa: ANN401
    """ADR-138: дата автозакрытия сделки без движения — `deadline_at`
    активного дедлайна `contract_idle` (либо отсрочки `contract_idle_retry`),
    None вне исполнения. Ленивый импорт селекторов дедлайнов не нужен —
    apps.contracts легитимно зависит от apps.deadlines."""
    if contract.execution_status != Contract.ExecutionStatus.IN_PROGRESS:
        return None
    from apps.deadlines import selectors as deadlines_selectors

    return (
        deadlines_selectors.list_active_for_subject(subject_type="contract", subject_id=contract.id)
        .filter(kind__in=("contract_idle", "contract_idle_retry"), deadline_at__isnull=False)
        .order_by("deadline_at")
        .values_list("deadline_at", flat=True)
        .first()
    )


def list_parties(contract: Contract) -> QuerySet[ContractParty]:
    return contract.parties.select_related("profile", "entity").all()


def party_user(party: ContractParty) -> User | None:
    """Пользователь-адресат уведомлений/релея по стороне договора (etap-4.md
    Э4.6, ГВ.3 — общий для обоих потребителей). Для person-профиля — прямой
    владелец; для business — тот, кто подтвердил контроль над юрлицом
    (`claimed_by`, тот же путь, что `user_owned_profile_ids` резолвит право
    действовать за юрлицо). `None`, если ни то ни другое не заполнено —
    вызывающая сторона решает не блокировать операцию (тот же приём
    терпимости, что `apps.notifications.subscriber.handle_event` на
    отсутствующего получателя)."""
    profile = party.profile
    if profile.owner_user is not None:
        return profile.owner_user
    if profile.owner_entity is not None:
        return profile.owner_entity.claimed_by
    return None


def party_users(contract: Contract) -> list[User]:
    """Пользователи-адресаты ВСЕХ сторон договора (ADR-126: уведомления по
    outbox-событиям адресуются контрагенту актора, а у системных событий без
    актора — обеим сторонам). Тот же резолв, что `party_user`; дубли (одно
    лицо на обеих сторонах — тестовые сценарии) и стороны без пользователя
    (`None`) отбрасываются. Порядок — customer, contractor (порядок ролей)."""
    users: list[User] = []
    for party in contract.parties.select_related(
        "profile__owner_user", "profile__owner_entity__claimed_by"
    ).order_by("role"):
        user = party_user(party)
        if user is not None and all(user.id != known.id for known in users):
            users.append(user)
    return users


def resolve_shown_locale(version: ContractVersion, user: User) -> str:
    """Л.1 (docs/tasks/l10n-wave.md) — какой рендер `version.renders`
    ДЕЙСТВИТЕЛЬНО показан `user` (текущая locale по `get_user_locale`, ГВ.5).
    Честный фолбэк на `canonical_language`, если рендера под текущую locale
    нет (напр. подписант сменил `country_code` уже ПОСЛЕ заморозки — рендеры
    заморожены вместе со снепшотом, `ContractVersion` неизменяем, задним
    числом не досчитываются). Общий резолвер для `services.sign`
    (`SignatureRequest.locale`) и `api/views.py` (условие дисклеймера) —
    один источник правды, а не две копии одной и той же логики."""
    locale = get_user_locale(user)
    if locale in (version.renders or {}):
        return locale
    return version.canonical_language


class PartyNotFoundError(ValueError):
    """`user`/`role` не резолвится в сторону `contract` — вызывающая сторона
    (services.py каждого приложения) уже проверила членство раньше через
    свой `get_party_for_user`/`is_party`, сюда это в норме не долетает."""


def resolve_counterparty(contract: Contract, user: User) -> ContractParty:
    """Сторона договора, противоположная `user` (Э4.6, ГВ.3: релей
    контрагенту). Реализовано на `user_owned_profile_ids` (не на
    `apps.contracts.services.get_party_for_user`) — selectors.py не
    импортирует services.py своего же приложения (тот наоборот импортирует
    selectors.py, `from .selectors import ...`; обратный импорт дал бы
    цикл)."""
    parties = _loaded_parties(contract)
    mine = _own_party_in(parties, user)
    if mine is None:
        raise PartyNotFoundError(f"пользователь {user.id} не сторона договора {contract.id}")
    other_role = (
        ContractParty.Role.CONTRACTOR
        if mine.role == ContractParty.Role.CUSTOMER
        else ContractParty.Role.CUSTOMER
    )
    other = next((p for p in parties if p.role == other_role), None)
    if other is None:
        raise PartyNotFoundError(f"у договора {contract.id} нет стороны {other_role!r}")
    return other


def _loaded_parties(contract: Contract) -> list[ContractParty]:
    # Батч-вызовы (list_contracts_by_ids) уже предзагрузили стороны —
    # select_related на менеджере сбросил бы prefetch и пошёл в БД заново.
    if "parties" in getattr(contract, "_prefetched_objects_cache", {}):
        return list(contract.parties.all())
    return list(contract.parties.select_related("profile__owner_entity"))


def _own_party_in(parties: list[ContractParty], user: User) -> ContractParty | None:
    owned = user_owned_profile_ids(user)
    return next((p for p in parties if p.profile_id in owned), None)


def own_party(contract: Contract, user: User) -> ContractParty | None:
    """Сторона `contract`, которой является `user` (`None` — не сторона).
    Тот же резолв через `user_owned_profile_ids`, что `resolve_counterparty`
    рядом: selectors.py не импортирует services.py своего приложения."""
    return _own_party_in(_loaded_parties(contract), user)


def materials_seen_at(contract: Contract, user: User) -> datetime | None:
    """ADR-158: когда СВОЯ сторона в последний раз отмечала материалы этапов
    просмотренными. `None` — ни разу (или смотрит не сторона: тогда бейджа у
    него всё равно нет). Чужую отметку наружу не отдаём — «контрагент открыл
    материалы в 03:14» это уведомление о прочтении, которого продукт не
    обещал ни одной из сторон."""
    party = own_party(contract, user)
    return party.materials_seen_at if party is not None else None


def initiator_role(contract: Contract) -> str | None:
    """Роль стороны, создавшей договор (`Contract.created_by`) — docs/tasks/
    Задача_redesign_contracts-execution-flow-real-api.md, ADR-088:
    `ContractSerializer` не отдавал этого поля вовсе (фронт ждал его как
    `initiator_role`). Тот же приём, что `resolve_counterparty` выше —
    `user_owned_profile_ids`, не `profile.owner_user == created_by`
    напрямую (создатель может выступать business-стороной по доверенности,
    у которой `owner_user` — не он). `None` — оборонительный случай (в
    норме недостижим: сторона создателя заводится в той же транзакции,
    что и сам Contract, `services.create_draft`)."""
    owned = user_owned_profile_ids(contract.created_by)
    mine = next((p for p in contract.parties.all() if p.profile_id in owned), None)
    return mine.role if mine is not None else None


def party_identity_snapshot(contract: Contract) -> dict[str, Any]:
    """Самодостаточный слепок обеих сторон для payload'ов событий-исходов
    сделки (Э4.6, docs/tasks/etap-4.md, доп. требование «док 31 §7»:
    репутационная карточка ГВ.4 строится ИСКЛЮЧИТЕЛЬНО из событий outbox —
    «не записанное сейчас не восстановится», поэтому событие не может
    полагаться на то, что ContractParty будет доступен позже тем же
    запросом. `profile_id` — первичная репутационная идентичность
    (domain-model.md §13: рейтинг начисляется ПРОФИЛЮ, не пользователю)."""
    snapshot: dict[str, Any] = {}
    for party in contract.parties.select_related("profile"):
        snapshot[party.role] = {
            "profile_id": str(party.profile_id),
            "acting_as": party.acting_as,
            "entity_id": str(party.entity_id) if party.entity_id else None,
        }
    return snapshot


# --- Э4.2: протокол разногласий ------------------------------------------


def list_revision_proposals(
    contract: Contract, *, status: str | None = None
) -> QuerySet[RevisionProposal]:
    """GET /contracts/{id}/revisions (tech-spec.md §8.4)."""
    qs = contract.revision_proposals.select_related("proposed_by", "decided_by").all()
    if status is not None:
        qs = qs.filter(status=status)
    return qs.order_by("-created_at")


def get_revision_proposal_or_404(revision_proposal_id: UUID) -> RevisionProposal:
    return get_object_or_404(
        RevisionProposal.objects.select_related("contract", "proposed_by"),
        pk=revision_proposal_id,
    )


def list_preapproved_alternatives(contract: Contract) -> QuerySet[PreapprovedAlternative]:
    """GET /contracts/{id}/preapproved-alternatives (tech-spec.md §8.4)."""
    return contract.preapproved_alternatives.select_related("created_by").order_by("-created_at")


def get_preapproved_alternative_or_404(alternative_id: UUID) -> PreapprovedAlternative:
    return get_object_or_404(
        PreapprovedAlternative.objects.select_related("contract"), pk=alternative_id
    )


@dataclass(frozen=True, slots=True)
class TimelineEntry:
    """Элемент хроники (ADR-134): строка outbox + производные поля
    представления. `kind` — стабильный ключ подписи (events.timeline_kind);
    `nested` — событие дочерней сущности (этап/допник/спор/платёж/гарантийная
    претензия), фронт показывает свёрнуто; `subject` — на что ссылаться
    (`title` — если издатель положил его в payload, иначе None)."""

    event: OutboxEvent
    kind: str
    nested: bool
    subject: dict[str, Any]
    title: str | None
    detail: str | None

    @property
    def event_id(self) -> UUID:
        return self.event.event_id

    @property
    def topic(self) -> str:
        return self.event.topic

    @property
    def occurred_at(self) -> datetime:
        return self.event.occurred_at

    @property
    def actor(self) -> dict[str, Any]:
        actor: dict[str, Any] = self.event.actor
        return actor

    @property
    def payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = self.event.payload
        return payload


def _timeline_subject(event: OutboxEvent) -> dict[str, Any]:
    """`subject: {type, id, title?}` — ссылка на сущность события. `title`
    берётся только из самого события (издатели milestones/disputes/payments
    кладут `milestone_title` в payload — док 31 §7 «самодостаточный payload»),
    без join на чужие таблицы: contracts не импортирует payments/disputes."""
    subject = event.subject or {}
    payload = event.payload or {}
    title = payload.get("milestone_title") if subject.get("type") != "contract" else None
    return {
        "type": subject.get("type"),
        "id": subject.get("id"),
        "title": title if isinstance(title, str) and title else None,
    }


def _timeline_entry(event: OutboxEvent, texts: dict[str, str]) -> TimelineEntry:
    subject = _timeline_subject(event)
    kind = events.timeline_kind(event.topic, event.payload)
    return TimelineEntry(
        event=event,
        kind=kind,
        nested=subject["type"] != "contract",
        subject=subject,
        # Нет текста ни в запрошенном языке, ни в en — честный `null`, а не
        # ключ под видом подписи (фронт показывает `kind`); лента не падает
        # и не пустеет (тест `test_unknown_kind_title_is_null`).
        title=texts.get(events.timeline_title_key(kind)),
        detail=events.render_timeline_detail(
            texts.get(events.timeline_detail_key(kind)), event.payload
        ),
    )


def timeline_entries(rows: Iterable[OutboxEvent], *, locale: str) -> list[TimelineEntry]:
    """Строки outbox -> элементы хроники с подписями на языке `locale`
    (`ui.timeline.*` из l10n-паков, фолбэк locale → en → `null`; один
    словарь на всю ленту — `get_ui_map`, не по запросу на элемент). Общий
    вход для лент сиблинг-сущностей (`apps.milestones.selectors.get_
    timeline`), чтобы один и тот же `TimelineEventSerializer` отдавал
    одинаковый контракт элемента."""
    texts = l10n_selectors.get_ui_map(events.TIMELINE_TEXT_PREFIX, locale=locale)
    return [_timeline_entry(event, texts) for event in rows]


def get_timeline(contract: Contract, *, locale: str) -> list[TimelineEntry]:
    """GET /contracts/{id}/timeline (tech-spec.md §8.4, §37a; ADR-134) —
    read-модель из outbox, без join на исходные таблицы (событие уже несёт
    весь нужный для ленты payload). Состав:

    - собственные события договора (`subject.type=contract`) КРОМЕ чата
      (`events.EXCLUDED_TOPICS` — решение владельца 26.08);
    - ключевые события дочерних сущностей (`events.NESTED_TOPICS`) — этапы,
      допники, споры, платежи, гарантийные претензии — по `contract_id`,
      который издатели кладут в `subject` (tech-spec.md §6.4, ADR-126) или
      в `payload` (допники: subject — сам допник); отдаются с `nested=True`.

    Порядок — по времени; `event_id` (uuid7, монотонный) — тай-брейк для
    событий одной транзакции (`contract.completed` + `contract.warranty_
    started`)."""
    contract_id = str(contract.id)
    own = Q(subject__type="contract", subject__id=contract_id) & ~Q(
        topic__in=events.EXCLUDED_TOPICS
    )
    nested = Q(topic__in=events.NESTED_TOPICS) & (
        Q(subject__contract_id=contract_id) | Q(payload__contract_id=contract_id)
    )
    rows = OutboxEvent.objects.filter(own | nested).order_by("occurred_at", "event_id")
    return timeline_entries(rows, locale=locale)


# --- Э4.4: заморозка и подписание ------------------------------------------


def get_contract_version_or_404(contract: Contract, version_id: UUID) -> ContractVersion:
    """GET /contracts/{id}/versions/{vid} (tech-spec.md §8.4)."""
    return get_object_or_404(ContractVersion, pk=version_id, contract=contract)


def get_signature_request_or_404(signature_request_id: UUID) -> SignatureRequest:
    return get_object_or_404(
        SignatureRequest.objects.select_related("contract", "amendment", "version", "signatory"),
        pk=signature_request_id,
    )


def list_signature_requests(contract: Contract) -> QuerySet[SignatureRequest]:
    """GET /contracts/{id}/signature-requests — только раунд ДОГОВОРА
    (`amendment__isnull=True`); раунды допников — `list_amendment_signature_
    requests` (Э4.5)."""
    return (
        contract.signature_requests.filter(amendment__isnull=True)
        .select_related("signatory", "version")
        .order_by("-sent_at")
    )


def list_pending_signature_requests_for_user(user: User) -> QuerySet[SignatureRequest]:
    """`apps.dashboards` (ADR-090): «ждёт моей подписи» — по ОБОИМ раундам
    (договор и допник, `amendment` не фильтруется намеренно — подписант не
    различает их на карточке «требует внимания», это один и тот же жест).
    `signatory` — прямой FK на `User` (не через `user_owned_profile_ids`),
    подписывает конкретный человек, не профиль."""
    return (
        SignatureRequest.objects.filter(signatory=user, status=SignatureRequest.Status.PENDING)
        .select_related("contract", "amendment")
        .order_by("expires_at")
    )


# --- Э4.5: допники -----------------------------------------------------------


def list_amendments(contract: Contract, *, viewer: User | None = None) -> QuerySet[Amendment]:
    """GET /contracts/{id}/amendments (tech-spec.md §8.6). `viewer` (ADR-161)
    — чей это список: ЧУЖИЕ ЧЕРНОВИКИ скрыты, до `send` допник существует
    только для своего инициатора. Фильтр в селекторе, а не на фронте: иначе
    заготовка второй стороны утекает в любой сторонний клиент. Без `viewer`
    (архивная выгрузка apps.archive) фильтра нет — там снимок всего, что
    было в договоре."""
    amendments = contract.amendments.select_related("created_by").order_by("order")
    if viewer is not None:
        amendments = amendments.exclude(
            Q(negotiation_status=Contract.NegotiationStatus.DRAFT) & ~Q(created_by=viewer)
        )
    return amendments


def is_amendment_visible_to(amendment: Amendment, user: User) -> bool:
    """Зеркало фильтра `list_amendments(viewer=...)` для одиночного допника
    (GET/PATCH/DELETE /amendments/{id})."""
    return (
        amendment.negotiation_status != Contract.NegotiationStatus.DRAFT
        or amendment.created_by_id == user.id
    )


def get_amendment_or_404(amendment_id: UUID) -> Amendment:
    return get_object_or_404(
        Amendment.objects.select_related("contract", "created_by", "frozen_version"),
        pk=amendment_id,
    )


def list_amendment_changes(amendment: Amendment) -> QuerySet[AmendmentChange]:
    return amendment.changes.order_by("created_at")


def list_amendment_signature_requests(amendment: Amendment) -> QuerySet[SignatureRequest]:
    """GET /amendments/{id}/signature-requests."""
    return amendment.signature_requests.select_related("signatory", "version").order_by("-sent_at")


def get_amendment_timeline(amendment: Amendment, *, locale: str) -> list[TimelineEntry]:
    """GET /amendments/{id}/timeline — тот же приём, что `get_timeline`
    (read-модель из outbox), но `subject.type="amendment"`: допник — сиблинг-
    сущность со своим событийным потоком. В хронику ДОГОВОРА из него
    попадают только ключевые точки (`events.NESTED_TOPICS`: отправлен /
    отклонён / отозван; «подписан обеими» — это `contract.amended` на самом
    договоре). Здесь `nested=True` у всех строк (subject — допник), фронту
    на этом экране сворачивать нечего."""
    rows = OutboxEvent.objects.filter(
        subject__type="amendment", subject__id=str(amendment.id)
    ).order_by("occurred_at", "event_id")
    return timeline_entries(rows, locale=locale)


def contract_total_money(contract: Contract) -> Money | None:
    """Публичный фасад «сумма договора» = сумма листьев (tech-spec.md §6.1).
    `None` — дерева этапов ещё нет. Отложенный импорт apps.milestones — тот
    же цикл-риск, что в `services.freeze_contract` (см. её докстринг);
    именно поэтому фасад живёт здесь, а не в apps.milestones: вызывающим
    (событие `contract.completed`, бэкфилл репутации ADR-163) нужен
    ДОГОВОР, а не дерево.
    """
    from apps.milestones import services as milestones_services

    try:
        return milestones_services.total_leaf_amount(contract)
    except ValueError:
        return None


# --- Удерживающие основания удаления аккаунта (ADR-169, tech-spec.md §10.2:
# «проверка удерживающих оснований (активные договоры, законные сроки
# хранения)») ------------------------------------------------------------
#
# Живёт ЗДЕСЬ, а не в apps.accounts: сводить два независимых статуса договора
# в понятие «сделка ещё живая» вправе только владелец FSM. apps.accounts
# зовёт эту функцию через `settings.ACCOUNT_DELETION_HOLDS` + `import_string`
# — статического импорта apps.accounts -> apps.contracts быть не может
# (import-linter, контракт «social зависит только от accounts»: apps.social
# импортирует apps.accounts, и прямой импорт «протёк» бы транзитивной
# зависимостью social -> contracts).

#: Согласование идёт — договор ещё не заключён, но переговоры живые.
#: `draft` НЕ здесь: черновик односторонен и юридически ничего не значит.
#: `rejected_by_counterparty` / `withdrawn_by_initiator` — терминальные.
ACTIVE_NEGOTIATION_STATUSES: tuple[str, ...] = (
    Contract.NegotiationStatus.UNDER_REVIEW,
    Contract.NegotiationStatus.PENDING_SIGNATURE,
    Contract.NegotiationStatus.AWAITING_SIGNATURES,
)
#: Исполнение идёт (договор подписан). `warranty` — тоже живое обязательство
#: (по нему открываются гарантийные заявки, ADR-131). Не здесь: `completed`
#: (работы сданы и приняты), `closed`, `terminated_by_*`.
ACTIVE_EXECUTION_STATUSES: tuple[str, ...] = (
    Contract.ExecutionStatus.PENDING_START,
    Contract.ExecutionStatus.IN_PROGRESS,
    Contract.ExecutionStatus.WARRANTY,
)


def count_active_contracts_for_user(user_id: Any) -> int:  # noqa: ANN401
    """Сколько договоров пользователя удерживают удаление аккаунта.

    Договор удерживает, если ИЛИ идёт согласование
    (`ACTIVE_NEGOTIATION_STATUSES`), ИЛИ он подписан и исполнение не
    завершено (`ACTIVE_EXECUTION_STATUSES`; `execution_status IS NULL` у
    подписанного — тот же «живой», состояние между подписью и простановкой
    статуса исполнения).

    `user_id`, а не `User`: контракт хука `ACCOUNT_DELETION_HOLDS` не должен
    тащить чужую модель через настройку.
    """
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        return 0
    owned = user_owned_profile_ids(user)
    if not owned:
        return 0
    signed = Q(negotiation_status=Contract.NegotiationStatus.SIGNED) & (
        Q(execution_status__in=ACTIVE_EXECUTION_STATUSES) | Q(execution_status__isnull=True)
    )
    return (
        Contract.objects.filter(parties__profile_id__in=owned)
        .filter(Q(negotiation_status__in=ACTIVE_NEGOTIATION_STATUSES) | signed)
        .distinct()
        .count()
    )


def account_deletion_holds(user_id: Any) -> dict[str, int]:  # noqa: ANN401
    """Вклад apps.contracts в `context` ответа 409 `account_deletion_blocked`
    (ADR-169). Форма — `{"active_contracts": N}`: ключи вкладов складываются
    в один словарь, поэтому каждый обязан быть уникальным по приложению."""
    return {"active_contracts": count_active_contracts_for_user(user_id)}
