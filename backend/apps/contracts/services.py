"""Use cases apps.contracts — Э4.1 (docs/tasks/etap-4.md): черновик и
сегментация через клиентское дерево каталога v2. Э4.2 — протокол
разногласий (RevisionProposal/PreapprovedAlternative) и FSM согласования
draft->under_review->терминалы. Э4.4 — заморозка (`freeze_contract`) и
подписание (`route_signatory`/`sign`/`forward`/`decline_for_revision`/
`expire_signature_request`, NEGOTIATION_FSM ниже): under_review ->
pending_signature -> awaiting_signatures -> signed (tech-spec.md §6.1).
ADR-124 — `return_for_revision` (любой стороной, без запроса подписи) и
`reject`/`withdraw` из замороженных состояний с аннулированием раунда.
Э4.5 — допники (`create_amendment`/`freeze_amendment`/
`route_amendment_signatory`/`sign_amendment`/
`forward_amendment_signature_request`/`decline_amendment_for_revision`/
`expire_amendment_signature_request`/`apply_amendment`/`effective_terms`;
дополнение 26.08 к ADR-075 — `withdraw_amendment`/`reject_amendment`):
ТОТ ЖЕ `NEGOTIATION_FSM` — Amendment проходит идентичный путь согласования/
заморозки/подписания, что и Contract, просто на своём поле
`negotiation_status` (буквально тот же choices-класс). `SignatureRequest`/
`Signature` теперь несут nullable `amendment` — контракт-уровневые функции
(`route_signatory`/`sign`/`decline_for_revision`) фильтруют
`amendment__isnull=True`, чтобы не путать раунд договора с раундом допника.

Роли ContractParty универсальны для всех веток клиентского дерева: customer
платит/принимает, contractor поставляет услугу/товар/вещь в аренду/заём
(для «Займа» заёмщик — customer, займодавец — contractor: он «поставляет»
деньги, симметрично остальным типам).

`acting_as` стороны не запрашивается у контрагента текстом — выводится из
резолвленного Profile (`kind=business` -> business, `owner_entity`; иначе
person, `owner_user.has_business_status`). Для инициатора (себя) —
единственная сторона, где кабинет должен явно выбрать, каким профилем он
входит в сделку, поэтому `my_acting_as`/`my_entity_id` — параметры вызова.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, NamedTuple
from uuid import UUID

from django.db import transaction
from django.db.models import Max
from django.http import Http404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from django.utils.timezone import is_aware

from apps.accounts.models import User
from apps.accounts.selectors import get_user_locale
from apps.authority import services as authority_services
from apps.catalog import selectors as catalog_selectors
from apps.catalog import services as catalog_services
from apps.catalog.models import ContractTypeCatalogItem
from apps.deadlines import selectors as deadlines_selectors
from apps.deadlines import services as deadlines_services
from apps.entities.models import BusinessEntity
from apps.jurisdictions.selectors import resolve_locale
from apps.l10n import selectors as l10n_selectors
from apps.notifications import services as notifications_services
from apps.profiles import services as profiles_services
from apps.profiles.models import Profile
from apps.social import selectors as social_selectors
from common import outbox
from common.canonical import canonical_json_bytes, sha256_hex
from common.fsm import InvalidTransitionError, StateMachine, Transition
from common.money import CurrencyMismatchError, Money
from common.timestamps import DEFAULT_TIMESTAMP_PROVIDER, TimestampProvider

from . import forms
from .events import Topic
from .models import (
    Amendment,
    AmendmentChange,
    Contract,
    ContractParty,
    ContractVersion,
    PreapprovedAlternative,
    RevisionProposal,
    Signature,
    SignatureRequest,
)
from .selectors import (
    contract_total_money,
    party_identity_snapshot,
    party_user,
    party_users,
    resolve_shown_locale,
    user_owned_profile_ids,
)

if TYPE_CHECKING:
    # Только для аннотаций типов — рантайм-импорт apps.milestones внутри
    # функций остаётся отложенным (см. docstring freeze_contract: разрыв
    # цикла, apps.milestones уже импортирует apps.contracts на уровне
    # модуля). mypy этот блок не исполняет, цикла для него нет.
    from apps.milestones.models import ContractMaterial as _ContractMaterial
    from apps.milestones.models import Milestone as _Milestone

_ROLE = ContractParty.Role
_ACTING_AS = ContractParty.ActingAs
_CLIENT_OPTION = ContractTypeCatalogItem.ClientOption
_NEGOTIATION = Contract.NegotiationStatus
_REVISION_STATUS = RevisionProposal.Status
_SIG_STATUS = SignatureRequest.Status
_CHANGE_TYPE = AmendmentChange.Type

# §6.1: draft->under_review (send), протокол разногласий (under_review-
# >under_review, self-loop-гейт "правки идут только пока на согласовании"),
# оба терминала (Э4.2) и заморозка/подписание (Э4.4, tech-spec.md §6.1):
#   under_review -> pending_signature          freeze
#   pending_signature -> awaiting_signatures   route_signatory (1-й вызов)
#   awaiting_signatures -> awaiting_signatures route_signatory (2-я сторона) / sign (1-я подпись)
#   awaiting_signatures -> signed              complete_signing (2-я подпись)
#   awaiting_signatures -> pending_signature   forward_signature_request / expire_signature_request
#   awaiting_signatures -> under_review        decline_for_revision
# ADR-124 (этап подписания без «заявки на подпись» в UI): из ОБОИХ замороженных
# состояний доступны те же жесты, что и на согласовании, — выход из заморозки
# аннулирует раунд подписания (`_annul_signing_round`):
#   pending_signature / awaiting_signatures -> under_review              return_for_revision
#   pending_signature / awaiting_signatures -> rejected_by_counterparty  reject
#   pending_signature / awaiting_signatures -> withdrawn_by_initiator    withdraw
NEGOTIATION_FSM = StateMachine(
    states=[s.value for s in _NEGOTIATION],
    transitions=[
        Transition("send", _NEGOTIATION.DRAFT, _NEGOTIATION.UNDER_REVIEW),
        Transition("revise", _NEGOTIATION.UNDER_REVIEW, _NEGOTIATION.UNDER_REVIEW),
        Transition("withdraw", _NEGOTIATION.UNDER_REVIEW, _NEGOTIATION.WITHDRAWN_BY_INITIATOR),
        Transition("reject", _NEGOTIATION.UNDER_REVIEW, _NEGOTIATION.REJECTED_BY_COUNTERPARTY),
        Transition("freeze", _NEGOTIATION.UNDER_REVIEW, _NEGOTIATION.PENDING_SIGNATURE),
        Transition(
            "route_signatory", _NEGOTIATION.PENDING_SIGNATURE, _NEGOTIATION.AWAITING_SIGNATURES
        ),
        Transition(
            "route_signatory", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.AWAITING_SIGNATURES
        ),
        Transition("sign", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.AWAITING_SIGNATURES),
        Transition("complete_signing", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.SIGNED),
        Transition(
            "forward_signature_request",
            _NEGOTIATION.AWAITING_SIGNATURES,
            _NEGOTIATION.PENDING_SIGNATURE,
        ),
        Transition(
            "expire_signature_request",
            _NEGOTIATION.AWAITING_SIGNATURES,
            _NEGOTIATION.PENDING_SIGNATURE,
        ),
        Transition(
            "decline_for_revision", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.UNDER_REVIEW
        ),
        # ADR-124: возврат на доработку любой стороной (без заявки на подпись).
        Transition(
            "return_for_revision", _NEGOTIATION.PENDING_SIGNATURE, _NEGOTIATION.UNDER_REVIEW
        ),
        Transition(
            "return_for_revision", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.UNDER_REVIEW
        ),
        # ADR-124: терминалы согласования доступны и из заморозки.
        Transition("reject", _NEGOTIATION.PENDING_SIGNATURE, _NEGOTIATION.REJECTED_BY_COUNTERPARTY),
        Transition(
            "reject", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.REJECTED_BY_COUNTERPARTY
        ),
        Transition("withdraw", _NEGOTIATION.PENDING_SIGNATURE, _NEGOTIATION.WITHDRAWN_BY_INITIATOR),
        Transition(
            "withdraw", _NEGOTIATION.AWAITING_SIGNATURES, _NEGOTIATION.WITHDRAWN_BY_INITIATOR
        ),
    ],
)


class CounterpartyNotFoundError(ValueError):
    """`profile_id`/`@handle`/`entity_id` не резолвится в существующую запись."""


class CounterpartyIsGroupError(ValueError):
    """`@handle` принадлежит AddressableGroup, не пользователю — группа не
    может быть стороной договора (Э4.1: только двусторонние сделки)."""


class SelfDealingError(ValueError):
    """Инициатор и контрагент резолвятся в один и тот же профиль."""


class EntityNotControlledError(ValueError):
    """`acting_as=business` с юрлицом, контроль над которым не подтверждён
    вызывающим пользователем (`claim_status != claimed` или чужой
    `claimed_by`) — представительство чужого юрлица не даёт права заключать
    от его имени договоры (CLAUDE.md)."""


class ClientOptionRequiresExplicitCodeError(ValueError):
    """Только «Услуга» резолвится автоматически по статусу исполнителя
    (docs/catalog-v2.md §1) — для остальных опций клиентского дерева
    `contract_type_code` обязателен."""


class DraftNotEditableError(ValueError):
    """PATCH/пересчёт доступны только пока `negotiation_status=draft` —
    после отправки контрагенту правки идут через протокол разногласий
    (Э4.2), не через свободный PATCH."""


class LanguageNotEligibleError(ValueError):
    """Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2): явный выбор
    языка договора через PATCH черновика ограничен quality ≥ reviewed
    (`apps.l10n.selectors.is_reviewed_or_better`) — `machine`-язык, выключенная
    или несуществующая `Locale` не годится в качестве официального языка
    договора (beta-перевод не может быть тем, от чего считается "перевод для
    удобства")."""


class AdditionalTermsInvalidError(ValueError):
    """ADR-167: ручной ввод «Дополнительных условий» в мастере (PATCH
    черновика) не проходит проверку — не список, не строки, пустой пункт
    после `strip`, пункт длиннее `ADDITIONAL_TERM_MAX_LENGTH` или больше
    `ADDITIONAL_TERMS_MAX_ITEMS` пунктов. `errors` — список
    `{"field", "code", "message"}`, тот же формат, что у
    `forms.FormValidationError` и `RevisionValueInvalidError`
    (`400 additional_terms_invalid`)."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("дополнительные условия не прошли проверку")
        self.errors = errors


class NotAPartyError(ValueError):
    """Вызывающий пользователь не является стороной этого договора."""


class SourceContractNotAccessibleError(ValueError):
    """`source_contract_id` указывает на договор, где вызывающий пользователь
    не был стороной — «как в прошлый раз» не может подглядывать чужие сделки."""


class PaymentMethodRequiredError(ValueError):
    """`send` без выбранного способа расчёта (отсмотр 2026-08-22: «способ
    оплаты обязателен, дальше не пускать») — фронт гейтит «Далее», бэк
    дублирует инвариант: договор не уходит контрагенту без способа оплаты."""


class PaymentOrderRequiredError(ValueError):
    """ADR-151: `send` без выбранного порядка оплаты (замечание владельца
    02.09: «порядок оплаты — для всех договоров») — тот же приём, что
    `PaymentMethodRequiredError`: фронт гейтит «Далее», бэк дублирует
    инвариант. Только для типов, где порядок применим
    (`payment_order_applicable`)."""


class PaymentOrderNotApplicableError(ValueError):
    """ADR-151: попытка задать `payment_order` договору типа, где порядок
    оплаты не имеет смысла (клиентская опция `loan`: лист-этап займа — сам
    денежный транш, «оплата до/после исполнения этапа» не определена).
    `400 payment_order_not_applicable` в api/ — явный отказ вместо молчаливо
    сохранённого бессмысленного условия."""


class NotInitiatorError(ValueError):
    """`withdraw` — терминальный переход только для инициатора (§6.1:
    «Инициатор»), не для контрагента. Инициатор = `Contract.created_by`."""


class NotCounterpartyError(ValueError):
    """`reject` — терминальный переход только для «второй стороны» (§6.1),
    т.е. не для инициатора (`Contract.created_by`)."""


class OwnProposalDecisionError(ValueError):
    """accept/reject/counter применяется к чужому предложению — сторона не
    решает за саму себя (нет смысла принимать/отклонять собственную правку;
    встречная редакция — тоже ответ другой стороны на предложение)."""


class RevisionProposalNotOpenError(ValueError):
    """Предложение уже не `open` (принято/отклонено/заменено) — решение по
    нему принять нельзя, только по актуальному (свежему) предложению."""


class RevisionItemUnknownError(LookupError):
    """ADR-123: `item_ref` вида `form.<key>` ссылается на поле, которого нет
    в схеме формы типа договора (или у типа нет схемы) — правка не может быть
    ни показана с «Было», ни применена (`422 revision_item_unknown`)."""


class RevisionValueInvalidError(ValueError):
    """ADR-123: значение правки не проходит схему формы при применении
    (`accept`) либо не годится по грамматике `item_ref` (пустой текст для
    `other`, не-строка для `title`). `errors` — список `{"field", "code",
    "message"}` как у `forms.FormValidationError` (`422
    revision_value_invalid`, предложение остаётся `open`)."""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("значение правки не прошло проверку")
        self.errors = errors


class OpenRevisionsError(ValueError):
    """freeze: у договора есть открытые (`open`) правки протокола
    разногласий — заморозить нельзя, пока стороны не закрыли раунд
    (tech-spec.md §6.1, §8.4: `422 open_revisions`)."""


class EmptyMilestoneTreeError(ValueError):
    """freeze: дерево этапов пусто — «сумма листьев = сумма договора»
    (tech-spec.md §6.1) физически не из чего посчитать (`422
    leaf_sum_mismatch`, etap-4.md Э4.4: сумма листьев И ЕСТЬ сумма договора,
    отдельного «объявленного итога» в схеме нет — см. freeze_contract)."""


class RequisitesMissingError(ValueError):
    """freeze: `payment_method` предполагает расчёты ЧЕРЕЗ ПЛАТФОРМУ
    (`Contract.PROTECTED_PAYMENT_METHODS`) — реквизиты выплат получателя не
    заполнены. Редакция v2 (etap-4.md Э4.4): условие НЕ «для платных
    сегментов» (tech-spec.md §6.1 в исходной редакции), а именно для
    расчётов через платформу — `409 requisites_missing`."""


class StaleVersionError(ValueError):
    """`version_hash`/`version_id`, переданный в теле запроса, не совпадает
    с текущей замороженной версией договора — устарел (правка сняла
    заморозку) либо просто неверный. `409 version_stale` (api/): подписать
    «не то» физически невозможно (etap-4.md Э4.4)."""


class SignatureRequestAlreadyPendingError(ValueError):
    """Для этой стороны уже есть незакрытый (`pending`) запрос подписи —
    повторная маршрутизация до его разрешения (подпись/переадресация/
    отклонение/тайм-аут) не создаёт второй параллельный запрос."""


class SignatoryNotEligibleError(ValueError):
    """`signatory_user_id` не входит в список подписантов стороны
    (`list_signatories`) — либо не резолвится в стороны договора вовсе, либо
    лимит SigningAuthority (этап 3.5) его не пропускает."""


class NotThisSidePartyError(ValueError):
    """Маршрутизировать подпись стороны может только сама эта сторона —
    нельзя выбрать подписанта за контрагента."""


class NotTheSignatoryError(ValueError):
    """sign/forward/decline_for_revision вызваны не тем пользователем,
    которому адресован конкретный SignatureRequest."""


class SignatureRequestNotPendingError(ValueError):
    """Запрос подписи уже разрешён (подписан/переадресован/отклонён/истёк)
    — повторное действие над ним запрещено."""


class ContractNotSignedError(ValueError):
    """create_amendment: допник можно завести только к уже ПОДПИСАННОМУ
    договору (etap-4.md Э4.5) — до подписания правки идут через протокол
    разногласий (Э4.2) или свободный PATCH черновика (Э4.1), не через допник."""


class AmendmentRemoveTargetNotLeafError(ValueError):
    """`remove_milestone`: цель — не лист (есть дети). Убрать допником можно
    только лист — то же ограничение, что у структуры до подписания
    (`MilestoneNotLeafError`), здесь отдельный класс: причина другая (не
    «чек-лист/материалы только на листе», а «частичное удаление ветки
    допником не специфицировано»)."""


class AmendmentTargetsAcceptedMilestoneError(ValueError):
    """«Нельзя удешевить/убрать принятое» (etap-4.md Э4.5, приёмка): цель
    `remove_milestone`/удешевляющего `modify_milestone` уже принята
    (`accepted_at IS NOT NULL`) — `422`."""


class AmendmentTargetsReceivedMaterialError(ValueError):
    """«Нельзя убрать полученный материал» (etap-4.md Э4.5, приёмка): цель
    `remove_material` уже получена (`ContractMaterial.received=True`) —
    `422`."""


class AmendmentChangeTargetNotFoundError(LookupError):
    """`target` в change не резолвится в существующий Milestone/
    ContractMaterial этого договора."""


class AmendmentNotDraftError(ValueError):
    """PATCH/DELETE допника (ADR-161) доступны только пока
    `negotiation_status=draft`. После `send` допник — предмет согласования
    ВТОРОЙ стороны: менять его молча нельзя, путь один — `withdraw` и новый
    допник. Отдельный класс, а не `DraftNotEditableError`: тот про черновик
    ДОГОВОРА и отдаёт код `draft_not_editable` с текстом про протокол
    разногласий, которого у допников нет."""


class ConfirmSummaryRequiredError(ValueError):
    """accept-all при наличии финансово значимых открытых правок требует
    `confirm_summary=True` (tech-spec.md §8.4/§13.2) — без него ничего не
    применяется. `summary` — список «было -> стало» для явного показа
    пользователю перед повторным вызовом."""

    def __init__(self, message: str, *, summary: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.summary = summary


def _resolve_own_party(
    *, user: User, acting_as: str, entity_id: UUID | None
) -> tuple[Profile, BusinessEntity | None, bool]:
    """Сторона от лица вызывающего пользователя: `acting_as` выбирается им
    явно (каким из своих профилей он входит в сделку), в отличие от
    контрагента, чей `acting_as` выводится из резолвленного профиля."""
    if acting_as == _ACTING_AS.BUSINESS:
        if entity_id is None:
            raise EntityNotControlledError("acting_as=business требует entity_id")
        try:
            entity = BusinessEntity.objects.get(pk=entity_id)
        except BusinessEntity.DoesNotExist as exc:
            raise CounterpartyNotFoundError(f"юрлицо {entity_id} не найдено") from exc
        if (
            entity.claim_status != BusinessEntity.ClaimStatus.CLAIMED
            or entity.claimed_by_id != user.id
        ):
            raise EntityNotControlledError(
                f"контроль над юрлицом {entity_id} не подтверждён пользователем {user.id}"
            )
        profile = profiles_services.get_or_create_business_profile(entity)
        return profile, entity, False

    profile, _created = Profile.objects.get_or_create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        defaults={"profile_visibility": Profile.Visibility.LINK_AND_DEALS},
    )
    return profile, None, bool(user.has_business_status)


def _party_status(profile: Profile) -> tuple[BusinessEntity | None, bool]:
    """(entity, has_business_status) — для профиля, уже существующего в
    базе (контрагент или сторона уже созданного договора), `acting_as`
    выводится из `profile.kind`, не запрашивается отдельно."""
    if profile.kind == Profile.Kind.BUSINESS:
        return profile.owner_entity, False
    return None, bool(profile.owner_user.has_business_status if profile.owner_user else False)


def _resolve_counterparty_profile(*, profile_id: UUID | None, handle: str | None) -> Profile:
    if profile_id is not None:
        try:
            return Profile.objects.select_related("owner_user", "owner_entity").get(pk=profile_id)
        except Profile.DoesNotExist as exc:
            raise CounterpartyNotFoundError(f"профиль {profile_id} не найден") from exc
    if handle is not None:
        # Фронт шлёт хендл С «@» (HandleEntry, ADR-092) — нормализуем так же,
        # как сам селектор (strip/lstrip/lower), иначе тексты ошибок ниже
        # печатали «@@handle» (§E-смоук 2026-08-18).
        handle = handle.strip().lstrip("@").lower()
        try:
            handle_obj = social_selectors.get_active_handle_or_404(handle)
        except Http404 as exc:
            raise CounterpartyNotFoundError(f"хендл @{handle} не найден") from exc
        if handle_obj.group_id is not None:
            raise CounterpartyIsGroupError(f"@{handle} — группа, не может быть стороной договора")
        try:
            return Profile.objects.select_related("owner_user").get(
                kind=Profile.Kind.PERSON, owner_user_id=handle_obj.user_id
            )
        except Profile.DoesNotExist as exc:
            raise CounterpartyNotFoundError(
                f"у @{handle} ещё нет профиля (не завершён шаг приватности)"
            ) from exc
    raise CounterpartyNotFoundError("контрагент не указан: нужен profile_id или handle")


def _party_user_ids(contract: Contract) -> list[str]:
    """ADR-106: user_id владельцев person-профилей сторон — для payload
    событий contract.drafted / draft_patched / signed. apps.social по ним
    заводит контакты source=deal, НЕ импортируя apps.contracts (import-linter:
    social зависит только от accounts). Бизнес-профиль (owner_entity) в список
    не попадает — у юрлица нет «пользователя-контакта»."""
    ids: list[str] = []
    for party in contract.parties.select_related("profile").all():
        user_id = party.profile.owner_user_id
        if user_id is not None and str(user_id) not in ids:
            ids.append(str(user_id))
    return ids


def _compute_deal_type(a_acting_as: str, b_acting_as: str) -> str:
    if a_acting_as == _ACTING_AS.BUSINESS and b_acting_as == _ACTING_AS.BUSINESS:
        return Contract.DealType.B2B
    if a_acting_as == _ACTING_AS.PERSON and b_acting_as == _ACTING_AS.PERSON:
        return Contract.DealType.C2C
    return Contract.DealType.B2C


def _resolve_contract_type_code(
    *,
    client_option: str | None,
    contract_type_code: str | None,
    contractor_acting_as: str,
    contractor_has_business_status: bool,
) -> str:
    if client_option == _CLIENT_OPTION.SERVICE:
        return catalog_services.resolve_service_contract_type_code(
            contractor_acting_as=contractor_acting_as,
            contractor_has_business_status=contractor_has_business_status,
        )
    if contract_type_code:
        return contract_type_code
    raise ClientOptionRequiresExplicitCodeError(
        f"client_option={client_option!r}: нужен явный contract_type_code"
    )


def _protected_for(payment_method: str | None) -> bool:
    return payment_method in Contract.PROTECTED_PAYMENT_METHODS


def payment_order_applicable(contract_type_code: str) -> bool:
    """ADR-151: применим ли «порядок оплаты» к типу договора. Неприменим
    только для клиентской опции `loan` (см. `PaymentOrderNotApplicableError`);
    услуга/продажа/аренда — применим (владелец: «в продажах и аренде тоже
    будет этот пункт»). Тип вне клиентского дерева (`client_option` пуст,
    служебные коды) — применим: условие безвредно, а запрет удивил бы."""
    client_option = (
        ContractTypeCatalogItem.objects.filter(code=contract_type_code)
        .values_list("client_option", flat=True)
        .first()
    )
    return client_option != ContractTypeCatalogItem.ClientOption.LOAN


def _assert_payment_order_applicable(contract_type_code: str, payment_order: str | None) -> None:
    if payment_order is not None and not payment_order_applicable(contract_type_code):
        raise PaymentOrderNotApplicableError(
            f"тип {contract_type_code!r}: порядок оплаты ({payment_order!r}) неприменим"
        )


def get_party_for_user(contract: Contract, user: User) -> ContractParty:
    owned = user_owned_profile_ids(user)
    for party in contract.parties.all():
        if party.profile_id in owned:
            return party
    raise NotAPartyError(f"пользователь {user.id} не сторона договора {contract.id}")


def is_party(contract: Contract, user: User) -> bool:
    try:
        get_party_for_user(contract, user)
    except NotAPartyError:
        return False
    return True


def mark_materials_seen(
    contract: Contract, *, user: User, seen_at: datetime | None = None
) -> ContractParty:
    """ADR-158. «Материалы этапов просмотрены» СВОЕЙ стороной договора —
    серверная замена локальной отметке в браузере: бейдж «Материалы изменены
    контрагентом» гас только на том устройстве, где по нему кликнули.

    Отметка МОНОТОННА и идемпотентна: назад не двигается, повторный вызов с
    тем же (или более ранним) моментом не меняет строку и не пишет в БД. Это
    и делает эндпоинт безопасно повторяемым без Idempotency-Key: ключ нужен
    денежным и подписным POST, где повтор создаёт СУЩНОСТЬ, а здесь повтор
    по построению приводит к тому же состоянию.

    `seen_at` — момент правки, которую сторона фактически увидела (фронт
    берёт его из хроники договора). Он ЗАЖИМАЕТСЯ текущим временем: иначе
    клиент отметкой «просмотрено до 2099 года» навсегда заглушил бы бейдж по
    будущим правкам контрагента. Без параметра — «просмотрено сейчас».

    Не сторона договора -> NotAPartyError (403 общим маппингом views.py).
    Вторая сторона не затрагивается: у каждой стороны своя строка
    ContractParty (UniqueConstraint contract+role).
    """
    party = get_party_for_user(contract, user)
    now = timezone.now()
    moment = now if seen_at is None else min(seen_at, now)
    if party.materials_seen_at is not None and party.materials_seen_at >= moment:
        return party
    party.materials_seen_at = moment
    party.save(update_fields=["materials_seen_at"])
    return party


def _get_source_contract(source_contract_id: UUID, *, user: User) -> Contract:
    try:
        source = Contract.objects.prefetch_related("parties__profile__owner_entity").get(
            pk=source_contract_id
        )
    except Contract.DoesNotExist as exc:
        raise SourceContractNotAccessibleError(f"договор {source_contract_id} не найден") from exc
    if not is_party(source, user):
        raise SourceContractNotAccessibleError(
            f"пользователь {user.id} не был стороной договора {source_contract_id}"
        )
    return source


# --- ADR-167: дополнительные условия, ручной ввод в мастере ----------------
#
# Тот же список `Contract.additional_terms`, что и у принятой правки «Другое»
# (ADR-123): у сторон нет другого места под произвольный текст, а заводить
# второе поле значило бы склеивать два списка при заморозке. Ручной ввод
# доступен только на черновике (гейт `patch_draft`: `negotiation_status =
# draft`, иначе `DraftNotEditableError` -> 409); после отправки список растёт
# только через протокол разногласий, после подписания — только допником.

ADDITIONAL_TERM_MAX_LENGTH = 2000
ADDITIONAL_TERMS_MAX_ITEMS = 20
_ADDITIONAL_TERMS_FIELD = "additional_terms"


def _additional_terms_error(field: str, code: str, message: str) -> AdditionalTermsInvalidError:
    return AdditionalTermsInvalidError([{"field": field, "code": code, "message": message}])


def clean_additional_terms(value: Any) -> list[str]:  # noqa: ANN401
    """Нормализует список дополнительных условий из PATCH/POST черновика:
    список строк, каждая непустая после `strip`, не длиннее
    `ADDITIONAL_TERM_MAX_LENGTH`, не больше `ADDITIONAL_TERMS_MAX_ITEMS`
    пунктов. Ошибки — `AdditionalTermsInvalidError` (400
    `additional_terms_invalid`) со списком `{field, code, message}`; `field`
    указывает на конкретный пункт (`additional_terms.0`), чтобы форма мастера
    подсветила нужное поле.

    Ограничения НЕ применяются к правке «Другое» (ADR-123): принятая
    сторонами правка — согласованное условие договора, отказать в её
    применении из-за счётчика пунктов нельзя (это сломало бы FSM протокола
    разногласий уже после `accept`)."""
    if not isinstance(value, list):
        raise _additional_terms_error(
            _ADDITIONAL_TERMS_FIELD, "invalid", "дополнительные условия — список строк"
        )
    if len(value) > ADDITIONAL_TERMS_MAX_ITEMS:
        raise _additional_terms_error(
            _ADDITIONAL_TERMS_FIELD,
            "max_items",
            f"не больше {ADDITIONAL_TERMS_MAX_ITEMS} пунктов",
        )
    cleaned: list[str] = []
    for index, item in enumerate(value):
        field = f"{_ADDITIONAL_TERMS_FIELD}.{index}"
        if not isinstance(item, str):
            raise _additional_terms_error(field, "invalid", "пункт должен быть строкой")
        text = item.strip()
        if not text:
            raise _additional_terms_error(field, "required", "пункт не может быть пустым")
        if len(text) > ADDITIONAL_TERM_MAX_LENGTH:
            raise _additional_terms_error(
                field,
                "max_length",
                f"пункт длиннее {ADDITIONAL_TERM_MAX_LENGTH} символов",
            )
        cleaned.append(text)
    return cleaned


@transaction.atomic
def create_draft(
    *,
    user: User,
    my_role: str,
    my_acting_as: str = _ACTING_AS.PERSON,
    my_entity_id: UUID | None = None,
    client_option: str | None = None,
    contract_type_code: str | None = None,
    counterparty_profile_id: UUID | None = None,
    counterparty_handle: str | None = None,
    payment_method: str | None = None,
    payment_order: str | None = None,
    title: str = "",
    form_data: dict[str, Any] | None = None,
    # ADR-167: дополнительные условия, введённые вручную в мастере. Из
    # `source_contract_id` НЕ копируются: пункты исходной сделки — итог её
    # протокола разногласий, к новому договору они не относятся (в отличие
    # от типа/сторон/формы, которые «как в прошлый раз» осмысленны).
    additional_terms: list[str] | None = None,
    jurisdiction: str = "RU",
    source_contract_id: UUID | None = None,
) -> Contract:
    """POST /contracts (tech-spec.md §8.4). Сервер считает `segment` (§6.6);
    `excluded`-тип -> `ContractTypeExcludedError` (403 в api/), недостроенные
    типы (авто/недвижимость) -> `ContractTypeNotYetSupportedError` (409)."""
    if source_contract_id is not None:
        source = _get_source_contract(source_contract_id, user=user)
        client_option = client_option or source.contract_type.client_option
        contract_type_code = contract_type_code or source.contract_type_id
        payment_method = payment_method if payment_method is not None else source.payment_method
        payment_order = payment_order if payment_order is not None else source.payment_order
        title = title or source.title
        if form_data is None:
            form_data = dict(source.form_data)
        if counterparty_profile_id is None and counterparty_handle is None:
            my_party_in_source = get_party_for_user(source, user)
            other = source.parties.exclude(id=my_party_in_source.id).get()
            counterparty_profile_id = other.profile_id

    my_profile, my_entity, my_has_business_status = _resolve_own_party(
        user=user, acting_as=my_acting_as, entity_id=my_entity_id
    )
    counterparty_profile = _resolve_counterparty_profile(
        profile_id=counterparty_profile_id, handle=counterparty_handle
    )
    if counterparty_profile.id == my_profile.id:
        raise SelfDealingError("нельзя заключить договор с самим собой")
    cp_entity, cp_has_business_status = _party_status(counterparty_profile)
    cp_acting_as = _ACTING_AS.BUSINESS if cp_entity is not None else _ACTING_AS.PERSON

    counterparty_role = _ROLE.CONTRACTOR if my_role == _ROLE.CUSTOMER else _ROLE.CUSTOMER
    if my_role == _ROLE.CONTRACTOR:
        contractor_acting_as, contractor_has_business_status = my_acting_as, my_has_business_status
    else:
        contractor_acting_as, contractor_has_business_status = cp_acting_as, cp_has_business_status

    resolved_code = _resolve_contract_type_code(
        client_option=client_option,
        contract_type_code=contract_type_code,
        contractor_acting_as=contractor_acting_as,
        contractor_has_business_status=contractor_has_business_status,
    )
    # Может бросить ContractTypeExcludedError/ContractTypeNotYetSupportedError
    # (apps.catalog.services) — до записи, ничего ещё не создано.
    segment = catalog_services.compute_segment(
        resolved_code,
        contractor_acting_as=contractor_acting_as,
        contractor_has_business_status=contractor_has_business_status,
    )
    deal_type = _compute_deal_type(my_acting_as, cp_acting_as)
    # ADR-151: порядок оплаты неприменим к займу — явный отказ, а не молчаливое
    # сохранение; копия «как в прошлый раз» с типа, где он был, на займ его
    # молча роняет (условие исходника к новому типу не относится).
    if source_contract_id is not None and not payment_order_applicable(resolved_code):
        payment_order = None
    _assert_payment_order_applicable(resolved_code, payment_order)
    # П-16 (docs/tasks/etap-4-delta-p16.md): жёсткие нарушения схемы формы ->
    # FormValidationError (ValueError-наследник, api/ переводит в 422); пустой
    # form_data не проверяется (apps.contracts.forms докстринг "Совместимость").
    cleaned_form_data, _warnings = forms.validate_form_data(
        resolved_code, form_data or {}, deal_type=deal_type
    )
    cleaned_additional_terms = clean_additional_terms(additional_terms or [])

    contract = Contract.objects.create(
        contract_type_id=resolved_code,
        deal_type=deal_type,
        segment=segment,
        payment_method=payment_method,
        payment_order=payment_order,
        protected=_protected_for(payment_method),
        jurisdiction=jurisdiction,
        title=title,
        form_data=cleaned_form_data,
        additional_terms=cleaned_additional_terms,
        created_by=user,
    )
    ContractParty.objects.create(
        contract=contract,
        role=my_role,
        profile=my_profile,
        entity=my_entity,
        acting_as=my_acting_as,
    )
    ContractParty.objects.create(
        contract=contract,
        role=counterparty_role,
        profile=counterparty_profile,
        entity=cp_entity,
        acting_as=cp_acting_as,
    )
    outbox.publish(
        Topic.CONTRACT_DRAFTED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "contract_type_code": resolved_code,
            "segment": segment,
            "party_user_ids": _party_user_ids(contract),
        },
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def patch_draft(
    contract: Contract,
    *,
    user: User,
    client_option: str | None = None,
    contract_type_code: str | None = None,
    my_acting_as: str | None = None,
    my_entity_id: UUID | None = None,
    counterparty_profile_id: UUID | None = None,
    counterparty_handle: str | None = None,
    payment_method: str | None = None,
    payment_order: str | None = None,
    title: str | None = None,
    form_data: dict[str, Any] | None = None,
    additional_terms: list[str] | None = None,
    language: str | None = None,
) -> Contract:
    """PATCH /contracts/{id}: свободная правка черновика (tech-spec.md §8.4).
    Смена типа/сторон пересчитывает `segment`. Роли (кто customer/contractor)
    PATCH не меняет — только тип, свои/чужую стороны и прочие поля.

    `language` (Л.1, docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2) —
    опциональный явный выбор официального языка договора, ограничен quality
    ≥ reviewed (`LanguageNotEligibleError` иначе). Мастера выбора языка НЕТ —
    это точечная правка черновика поверх авторезолва во `freeze_contract`
    (`contract.language_override`, приоритет над авторезолвом при заморозке)."""
    if contract.negotiation_status != Contract.NegotiationStatus.DRAFT:
        raise DraftNotEditableError(
            f"договор {contract.id} не в статусе draft — правки только через протокол разногласий"
        )
    my_party = get_party_for_user(contract, user)
    counterparty_party = contract.parties.exclude(id=my_party.id).get()

    sides_changed = any(
        v is not None
        for v in (my_acting_as, my_entity_id, counterparty_profile_id, counterparty_handle)
    )
    type_changed = client_option is not None or contract_type_code is not None

    if my_acting_as is not None or my_entity_id is not None:
        my_profile, my_entity, my_has_business_status = _resolve_own_party(
            user=user,
            acting_as=my_acting_as or my_party.acting_as,
            entity_id=my_entity_id,
        )
        my_acting_as = my_acting_as or my_party.acting_as
    else:
        my_profile, my_entity = my_party.profile, my_party.entity
        my_acting_as = my_party.acting_as
        my_has_business_status = _party_status(my_profile)[1] if my_entity is None else False

    if counterparty_profile_id is not None or counterparty_handle is not None:
        counterparty_profile = _resolve_counterparty_profile(
            profile_id=counterparty_profile_id, handle=counterparty_handle
        )
        if counterparty_profile.id == my_profile.id:
            raise SelfDealingError("нельзя заключить договор с самим собой")
    else:
        counterparty_profile = counterparty_party.profile
    cp_entity, cp_has_business_status = _party_status(counterparty_profile)
    cp_acting_as = _ACTING_AS.BUSINESS if cp_entity is not None else _ACTING_AS.PERSON

    if my_party.role == _ROLE.CONTRACTOR:
        contractor_acting_as, contractor_has_business_status = my_acting_as, my_has_business_status
    else:
        contractor_acting_as, contractor_has_business_status = cp_acting_as, cp_has_business_status

    if type_changed or sides_changed:
        resolved_code = _resolve_contract_type_code(
            client_option=client_option,
            contract_type_code=contract_type_code or contract.contract_type_id,
            contractor_acting_as=contractor_acting_as,
            contractor_has_business_status=contractor_has_business_status,
        )
        segment = catalog_services.compute_segment(
            resolved_code,
            contractor_acting_as=contractor_acting_as,
            contractor_has_business_status=contractor_has_business_status,
        )
        contract.contract_type_id = resolved_code
        contract.segment = segment
        contract.deal_type = _compute_deal_type(my_acting_as, cp_acting_as)

    if sides_changed:
        my_party.profile = my_profile
        my_party.entity = my_entity
        my_party.acting_as = my_acting_as
        my_party.save(update_fields=["profile", "entity", "acting_as"])
        counterparty_party.profile = counterparty_profile
        counterparty_party.entity = cp_entity
        counterparty_party.acting_as = cp_acting_as
        counterparty_party.save(update_fields=["profile", "entity", "acting_as"])

    update_fields = []
    if payment_method is not None:
        contract.payment_method = payment_method
        contract.protected = _protected_for(payment_method)
        update_fields += ["payment_method", "protected"]
    # ADR-151: порядок оплаты. Явное значение для типа, где он неприменим
    # (займ), — отказ; смена типа НА займ молча снимает ранее выбранный
    # порядок (условие к новому типу не относится, snapshot его не увидит).
    _assert_payment_order_applicable(contract.contract_type_id, payment_order)
    if payment_order is not None:
        contract.payment_order = payment_order
        update_fields.append("payment_order")
    elif type_changed and contract.payment_order is not None:
        if not payment_order_applicable(contract.contract_type_id):
            contract.payment_order = None
            update_fields.append("payment_order")
    if title is not None:
        contract.title = title
        update_fields.append("title")
    if language is not None:
        if not l10n_selectors.is_reviewed_or_better(language):
            raise LanguageNotEligibleError(
                f"language={language!r}: доступны только языки с quality >= reviewed"
            )
        contract.language_override = language
        update_fields.append("language_override")
    if additional_terms is not None:
        # ADR-167: полная замена списка (мастер шлёт его целиком, как
        # form_data), а не дописывание — иначе удалить пункт из мастера
        # нечем. Правки «Другое» (ADR-123) по-прежнему ДОПИСЫВАЮТ в конец
        # (`_apply_revision_value`), и пересечься эти два пути не могут:
        # ручной PATCH живёт только на `draft`, протокол разногласий —
        # только на `under_review`.
        contract.additional_terms = clean_additional_terms(additional_terms)
        update_fields.append("additional_terms")
    if form_data is not None or type_changed:
        # Смена типа перевалидирует уже сохранённый form_data по новой схеме
        # (etap-4-delta-p16.md, тесты) — даже если этот PATCH явно form_data
        # не передавал.
        effective_form_data = form_data if form_data is not None else contract.form_data
        cleaned_form_data, _warnings = forms.validate_form_data(
            contract.contract_type_id, effective_form_data, deal_type=contract.deal_type
        )
        contract.form_data = cleaned_form_data
        update_fields.append("form_data")
    if type_changed or sides_changed:
        update_fields += ["contract_type", "segment", "deal_type"]
    if update_fields:
        contract.save(update_fields=update_fields)
        outbox.publish(
            Topic.CONTRACT_DRAFT_PATCHED,
            subject={"type": "contract", "id": str(contract.id)},
            payload={
                "contract_type_code": contract.contract_type_id,
                "segment": contract.segment,
                "party_user_ids": _party_user_ids(contract),
            },
            actor={"user_id": str(user.id)},
        )
    return contract


# --- Э4.2: FSM согласования и протокол разногласий ---------------------------


def _assert_negotiating(contract: Contract) -> None:
    """Гейт для всех действий протокола разногласий: договор должен быть на
    согласовании (§6.1 under_review->under_review). Переиспользует
    NEGOTIATION_FSM ради единообразия (CLAUDE.md: «каждый запрет — отдельным
    тестом», это и есть недопустимость перехода `revise` из чужого состояния)."""
    NEGOTIATION_FSM.assert_transition("revise", contract.negotiation_status)


def _responder_profile(proposal: RevisionProposal, user: User) -> Profile:
    """Профиль вызывающего в договоре предложения; бросает
    OwnProposalDecisionError, если вызывающий — автор предложения (решение
    принимает другая сторона, не тот, кто предложил правку)."""
    my_party = get_party_for_user(proposal.contract, user)
    if my_party.profile_id == proposal.proposed_by_id:
        raise OwnProposalDecisionError(
            f"пользователь {user.id} — автор предложения {proposal.id}, не может решать за него"
        )
    return my_party.profile


def _is_financially_significant(proposal: RevisionProposal) -> bool:
    """Эвристика «денежная правка» — формального определения в спеке нет
    (§8.4/§13.2 ссылаются на §13.2, отсутствующую в текущей нумерации
    tech-spec.md): item_ref указывает на сумму (содержит "amount") либо
    значение — Money-подобный jsonb {"amount": ..., "currency": ...}
    (common/money.py, CLAUDE.md: деньги всегда пара amount+currency)."""
    if "amount" in proposal.item_ref.lower():
        return True
    for value in (proposal.old_value, proposal.new_value):
        if isinstance(value, dict) and "amount" in value and "currency" in value:
            return True
    return False


# --- ADR-123/157: грамматика item_ref и применение принятой правки ----------
#
# Адресуемые (принятая правка ПРИМЕНЯЕТСЯ к договору в той же транзакции):
#   ADR-123: "title", "other", "form.<key>";
#   ADR-157: "payment.method", "payment.order",
#            "milestone.<uuid>.{title|amount|deadline|start_gate}",
#            "material.<uuid>.{type|quantity|delivery_days}".
# Любая другая строка — «свободная» правка прежнего образца: хранится в
# протоколе разногласий, попадает в canonical snapshot заморозки, но к
# договору автоматически НЕ применяется (обратная совместимость: старые
# предложения и `other`-подобные адреса читаются и решаются как раньше).

REVISION_ITEM_TITLE = "title"
REVISION_ITEM_OTHER = "other"
REVISION_FORM_PREFIX = "form."
# ADR-157: оплата — поля самого Contract (ADR-151/155), поэтому плоские
# адреса без идентификатора.
REVISION_PAYMENT_METHOD = "payment.method"
REVISION_PAYMENT_ORDER = "payment.order"
# ADR-157: адреса с идентификатором цели — `<сущность>.<uuid>.<поле>`.
REVISION_MILESTONE_PREFIX = "milestone."
REVISION_MATERIAL_PREFIX = "material."
# Правится ЛИСТ дерева (ветки только группируют — tech-spec.md §6.1);
# `start_gate` — «условие старта» карточки, в модели `Milestone.depends_on`
# (предшественник): расчётный гейт ADR-155 (подписан / материалы / деньги)
# сторонами не задаётся, единственная редактируемая часть условия старта —
# от какого этапа он зависит.
MILESTONE_REVISION_FIELDS = ("title", "amount", "deadline", "start_gate")
MATERIAL_REVISION_FIELDS = ("type", "quantity", "delivery_days")
# = Contract.title max_length (models.py); дублируется литералом, чтобы не
# лезть в `_meta` ради одной проверки.
_TITLE_MAX_LENGTH = 300
# = Milestone.title max_length (apps/milestones/models.py) — тем же литералом
# и по той же причине.
_MILESTONE_TITLE_MAX_LENGTH = 300


class StructuredRef(NamedTuple):
    """Разобранный структурный `item_ref` (ADR-157): что за сущность, какая
    именно (uuid) и какое её поле правим."""

    kind: str
    target: UUID
    field: str


def parse_structured_ref(item_ref: str) -> StructuredRef | None:
    """`milestone.<uuid>.<поле>` / `material.<uuid>.<поле>` -> StructuredRef;
    всё остальное (в том числе НЕИЗВЕСТНОЕ поле и битый uuid) -> None, то
    есть «свободный адрес». Именно None, а не исключение: неизвестный ref по
    ADR-157 остаётся текстовой правкой прежнего образца, иначе выкатка
    сломала бы предложения, заведённые фронтом до этой ветки."""
    for prefix, kind, fields in (
        (REVISION_MILESTONE_PREFIX, "milestone", MILESTONE_REVISION_FIELDS),
        (REVISION_MATERIAL_PREFIX, "material", MATERIAL_REVISION_FIELDS),
    ):
        if not item_ref.startswith(prefix):
            continue
        raw_id, _, field = item_ref[len(prefix) :].partition(".")
        if field not in fields:
            return None
        try:
            target = UUID(raw_id)
        except ValueError:
            return None
        return StructuredRef(kind, target, field)
    return None


def _revision_form_field(contract: Contract, item_ref: str) -> forms.FormField:
    """Поле схемы формы для `form.<key>`; бросает RevisionItemUnknownError,
    если у типа нет схемы или ключа в ней нет."""
    key = item_ref[len(REVISION_FORM_PREFIX) :]
    try:
        schema = forms.get_form_schema(contract.contract_type_id)
    except forms.FormSchemaNotFoundError as exc:
        raise RevisionItemUnknownError(
            f"у типа {contract.contract_type_id!r} нет схемы формы — {item_ref!r} неприменим"
        ) from exc
    for field in schema.fields():
        if field.key == key:
            return field
    raise RevisionItemUnknownError(
        f"поле {key!r} не входит в схему формы типа {contract.contract_type_id!r}"
    )


def is_addressable_item_ref(item_ref: str) -> bool:
    """ADR-123/157: адрес, по которому принятая правка ПРИМЕНЯЕТСЯ к договору
    (в отличие от свободной строки прежнего образца)."""
    return (
        item_ref
        in (
            REVISION_ITEM_TITLE,
            REVISION_ITEM_OTHER,
            REVISION_PAYMENT_METHOD,
            REVISION_PAYMENT_ORDER,
        )
        or item_ref.startswith(REVISION_FORM_PREFIX)
        or parse_structured_ref(item_ref) is not None
    )


def _clean_title_value(value: Any) -> str:  # noqa: ANN401
    """Значение для `item_ref="title"`: непустая строка не длиннее
    `Contract.title`. Одна проверка на вход (propose/counter/альтернатива) и
    на применение (accept) — чтобы «принято, но не применилось» не возникало."""
    if not isinstance(value, str) or not value.strip():
        raise RevisionValueInvalidError(
            [
                {
                    "field": REVISION_ITEM_TITLE,
                    "code": "required",
                    "message": "название договора не может быть пустым",
                }
            ]
        )
    title = value.strip()
    if len(title) > _TITLE_MAX_LENGTH:
        raise RevisionValueInvalidError(
            [
                {
                    "field": REVISION_ITEM_TITLE,
                    "code": "max_length",
                    "message": f"название длиннее {_TITLE_MAX_LENGTH} символов",
                }
            ]
        )
    return title


def _clean_other_value(value: Any) -> str:  # noqa: ANN401
    """Значение для `item_ref="other"`: непустой произвольный текст
    дополнительного условия."""
    if not isinstance(value, str) or not value.strip():
        raise RevisionValueInvalidError(
            [
                {
                    "field": REVISION_ITEM_OTHER,
                    "code": "required",
                    "message": "текст дополнительного условия не может быть пустым",
                }
            ]
        )
    return value.strip()


# --- ADR-157: структурные адреса (оплата / этапы / материалы) ----------------
#
# Значение правки приходит из JSON-формы фронта, поэтому у каждого адреса
# ОДНА функция «почистить значение», которую зовут и на предложении
# (`_validate_revision_target`), и на применении (`_apply_revision_value`):
# «принято, но не применилось» и «принято и упало 500 на применении» —
# одинаково недопустимы (тот же приём, что у `_clean_title_value`, ADR-123).


def _revision_error(field: str, code: str, message: str) -> RevisionValueInvalidError:
    return RevisionValueInvalidError([{"field": field, "code": code, "message": message}])


def _clean_payment_method_value(value: Any) -> str:  # noqa: ANN401
    """`payment.method` — код из `Contract.PaymentMethod`. `prepayment`
    упразднён (ADR-155), поэтому его в choices уже нет: отдельной проверки
    не нужно, справочник сам его не содержит."""
    codes = {str(c) for c in Contract.PaymentMethod.values}
    if not isinstance(value, str) or value not in codes:
        raise _revision_error(
            REVISION_PAYMENT_METHOD, "invalid_choice", f"способ расчёта {value!r} не из справочника"
        )
    return value


def _clean_payment_order_value(contract: Contract, value: Any) -> str:  # noqa: ANN401
    """`payment.order` — код из `Contract.PaymentOrder` (ADR-151), и только
    для типа договора, к которому порядок оплаты вообще применим: у займа
    лист-этап — сам денежный транш (`payment_order_applicable`)."""
    codes = {str(c) for c in Contract.PaymentOrder.values}
    if not isinstance(value, str) or value not in codes:
        raise _revision_error(
            REVISION_PAYMENT_ORDER, "invalid_choice", f"порядок оплаты {value!r} не из справочника"
        )
    if not payment_order_applicable(contract.contract_type_id):
        raise _revision_error(
            REVISION_PAYMENT_ORDER,
            "not_applicable",
            f"порядок оплаты неприменим к типу {contract.contract_type_id!r}",
        )
    return value


def _resolve_revision_milestone(contract: Contract, ref: StructuredRef) -> _Milestone:
    """Этап цели — ЧЕРЕЗ фасад apps.milestones.selectors (CLAUDE.md: чужие
    модели не импортируем). Чужой/несуществующий этап -> 422
    `revision_item_unknown`: адрес указывает в никуда, «Было» показать не из
    чего и применять нечего."""
    from apps.milestones import selectors as milestones_selectors

    milestone = milestones_selectors.find_contract_milestone(contract, ref.target)
    if milestone is None:
        raise RevisionItemUnknownError(f"этап {ref.target} не принадлежит договору {contract.id}")
    return milestone


def _resolve_revision_material(contract: Contract, ref: StructuredRef) -> _ContractMaterial:
    from apps.milestones import selectors as milestones_selectors

    material = milestones_selectors.find_contract_material(contract, ref.target)
    if material is None:
        raise RevisionItemUnknownError(
            f"материал {ref.target} не принадлежит договору {contract.id}"
        )
    return material


def _assert_leaf_target(item_ref: str, milestone: _Milestone) -> None:
    """Суммы и материалы живут только на ЛИСТЬЯХ (tech-spec.md §6.1: ветки
    группируют, листья принимаются и оплачиваются). Отказ — на предложении,
    иначе сторона согласовала бы правку, которую БД-триггер
    `milestone_amount_guard` не пропустит."""
    from apps.milestones import selectors as milestones_selectors

    if milestones_selectors.has_children(milestone):
        raise _revision_error(
            item_ref, "not_a_leaf", f"этап {milestone.id} — ветка, сумма задаётся на листьях"
        )


def _revision_currency(contract: Contract, milestone: _Milestone) -> str | None:
    """Валюта договора для проверки денежной правки: своя валюта листа,
    иначе валюта дерева (`total_leaf_amount` — единая по договору,
    `assert_single_currency`). `None` — у договора ещё нет ни одной суммы,
    сравнивать не с чем. Отложенный импорт apps.milestones — тот же разрыв
    цикла, что во `freeze_contract`."""
    from apps.milestones import services as milestones_services

    if milestone.amount_currency:
        return str(milestone.amount_currency)
    try:
        return milestones_services.total_leaf_amount(contract).currency
    except (ValueError, CurrencyMismatchError):
        return None


def _clean_milestone_amount_value(
    item_ref: str,
    contract: Contract,
    milestone: _Milestone,
    value: Any,  # noqa: ANN401
) -> Money:
    """`milestone.<uuid>.amount`. Деньги — всегда пара (CLAUDE.md), поэтому
    принимаются две формы: строка/число (валюта берётся из текущей валюты
    договора) и пара `{"amount": "...", "currency": "RUB"}` — фронт шлёт
    первую, альтернативы и API-клиенты умеют вторую. Валюта, отличная от
    валюты договора, — отказ: `assert_single_currency` не даст посчитать
    дерево, а «сумма листьев = сумма договора» перестала бы иметь смысл.

    Инвариант суммы: отдельного «объявленного итога» у договора НЕТ — сумма
    договора ВЫЧИСЛЯЕТСЯ из листьев (`total_leaf_amount`), поэтому правка
    суммы листа меняет сумму договора на ту же дельту по построению, и
    доводить дерево руками не требуется (ADR-157 §4).
    """
    currency = _revision_currency(contract, milestone)
    raw: Any = value
    if isinstance(value, dict):
        raw = value.get("amount")
        given = value.get("currency")
        if not isinstance(given, str) or not given.strip():
            raise _revision_error(item_ref, "currency_required", "у суммы должна быть валюта")
        given = given.strip().upper()
        if currency is not None and given != currency:
            raise _revision_error(
                item_ref,
                "currency_mismatch",
                f"валюта {given!r} не совпадает с валютой договора {currency!r}",
            )
        currency = given
    if currency is None:
        raise _revision_error(
            item_ref, "currency_required", "у договора ещё нет валюты — укажите её в правке"
        )
    if isinstance(raw, bool) or raw is None:
        raise _revision_error(item_ref, "invalid", f"сумма {raw!r} не число")
    try:
        amount = Decimal(str(raw).strip().replace(",", ".").replace(" ", ""))
    except (InvalidOperation, ValueError) as exc:
        raise _revision_error(item_ref, "invalid", f"сумма {raw!r} не число") from exc
    if not amount.is_finite() or amount < 0:
        raise _revision_error(item_ref, "negative", "сумма этапа не может быть отрицательной")
    return Money(amount, currency)


def _clean_milestone_deadline_value(item_ref: str, value: Any) -> datetime:  # noqa: ANN401
    """`milestone.<uuid>.deadline` — ISO 8601. Голая дата разворачивается в
    начало суток UTC тем же способом, что `materialize_loan_schedule`
    (`datetime.combine(due, time.min, tzinfo=UTC)`)."""
    if not isinstance(value, str) or not value.strip():
        raise _revision_error(item_ref, "required", "срок этапа не может быть пустым")
    text = value.strip()
    parsed = parse_datetime(text)
    if parsed is not None:
        return parsed if is_aware(parsed) else parsed.replace(tzinfo=UTC)
    parsed_date = parse_date(text)
    if parsed_date is None:
        raise _revision_error(item_ref, "invalid", f"срок {text!r} не в формате ISO 8601")
    return datetime.combine(parsed_date, time.min, tzinfo=UTC)


def _clean_start_gate_value(
    item_ref: str,
    contract: Contract,
    milestone: _Milestone,
    value: Any,  # noqa: ANN401
) -> _Milestone | None:
    """`milestone.<uuid>.start_gate` — «условие старта» карточки: от какого
    этапа договора зависит старт (`Milestone.depends_on`). Пусто (`None`,
    `""`) — условия нет. Расчётные условия гейта ADR-155 (подписан /
    материалы переданы / деньги подтверждены) сторонами не задаются: они
    ВЫВОДЯТСЯ из фактов, договориться о них правкой нельзя."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str):
        raise _revision_error(item_ref, "invalid", "условие старта — идентификатор этапа или пусто")
    try:
        target = UUID(value.strip())
    except ValueError as exc:
        raise _revision_error(
            item_ref, "invalid", f"условие старта {value!r} — не идентификатор этапа"
        ) from exc
    if target == milestone.id:
        raise _revision_error(item_ref, "self_reference", "этап не может зависеть от самого себя")
    gate = _resolve_revision_milestone(contract, StructuredRef("milestone", target, "start_gate"))
    return gate


def _clean_material_type_value(item_ref: str, value: Any) -> str:  # noqa: ANN401
    """`material.<uuid>.type` — КОД активной позиции каталога материалов
    (apps.catalog): описание позиции свободным текстом правится не здесь, а
    как обычное поле материала. Каталог — нижний слой, зовём его selectors
    напрямую (import-linter: contracts -> catalog разрешён)."""
    if not isinstance(value, str) or not value.strip():
        raise _revision_error(item_ref, "required", "тип материала не может быть пустым")
    code = value.strip()
    if not catalog_selectors.is_active_material_catalog_code(code):
        raise _revision_error(
            item_ref, "unknown_catalog_item", f"позиция каталога {code!r} не найдена"
        )
    return code


def _clean_material_quantity_value(item_ref: str, value: Any) -> Decimal:  # noqa: ANN401
    if isinstance(value, bool) or value is None:
        raise _revision_error(item_ref, "invalid", f"количество {value!r} не число")
    try:
        quantity = Decimal(str(value).strip().replace(",", ".").replace(" ", ""))
    except (InvalidOperation, ValueError) as exc:
        raise _revision_error(item_ref, "invalid", f"количество {value!r} не число") from exc
    if not quantity.is_finite() or quantity <= 0:
        raise _revision_error(item_ref, "not_positive", "количество должно быть больше нуля")
    return quantity


def _clean_material_delivery_days_value(item_ref: str, value: Any) -> int:  # noqa: ANN401
    if isinstance(value, bool) or value is None:
        raise _revision_error(item_ref, "invalid", f"срок поставки {value!r} не целое число")
    text = str(value).strip()
    if not text.lstrip("-").isdigit():
        raise _revision_error(item_ref, "invalid", f"срок поставки {value!r} не целое число")
    days = int(text)
    if days < 0:
        raise _revision_error(item_ref, "negative", "срок поставки не может быть отрицательным")
    return days


def _clean_milestone_title_value(item_ref: str, value: Any) -> str:  # noqa: ANN401
    if not isinstance(value, str) or not value.strip():
        raise _revision_error(item_ref, "required", "название этапа не может быть пустым")
    title = value.strip()
    if len(title) > _MILESTONE_TITLE_MAX_LENGTH:
        raise _revision_error(
            item_ref, "max_length", f"название длиннее {_MILESTONE_TITLE_MAX_LENGTH} символов"
        )
    return title


def _clean_structured_value(
    contract: Contract,
    ref: StructuredRef,
    item_ref: str,
    value: Any,  # noqa: ANN401
) -> Any:  # noqa: ANN401
    """Разбор значения структурной правки в доменный вид (str / Money /
    datetime / Decimal / int / Milestone|None). Один вход для проверки на
    предложении и для применения на принятии."""
    if ref.kind == "milestone":
        milestone = _resolve_revision_milestone(contract, ref)
        if ref.field == "title":
            return _clean_milestone_title_value(item_ref, value)
        if ref.field == "amount":
            _assert_leaf_target(item_ref, milestone)
            return _clean_milestone_amount_value(item_ref, contract, milestone, value)
        if ref.field == "deadline":
            return _clean_milestone_deadline_value(item_ref, value)
        return _clean_start_gate_value(item_ref, contract, milestone, value)
    _resolve_revision_material(contract, ref)
    if ref.field == "type":
        return _clean_material_type_value(item_ref, value)
    if ref.field == "quantity":
        return _clean_material_quantity_value(item_ref, value)
    return _clean_material_delivery_days_value(item_ref, value)


def _structured_current_value(contract: Contract, ref: StructuredRef) -> Any:  # noqa: ANN401
    """«Было» для структурного адреса — из тех же фасадов, что применение.
    Цель, которой уже нет (этап удалили, пока правка висела), — `None`, а не
    ошибка: показать «Было» не из чего, но и терять предложение незачем."""
    from apps.milestones import selectors as milestones_selectors

    if ref.kind == "milestone":
        milestone = milestones_selectors.find_contract_milestone(contract, ref.target)
        if milestone is None:
            return None
        if ref.field == "title":
            return milestone.title
        if ref.field == "amount":
            if milestone.amount is None or milestone.amount_currency is None:
                return None
            return {"amount": str(milestone.amount), "currency": milestone.amount_currency}
        if ref.field == "deadline":
            return milestone.deadline.isoformat() if milestone.deadline else None
        return str(milestone.depends_on_id) if milestone.depends_on_id else None
    material = milestones_selectors.find_contract_material(contract, ref.target)
    if material is None:
        return None
    if ref.field == "type":
        return material.catalog_item.code
    if ref.field == "quantity":
        return str(material.quantity)
    return material.delivery_days


def _apply_structured_value(
    contract: Contract,
    *,
    ref: StructuredRef,
    item_ref: str,
    value: Any,
    user: User,  # noqa: ANN401
) -> str:
    """Применение структурной правки — ЧЕРЕЗ фасад apps.milestones.services,
    теми же `patch_milestone`/`patch_material`, что и прямая правка стороной,
    и с тем же стражем `_assert_editable` (договор на согласовании —
    редактировать можно, ADR-155 §7). Доменные отказы фасада переводятся в
    `RevisionValueInvalidError`: снаружи это 422 с полем, а не 500."""
    from apps.milestones import services as milestones_services

    cleaned = _clean_structured_value(contract, ref, item_ref, value)
    try:
        if ref.kind == "milestone":
            milestone = _resolve_revision_milestone(contract, ref)
            if ref.field == "title":
                milestones_services.patch_milestone(milestone, user=user, title=cleaned)
            elif ref.field == "amount":
                milestones_services.patch_milestone(
                    milestone, user=user, amount=cleaned.amount, currency=cleaned.currency
                )
            elif ref.field == "deadline":
                milestones_services.patch_milestone(milestone, user=user, deadline=cleaned)
            else:
                milestones_services.patch_milestone(milestone, user=user, depends_on=cleaned)
        else:
            material = _resolve_revision_material(contract, ref)
            if ref.field == "type":
                milestones_services.patch_material(material, user=user, catalog_item_code=cleaned)
            elif ref.field == "quantity":
                milestones_services.patch_material(material, user=user, quantity=cleaned)
            else:
                milestones_services.patch_material(material, user=user, delivery_days=cleaned)
    except (
        milestones_services.StructureNotEditableError,
        milestones_services.MilestoneAmountGuardError,
        milestones_services.MilestoneDependsOnInvalidError,
        milestones_services.CurrencyNotActiveError,
        milestones_services.MaterialPriceRequiredError,
        milestones_services.MaterialCatalogItemNotFoundError,
    ) as exc:
        raise _revision_error(item_ref, "not_applicable", str(exc)) from exc
    return item_ref


def _validate_revision_target(
    contract: Contract,
    *,
    item_ref: str,
    new_value: Any,  # noqa: ANN401
) -> None:
    """Проверки на входе (propose/counter/создание альтернативы): адрес
    существует в схеме формы, `other`/`title` — непустой текст, оплата — код
    из справочника, этап/материал — цель ЭТОГО договора и значение по
    грамматике поля (ADR-157). Свободный адрес не проверяется — он и не
    применяется."""
    if item_ref.startswith(REVISION_FORM_PREFIX):
        _revision_form_field(contract, item_ref)
    elif item_ref == REVISION_ITEM_OTHER:
        _clean_other_value(new_value)
    elif item_ref == REVISION_ITEM_TITLE:
        _clean_title_value(new_value)
    elif item_ref == REVISION_PAYMENT_METHOD:
        _clean_payment_method_value(new_value)
    elif item_ref == REVISION_PAYMENT_ORDER:
        _clean_payment_order_value(contract, new_value)
    else:
        ref = parse_structured_ref(item_ref)
        if ref is not None:
            _clean_structured_value(contract, ref, item_ref, new_value)


def _revision_current_value(contract: Contract, item_ref: str) -> Any:  # noqa: ANN401
    """«Было» из текущего состояния договора: `title` -> заголовок,
    `form.<key>` -> form_data[key] (None, если не заполнено), `payment.*` ->
    поля Contract (ADR-151/155), `milestone.*`/`material.*` -> фасады
    apps.milestones (ADR-157), иначе None (`other` и свободные адреса —
    сравнивать не с чем)."""
    if item_ref == REVISION_ITEM_TITLE:
        return contract.title
    if item_ref.startswith(REVISION_FORM_PREFIX):
        return contract.form_data.get(item_ref[len(REVISION_FORM_PREFIX) :])
    if item_ref == REVISION_PAYMENT_METHOD:
        return contract.payment_method
    if item_ref == REVISION_PAYMENT_ORDER:
        return contract.payment_order
    ref = parse_structured_ref(item_ref)
    if ref is not None:
        return _structured_current_value(contract, ref)
    return None


def _coerce_revision_value(field: forms.FormField, value: Any) -> Any:  # noqa: ANN401
    """Мягкое приведение значения правки к типу поля ДО строгой схемы
    (`forms.validate_form_data` требует точных типов: integer -> int,
    boolean -> bool, decimal -> строка). Значение приходит из JSON формы
    правки, где «Стало» для числа/флага может быть строкой. Непонятное
    значение возвращается как есть — схема отвергнет его своим кодом."""
    t = field.field_type
    if value is None:
        return None
    if t == "integer":
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value.strip())
        return value
    if t == "decimal":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float, Decimal)):
            return str(value)
        if isinstance(value, str):
            return value.strip().replace(",", ".").replace(" ", "")
        return value
    if t == "boolean":
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in ("true", "1", "yes", "да"):
                return True
            if lowered in ("false", "0", "no", "нет"):
                return False
        return value
    if t in ("string", "text", "choice", "date") and isinstance(value, str):
        return value.strip()
    return value


def _apply_revision_value(  # noqa: ANN401
    contract: Contract, *, item_ref: str, value: Any, user: User
) -> str | None:
    """Применяет значение к договору по грамматике `item_ref` внутри текущей
    транзакции; возвращает применённый ключ (`title`, `other`, `<form key>`,
    `payment.method`, `milestone.<uuid>.amount`, …) либо None для свободного
    адреса (ничего не применено). Ошибки схемы -> RevisionValueInvalidError,
    вызывающий откатывает транзакцию целиком — предложение остаётся `open`.

    `user` — тот, кто ПРИНИМАЕТ правку (ADR-157): правка этапа/материала
    идёт через `apps.milestones.services.patch_*`, а те проверяют, что
    вызывающий — сторона договора, и пишут своё событие с этим актором. Без
    него применение шло бы мимо фасада, прямой записью в чужую модель."""
    if item_ref == REVISION_ITEM_TITLE:
        contract.title = _clean_title_value(value)
        contract.save(update_fields=["title"])
        return REVISION_ITEM_TITLE
    if item_ref == REVISION_ITEM_OTHER:
        contract.additional_terms = [*contract.additional_terms, _clean_other_value(value)]
        contract.save(update_fields=["additional_terms"])
        return REVISION_ITEM_OTHER
    if item_ref.startswith(REVISION_FORM_PREFIX):
        field = _revision_form_field(contract, item_ref)
        merged = dict(contract.form_data)
        coerced = _coerce_revision_value(field, value)
        if coerced is None:
            merged.pop(field.key, None)
        else:
            merged[field.key] = coerced
        try:
            cleaned, _warnings = forms.validate_form_data(
                contract.contract_type_id, merged, deal_type=contract.deal_type
            )
        except forms.FormValidationError as exc:
            raise RevisionValueInvalidError(exc.errors) from exc
        contract.form_data = cleaned
        contract.save(update_fields=["form_data"])
        return field.key
    if item_ref == REVISION_PAYMENT_METHOD:
        contract.payment_method = _clean_payment_method_value(value)
        # `protected` — производная способа расчёта (§14 п.15), считается тем
        # же `_protected_for`, что в create_draft/patch_draft: разойдись они —
        # карточка обещала бы защиту, которой нет.
        contract.protected = _protected_for(contract.payment_method)
        contract.save(update_fields=["payment_method", "protected"])
        return REVISION_PAYMENT_METHOD
    if item_ref == REVISION_PAYMENT_ORDER:
        contract.payment_order = _clean_payment_order_value(contract, value)
        contract.save(update_fields=["payment_order"])
        return REVISION_PAYMENT_ORDER
    ref = parse_structured_ref(item_ref)
    if ref is not None:
        return _apply_structured_value(contract, ref=ref, item_ref=item_ref, value=value, user=user)
    return None


def _revisions_snapshot(contract: Contract) -> list[dict[str, Any]]:
    """Протокол разногласий целиком (все статусы, в порядке создания) — часть
    canonical snapshot заморозки (ADR-123): замороженная версия несёт
    историю согласования, а не только итоговые значения."""
    return [
        {
            "id": str(p.id),
            "item_ref": p.item_ref,
            "old_value": p.old_value,
            "new_value": p.new_value,
            "comment": p.comment,
            "status": p.status,
            "proposed_by_profile_id": str(p.proposed_by_id),
            "decided_by_profile_id": str(p.decided_by_id) if p.decided_by_id else None,
            "decided_at": p.decided_at,
            "created_at": p.created_at,
        }
        for p in contract.revision_proposals.order_by("created_at", "id")
    ]


@transaction.atomic
def delete_draft(contract: Contract, *, user: User) -> None:
    """DELETE /contracts/{id}: удаление черновика ЛЮБОЙ из сторон, пока
    `negotiation_status=draft` (отсмотр 2026-08-21: черновики висели в списке
    без возможности убрать). После отправки контрагенту — 409
    `draft_not_editable`: договор уже виден второй стороне, дальше только
    отзыв/отклонение по FSM согласования (Э4.2).

    Мягкого удаления нет: до заморозки договор не юрзначим — ни версии
    (`ContractVersion`, FK PROTECT — страховка от удаления не-черновика), ни
    подписи, ни платежи. Стороны, этапы, документы, доказательства уходят
    каскадом по FK. Событие `contract.draft_deleted` — для ленты/поиска
    (ADR-102: мета резолвится при чтении, пункт про удалённый договор
    не должен вести в 404)."""
    if contract.negotiation_status != Contract.NegotiationStatus.DRAFT:
        raise DraftNotEditableError(
            f"договор {contract.id} не в статусе draft — удалить можно только черновик"
        )
    get_party_for_user(contract, user)
    contract_id = str(contract.id)
    contract_type_code = contract.contract_type_id
    contract.delete()
    outbox.publish(
        Topic.CONTRACT_DRAFT_DELETED,
        subject={"type": "contract", "id": contract_id},
        payload={"contract_type_code": contract_type_code},
        actor={"user_id": str(user.id)},
    )


@transaction.atomic
def send_for_review(contract: Contract, *, user: User) -> Contract:
    """POST /contracts/{id}/send (tech-spec.md §8.4, §6.1): draft ->
    under_review. «Любая сторона» — ограничение по Representative/COMMUNICATE
    отложено до apps.authority (этап 3.5, ещё не начат, как и в patch_draft);
    пока сторона договора вправе отправить его контрагенту."""
    get_party_for_user(contract, user)
    NEGOTIATION_FSM.assert_transition("send", contract.negotiation_status)
    if contract.payment_method is None:
        raise PaymentMethodRequiredError(f"договор {contract.id} отправляется без способа расчёта")
    # ADR-151: порядок оплаты обязателен там, где применим (все клиентские
    # опции, кроме займа).
    if contract.payment_order is None and payment_order_applicable(contract.contract_type_id):
        raise PaymentOrderRequiredError(f"договор {contract.id} отправляется без порядка оплаты")
    contract.negotiation_status = _NEGOTIATION.UNDER_REVIEW
    contract.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.NEGOTIATION_SENT,
        subject={"type": "contract", "id": str(contract.id)},
        payload={},
        actor={"user_id": str(user.id)},
    )
    return contract


def _annul_signing_round(contract: Contract) -> dict[str, list[str]]:
    """Выход из заморозки (ADR-006, ADR-124): ВСЕ активные запросы подписи
    раунда договора помечаются `declined_for_revision`, подписи раунда
    удаляются, `contract.frozen_version` снимается (новая заморозка создаст
    новую версию или переиспользует эту же — см. `freeze_contract`).
    `ContractVersion` НЕ удаляется — append-only история снимков.

    Не сохраняет `contract` — вызывающий делает `save(update_fields=[...,
    "frozen_version"])` вместе со сменой статуса в одной транзакции.
    Возвращает id аннулированных объектов для payload события (лента
    договора показывает, что именно было отменено)."""
    pending_requests = contract.signature_requests.filter(
        status=_SIG_STATUS.PENDING, amendment__isnull=True
    )
    round_signatures = contract.signatures.filter(amendment__isnull=True)
    annulled_request_ids = [str(i) for i in pending_requests.values_list("id", flat=True)]
    annulled_signature_ids = [str(i) for i in round_signatures.values_list("id", flat=True)]
    pending_requests.update(status=_SIG_STATUS.DECLINED_FOR_REVISION)
    round_signatures.delete()
    contract.frozen_version = None
    return {
        "annulled_signature_request_ids": annulled_request_ids,
        "annulled_signature_ids": annulled_signature_ids,
    }


@transaction.atomic
def withdraw_negotiation(contract: Contract, *, user: User) -> Contract:
    """POST /contracts/{id}/withdraw (§6.1, ADR-124): under_review /
    pending_signature / awaiting_signatures -> withdrawn_by_initiator,
    терминально, только инициатор (Contract.created_by). Из заморозки —
    с аннулированием раунда подписания (`_annul_signing_round`)."""
    get_party_for_user(contract, user)
    if contract.created_by_id != user.id:
        raise NotInitiatorError(f"пользователь {user.id} не инициатор договора {contract.id}")
    transition = NEGOTIATION_FSM.assert_transition("withdraw", contract.negotiation_status)
    annulled = _annul_signing_round(contract)
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.NEGOTIATION_WITHDRAWN,
        subject={"type": "contract", "id": str(contract.id)},
        payload=annulled,
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def reject_negotiation(contract: Contract, *, user: User) -> Contract:
    """POST /contracts/{id}/reject (§6.1, ADR-124): under_review /
    pending_signature / awaiting_signatures -> rejected_by_counterparty,
    терминально, только «вторая сторона» (не инициатор — Contract.created_by).
    Из заморозки — с аннулированием раунда подписания."""
    get_party_for_user(contract, user)
    if contract.created_by_id == user.id:
        raise NotCounterpartyError(
            f"пользователь {user.id} инициатор договора {contract.id} — "
            "reject только для контрагента"
        )
    transition = NEGOTIATION_FSM.assert_transition("reject", contract.negotiation_status)
    annulled = _annul_signing_round(contract)
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.NEGOTIATION_REJECTED,
        subject={"type": "contract", "id": str(contract.id)},
        payload=annulled,
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def return_for_revision(contract: Contract, *, user: User, comment: str) -> Contract:
    """POST /contracts/{id}/return-for-revision (ADR-124): pending_signature /
    awaiting_signatures -> under_review ЛЮБОЙ стороной договора — в отличие
    от `decline_for_revision`, не требует адресованного пользователю
    pending-запроса подписи (в UI шага «заявка на подпись» больше нет).
    Аннулирование раунда — то же (`_annul_signing_round`), событие —
    `negotiation.reopened` с `reason=returned_for_revision`."""
    get_party_for_user(contract, user)
    transition = NEGOTIATION_FSM.assert_transition(
        "return_for_revision", contract.negotiation_status
    )
    annulled = _annul_signing_round(contract)
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.NEGOTIATION_REOPENED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"reason": "returned_for_revision", "comment": comment, **annulled},
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def propose_revision(
    contract: Contract,
    *,
    user: User,
    item_ref: str,
    new_value: Any,
    comment: str = "",
    old_value: Any = None,
) -> RevisionProposal:
    """GET/POST /contracts/{id}/revisions (§8.4): новое предложение правки.

    ADR-123: `item_ref` ∈ {`form.<key>`, `title`, `other`} — адресуемые
    правки: для `form.<key>` ключ проверяется по схеме формы типа договора
    (`RevisionItemUnknownError`), «Было» (`old_value`) при отсутствии
    подставляется из текущего договора; `other` — новое дополнительное
    условие (`old_value` всегда None, `new_value` — непустой текст). Прочие
    строки — свободные адреса прежнего образца (хранятся, не применяются)."""
    my_party = get_party_for_user(contract, user)
    _assert_negotiating(contract)
    _validate_revision_target(contract, item_ref=item_ref, new_value=new_value)
    if item_ref == REVISION_ITEM_OTHER:
        old_value = None
    elif old_value is None:
        old_value = _revision_current_value(contract, item_ref)
    proposal = RevisionProposal.objects.create(
        contract=contract,
        item_ref=item_ref,
        old_value=old_value,
        new_value=new_value,
        comment=comment,
        proposed_by=my_party.profile,
    )
    outbox.publish(
        Topic.NEGOTIATION_REVISED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "action": "proposed",
            "revision_proposal_id": str(proposal.id),
            "item_ref": item_ref,
            "old_value": old_value,
            "new_value": new_value,
        },
        actor={"user_id": str(user.id)},
    )
    return proposal


@transaction.atomic
def accept_revision(proposal: RevisionProposal, *, user: User) -> RevisionProposal:
    """POST /revisions/{rid}/accept (§8.4). ADR-123: принятие ПРИМЕНЯЕТ
    правку к договору в той же транзакции (`_apply_revision_value`) — только
    пока договор на согласовании (`_assert_negotiating`); значение, не
    прошедшее схему, откатывает всё, предложение остаётся `open`."""
    contract = proposal.contract
    my_profile = _responder_profile(proposal, user)
    _assert_negotiating(contract)
    if proposal.status != _REVISION_STATUS.OPEN:
        raise RevisionProposalNotOpenError(f"предложение {proposal.id} уже не open")
    applied_key = _apply_revision_value(
        contract, item_ref=proposal.item_ref, value=proposal.new_value, user=user
    )
    proposal.status = _REVISION_STATUS.ACCEPTED
    proposal.decided_by = my_profile
    proposal.decided_at = timezone.now()
    proposal.save(update_fields=["status", "decided_by", "decided_at"])
    outbox.publish(
        Topic.NEGOTIATION_REVISED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "action": "accepted",
            "revision_proposal_id": str(proposal.id),
            "item_ref": proposal.item_ref,
            "applied": applied_key is not None,
            "field": applied_key,
        },
        actor={"user_id": str(user.id)},
    )
    return proposal


@transaction.atomic
def reject_revision(proposal: RevisionProposal, *, user: User) -> RevisionProposal:
    """POST /revisions/{rid}/reject (§8.4)."""
    contract = proposal.contract
    my_profile = _responder_profile(proposal, user)
    _assert_negotiating(contract)
    if proposal.status != _REVISION_STATUS.OPEN:
        raise RevisionProposalNotOpenError(f"предложение {proposal.id} уже не open")
    proposal.status = _REVISION_STATUS.REJECTED
    proposal.decided_by = my_profile
    proposal.decided_at = timezone.now()
    proposal.save(update_fields=["status", "decided_by", "decided_at"])
    outbox.publish(
        Topic.NEGOTIATION_REVISED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "action": "rejected",
            "revision_proposal_id": str(proposal.id),
            "item_ref": proposal.item_ref,
        },
        actor={"user_id": str(user.id)},
    )
    return proposal


@transaction.atomic
def counter_revision(
    proposal: RevisionProposal, *, user: User, new_value: Any, comment: str = ""
) -> RevisionProposal:
    """POST /revisions/{rid}/counter (§8.4): встречная редакция — исходное
    предложение помечается superseded, создаётся новое open-предложение с
    `old_value` = `new_value` заменяемого (см. RevisionProposal docstring —
    так цепочка правок остаётся согласованной без обращения к состоянию
    договора)."""
    contract = proposal.contract
    my_profile = _responder_profile(proposal, user)
    _assert_negotiating(contract)
    if proposal.status != _REVISION_STATUS.OPEN:
        raise RevisionProposalNotOpenError(f"предложение {proposal.id} уже не open")
    _validate_revision_target(contract, item_ref=proposal.item_ref, new_value=new_value)
    proposal.status = _REVISION_STATUS.SUPERSEDED
    proposal.decided_by = my_profile
    proposal.decided_at = timezone.now()
    proposal.save(update_fields=["status", "decided_by", "decided_at"])
    counter = RevisionProposal.objects.create(
        contract=contract,
        item_ref=proposal.item_ref,
        old_value=proposal.new_value,
        new_value=new_value,
        comment=comment,
        proposed_by=my_profile,
    )
    outbox.publish(
        Topic.NEGOTIATION_REVISED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "action": "countered",
            "superseded_revision_proposal_id": str(proposal.id),
            "revision_proposal_id": str(counter.id),
            "item_ref": proposal.item_ref,
            "old_value": proposal.new_value,
            "new_value": new_value,
        },
        actor={"user_id": str(user.id)},
    )
    return counter


@transaction.atomic
def accept_all_revisions(
    contract: Contract, *, user: User, confirm_summary: bool = False
) -> list[RevisionProposal]:
    """POST /contracts/{id}/revisions/accept-all (§8.4): принимает все
    открытые предложения ДРУГОЙ стороны (свои предложения принять нельзя —
    как и в accept_revision). При наличии среди них финансово значимых
    требует `confirm_summary=True`, иначе бросает ConfirmSummaryRequiredError
    со списком «было -> стало» ничего не применяя."""
    my_party = get_party_for_user(contract, user)
    _assert_negotiating(contract)
    open_proposals = list(
        contract.revision_proposals.filter(status=_REVISION_STATUS.OPEN).exclude(
            proposed_by_id=my_party.profile_id
        )
    )
    summary = [
        {"item_ref": p.item_ref, "old_value": p.old_value, "new_value": p.new_value}
        for p in open_proposals
    ]
    if not confirm_summary and any(_is_financially_significant(p) for p in open_proposals):
        raise ConfirmSummaryRequiredError(
            "финансово значимые правки требуют confirm_summary=true", summary=summary
        )
    now = timezone.now()
    # ADR-123: применяем по порядку создания в одной транзакции — одно
    # непроходящее схему значение откатывает весь accept-all (422
    # revision_value_invalid), все предложения остаются open.
    applied_keys: dict[UUID, str | None] = {}
    for proposal in sorted(open_proposals, key=lambda p: (p.created_at, p.id)):
        applied_keys[proposal.id] = _apply_revision_value(
            contract, item_ref=proposal.item_ref, value=proposal.new_value, user=user
        )
    for proposal in open_proposals:
        proposal.status = _REVISION_STATUS.ACCEPTED
        proposal.decided_by = my_party.profile
        proposal.decided_at = now
    RevisionProposal.objects.bulk_update(open_proposals, ["status", "decided_by", "decided_at"])
    for proposal in open_proposals:
        outbox.publish(
            Topic.NEGOTIATION_REVISED,
            subject={"type": "contract", "id": str(contract.id)},
            payload={
                "action": "accepted",
                "revision_proposal_id": str(proposal.id),
                "item_ref": proposal.item_ref,
                "via": "accept_all",
                "applied": applied_keys[proposal.id] is not None,
                "field": applied_keys[proposal.id],
            },
            actor={"user_id": str(user.id)},
        )
    return open_proposals


_NO_ALTERNATIVE_VALUE = object()
"""Сентинел: в payload альтернативы нет значения для её `item_ref` — отличаем
от честного `null` (который для `form.<key>` означает «очистить поле»)."""


def _alternative_value(item_ref: str, payload: dict[str, Any]) -> Any:  # noqa: ANN401
    """Значение для применения из payload заранее одобренной альтернативы
    (см. apply_preapproved_alternative): `payload["value"]`, иначе «листовой»
    ключ по грамматике адреса (`title`, `text` для other, `<key>` для
    `form.<key>`). Нет ни того, ни другого -> `_NO_ALTERNATIVE_VALUE`:
    для свободного адреса это норма (применять нечего), для адресуемого —
    отвергается на создании альтернативы."""
    if "value" in payload:
        return payload["value"]
    if item_ref == REVISION_ITEM_TITLE:
        return payload.get(REVISION_ITEM_TITLE, _NO_ALTERNATIVE_VALUE)
    if item_ref == REVISION_ITEM_OTHER:
        return payload.get("text", _NO_ALTERNATIVE_VALUE)
    if item_ref.startswith(REVISION_FORM_PREFIX):
        return payload.get(item_ref[len(REVISION_FORM_PREFIX) :], _NO_ALTERNATIVE_VALUE)
    # ADR-157: у структурных адресов «листовой» ключ — имя поля
    # (`{"method": "cash"}`, `{"amount": "1000"}`, `{"delivery_days": 3}`).
    if item_ref == REVISION_PAYMENT_METHOD:
        return payload.get("method", _NO_ALTERNATIVE_VALUE)
    if item_ref == REVISION_PAYMENT_ORDER:
        return payload.get("order", _NO_ALTERNATIVE_VALUE)
    ref = parse_structured_ref(item_ref)
    if ref is not None:
        return payload.get(ref.field, _NO_ALTERNATIVE_VALUE)
    return _NO_ALTERNATIVE_VALUE


@transaction.atomic
def create_preapproved_alternative(
    contract: Contract, *, user: User, item_ref: str, payload: dict[str, Any]
) -> PreapprovedAlternative:
    """GET/POST /contracts/{id}/preapproved-alternatives (§8.4, Bonterms-
    паттерн): заранее одобренная альтернатива значения пункта, доступна для
    применения любой стороной без запуска новой итерации протокола.

    ADR-123: для адресуемого `item_ref` (`form.<key>`/`title`/`other`) адрес
    и значение проверяются здесь же — применение альтернативы меняет договор,
    и «одобрить заранее то, что не применится» нельзя. Значение берётся из
    `payload["value"]`, иначе из «листового» ключа (`title`, `text`, `<key>`);
    его отсутствие -> `422 revision_value_invalid`."""
    my_party = get_party_for_user(contract, user)
    if is_addressable_item_ref(item_ref):
        value = _alternative_value(item_ref, payload)
        if value is _NO_ALTERNATIVE_VALUE:
            raise RevisionValueInvalidError(
                [
                    {
                        "field": item_ref,
                        "code": "required",
                        "message": "в payload нет значения для этого пункта",
                    }
                ]
            )
        _validate_revision_target(contract, item_ref=item_ref, new_value=value)
    return PreapprovedAlternative.objects.create(
        contract=contract, item_ref=item_ref, payload=payload, created_by=my_party.profile
    )


@transaction.atomic
def apply_preapproved_alternative(
    alternative: PreapprovedAlternative, *, user: User
) -> RevisionProposal:
    """POST /preapproved-alternatives/{id}/apply (§8.4): принятие одним
    кликом БЕЗ новой итерации протокола — сразу создаёт RevisionProposal в
    статусе accepted (см. RevisionProposal.preapproved_alternative_of
    docstring). Открытое предложение по тому же item_ref, если есть,
    помечается superseded — применение альтернативы закрывает текущий раунд
    по этому пункту."""
    contract = alternative.contract
    my_party = get_party_for_user(contract, user)
    _assert_negotiating(contract)
    now = timezone.now()
    superseded = list(
        contract.revision_proposals.filter(
            status=_REVISION_STATUS.OPEN, item_ref=alternative.item_ref
        )
    )
    for proposal in superseded:
        proposal.status = _REVISION_STATUS.SUPERSEDED
        proposal.decided_by = my_party.profile
        proposal.decided_at = now
    RevisionProposal.objects.bulk_update(superseded, ["status", "decided_by", "decided_at"])
    # ADR-123: «Было» — значение вытесненного предложения, иначе текущее
    # состояние договора (для адресуемого адреса), иначе None.
    old_value = (
        superseded[-1].new_value
        if superseded
        else _revision_current_value(contract, alternative.item_ref)
    )
    # ADR-123: альтернатива по адресуемому item_ref применяется так же, как
    # принятая правка. Значение отсутствует только у альтернатив, заведённых
    # до ADR-123 (create_preapproved_alternative теперь его требует) — такие
    # не применяются, а не затирают поле.
    value = _alternative_value(alternative.item_ref, alternative.payload)
    applied_key = (
        None
        if value is _NO_ALTERNATIVE_VALUE
        else _apply_revision_value(contract, item_ref=alternative.item_ref, value=value, user=user)
    )
    applied = RevisionProposal.objects.create(
        contract=contract,
        item_ref=alternative.item_ref,
        old_value=old_value,
        new_value=alternative.payload,
        proposed_by=my_party.profile,
        status=_REVISION_STATUS.ACCEPTED,
        decided_by=my_party.profile,
        decided_at=now,
        preapproved_alternative_of=alternative,
    )
    outbox.publish(
        Topic.NEGOTIATION_REVISED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "action": "preapproved_applied",
            "revision_proposal_id": str(applied.id),
            "preapproved_alternative_id": str(alternative.id),
            "item_ref": alternative.item_ref,
            "new_value": alternative.payload,
            "applied": applied_key is not None,
            "field": applied_key,
        },
        actor={"user_id": str(user.id)},
    )
    return applied


# --- Э4.4: заморозка и подписание --------------------------------------------


def _json_safe(value: Any) -> Any:  # noqa: ANN401
    """Приводит значения к JSON-совместимому виду ДЕТЕРМИНИРОВАННО (сортировка
    ключей dict) — вход в `common.canonical.canonical_json_bytes` для
    ContractVersion.integrity_hash (тест «одинаковый договор -> одинаковый
    hash», etap-4.md Э4.4)."""
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def _party_snapshot(party: ContractParty) -> dict[str, Any]:
    """Слепок стороны БЕЗ расшифрованных ПД/реквизитов (CLAUDE.md:
    crypto-shredding, envelope-шифрование с первой миграции) — только факт их
    наличия, не значение."""
    has_requisites = False
    if party.acting_as == _ACTING_AS.BUSINESS and party.entity is not None:
        has_requisites = bool(party.entity.bank_details_encrypted)
    return {
        "role": party.role,
        "acting_as": party.acting_as,
        "profile_id": str(party.profile_id),
        "entity_id": str(party.entity_id) if party.entity_id else None,
        "has_payout_requisites": has_requisites,
    }


def _build_snapshot(
    contract: Contract, *, segment: str, total: Money, parties: dict[str, ContractParty]
) -> dict[str, Any]:
    # Разрыв цикла импорта: apps.milestones уже импортирует apps.contracts
    # на уровне модуля (services.py, models.py) — обратный импорт здесь
    # ДОЛЖЕН быть отложенным (см. docstring freeze_contract).
    from apps.milestones import selectors as milestones_selectors

    document: dict[str, Any] = _json_safe(
        {
            "contract_id": str(contract.id),
            "contract_type_code": contract.contract_type_id,
            "deal_type": contract.deal_type,
            "segment": segment,
            "payment_method": contract.payment_method,
            # ADR-151: порядок оплаты — условие договора под integrity_hash
            # (`null` у займа и у договоров, замороженных до раскатки).
            "payment_order": contract.payment_order,
            "uses_platform_template": contract.uses_platform_template,
            "jurisdiction": contract.jurisdiction,
            "title": contract.title,
            "form_data": contract.form_data,
            # ADR-123: дополнительные условия (правки «Другое») — часть текста
            # договора под integrity_hash; `revisions` — протокол разногласий
            # целиком (все статусы) как история согласования этой версии.
            "additional_terms": list(contract.additional_terms),
            "revisions": _revisions_snapshot(contract),
            "total_amount": {"amount": str(total.amount), "currency": total.currency},
            "milestones": milestones_selectors.build_tree(contract),
            "parties": {role: _party_snapshot(p) for role, p in parties.items()},
        }
    )
    return document


def _party_locales(parties: dict[str, ContractParty]) -> set[str]:
    """Л.1 (docs/tasks/l10n-wave.md) — языки текущих сторон НА МОМЕНТ
    заморозки (`get_user_locale`, ГВ.5), для каждой стороны, у которой вообще
    есть резолвящийся пользователь (`selectors.party_user` — тот же
    терпимый резолвер, что уведомления/релей: для business без
    `claimed_by` пользователя ещё нет, сторона просто не даёт языка —
    не блокирует заморозку)."""
    locales: set[str] = set()
    for party in parties.values():
        user = party_user(party)
        if user is not None:
            locales.add(get_user_locale(user))
    return locales


def _shared_party_locale(parties: dict[str, ContractParty]) -> str | None:
    """Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2) — язык,
    который РЕАЛЬНО общий у ОБЕИХ сторон (не "какой-то из встреченных", как
    `_party_locales` — там множество для рендеров, здесь строгое равенство
    для авторезолва официального языка). `None`, если хоть одна сторона не
    резолвится в пользователя (business без `claimed_by`, tolerant-резолвер
    `party_user`) или locale сторон не совпадает — вызывающая сторона тогда
    падает на фолбэк по jurisdiction, как раньше."""
    customer = parties.get(_ROLE.CUSTOMER)
    contractor = parties.get(_ROLE.CONTRACTOR)
    customer_user = party_user(customer) if customer is not None else None
    contractor_user = party_user(contractor) if contractor is not None else None
    if customer_user is None or contractor_user is None:
        return None
    customer_locale = get_user_locale(customer_user)
    contractor_locale = get_user_locale(contractor_user)
    if customer_locale != contractor_locale:
        return None
    return customer_locale


def _resolve_official_language(contract: Contract, parties: dict[str, ContractParty]) -> str:
    """Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2, финал) —
    официальный/канонический язык договора при заморозке:

    1. Явный выбор через PATCH черновика (`contract.language_override`,
       уже провалидирован `quality >= reviewed` в `patch_draft`) — старше
       всего, стороны сами договорились.
    2. Иначе — если язык интерфейса ОБЕИХ сторон совпадает и это
       `quality >= reviewed` (`_shared_party_locale` +
       `l10n_selectors.is_reviewed_or_better`) — он.
    3. Иначе — фолбэк по jurisdiction, как в Э4.4/до этой ветки: RU-контур
       -> "ru", GLOBAL-дефолт -> "en" (`resolve_locale`).

    Мастера выбора языка в UI НЕТ (явно снято уточнением) — это
    автоматический резолвер плюс точечный override."""
    if contract.language_override:
        return contract.language_override
    shared_locale = _shared_party_locale(parties)
    if shared_locale is not None and l10n_selectors.is_reviewed_or_better(shared_locale):
        return shared_locale
    return resolve_locale(contract.jurisdiction)


def _build_render(snapshot: dict[str, Any], *, language: str) -> dict[str, Any]:
    """Л.1 — «тонкий» рендер этой волны (ADR-077): та же canonical-структура,
    что и `snapshot`, с тегом `language`, хешированная ОТДЕЛЬНО от
    `integrity_hash` (общий рецепт `common.canonical`, другой вход — тег
    внутри документа меняет ЕГО СОБСТВЕННЫЙ хеш, не хеш `snapshot`). Реальная
    ClauseTemplate-композиция текста по блокам — вне этой волны (ADR-075:
    «предмет будущего контракт-трека»); до тех пор канон и локализованный
    рендер честно содержательно совпадают — это не выдаётся за перевод."""
    document = _json_safe({**snapshot, "language": language})
    return {
        "language": language,
        "hash": sha256_hex(canonical_json_bytes(document)),
        "document": document,
    }


def _contract_total(contract: Contract) -> Money | None:
    """Сумма договора = сумма листьев (tech-spec.md §6.1); `None` — дерева
    ещё нет (до заморозки). Тонкая обёртка над публичным фасадом
    `selectors.contract_total_money` — тот же расчёт понадобился снаружи
    (бэкфилл репутации, ADR-163 §7), и второй его копии быть не должно."""
    return contract_total_money(contract)


def list_signatories(
    contract: Contract, *, side: str, amount: Money | None = None
) -> list[dict[str, Any]]:
    """GET /contracts/{id}/signatories?side=... (tech-spec.md §8.4):
    подписанты, отфильтрованные по лимиту суммы. Person-сторона —
    единственный подписант её собственный `user` (лимитов нет); business —
    действующие SigningAuthority юрлица стороны (ADR-096: `is_valid_now` с
    перепроверкой МЧД + `can_sign_amount` по сумме договора; по одному,
    сильнейшему, основанию на пользователя). `amount` — переопределение
    суммы для допника (итог С УЧЁТОМ дельты, `route_amendment_signatory`);
    `authority_id` в элементах — внутренний ключ для фиксации права в
    `SignatureRequest.signing_authority_id` (наружу SignatoryOptionSerializer
    его не отдаёт)."""
    party = contract.parties.select_related("profile__owner_user").get(role=side)
    if party.acting_as == _ACTING_AS.BUSINESS:
        if party.entity_id is None:
            return []
        limit = amount if amount is not None else _contract_total(contract)
        return [
            {"user_id": a.user_id, "basis": a.basis, "authority_id": a.id}
            for a in authority_services.eligible_signatories(party.entity_id, amount=limit)
        ]
    if party.profile.owner_user is None:
        return []
    return [{"user_id": party.profile.owner_user.id, "basis": "person"}]


@transaction.atomic
def freeze_contract(
    contract: Contract,
    *,
    user: User,
    timestamp_provider: TimestampProvider = DEFAULT_TIMESTAMP_PROVIDER,
) -> ContractVersion:
    """POST /contracts/{id}/freeze (tech-spec.md §8.4, §6.1: under_review ->
    pending_signature). Порядок строго по спеке: нет открытых ревизий ->
    пересчёт `segment` -> валидация дерева этапов -> реквизиты -> canonical
    snapshot + sha256 + TimestampProvider -> ContractVersion.

    «Сумма листьев = сумма договора» (tech-spec.md §6.1): схема НЕ хранит
    отдельного «объявленного» итога договора вне дерева этапов — сумма
    листьев (`apps.milestones.services.total_leaf_amount`, написан
    специально «для Э4.4», см. его docstring) И ЕСТЬ сумма договора.
    Валидация здесь — что дерево вообще посчитано (не пусто, единая
    валюта — сами эти инварианты уже проверены property-based тестами Э4.3);
    пустое дерево -> `EmptyMilestoneTreeError` (`422 leaf_sum_mismatch`):
    нечего замораживать.

    Реквизиты (redaction v2, etap-4.md Э4.4 — НЕ «для платных сегментов»,
    как в исходной редакции tech-spec.md §6.1, а где договором предусмотрены
    расчёты ЧЕРЕЗ ПЛАТФОРМУ): гейт на `payment_method` из
    `Contract.PROTECTED_PAYMENT_METHODS`, получатель — сторона-исполнитель.
    Р1 хранит зашифрованные банковские реквизиты только у business-сторон
    (`entities.BusinessEntity.bank_details_encrypted`) — для person-стороны
    модели платёжных реквизитов физлица ещё нет, поэтому расчёты через
    платформу с person-получателем честно блокируются (не притворяемся, что
    реквизиты есть — тот же приём, что `ContractTypeNotYetSupportedError`).

    Повторная заморозка БЕЗ изменений (после `decline_for_revision` без
    правок) даёт тот же canonical-хеш — переиспользуем существующую версию
    вместо попытки создать дубликат `UNIQUE (contract, integrity_hash)`.

    Импорт apps.milestones — ОТЛОЖЕННЫЙ (внутри функции, не на уровне
    модуля): apps.milestones.services/selectors/models уже импортируют
    apps.contracts на уровне модуля (Milestone.contract и т.д.) — обратный
    импорт на уровне модуля создал бы цикл ImportError. import-linter это не
    запрещает (контракт запрещает только apps.contracts -> payments/disputes),
    цикл — чисто рантайм-ограничение Python."""
    get_party_for_user(contract, user)
    NEGOTIATION_FSM.assert_transition("freeze", contract.negotiation_status)

    if contract.revision_proposals.filter(status=_REVISION_STATUS.OPEN).exists():
        raise OpenRevisionsError(f"у договора {contract.id} есть открытые правки")

    parties = {p.role: p for p in contract.parties.select_related("profile__owner_user", "entity")}
    contractor = parties[_ROLE.CONTRACTOR]
    _, contractor_has_business_status = _party_status(contractor.profile)
    segment = catalog_services.compute_segment(
        contract.contract_type_id,
        contractor_acting_as=contractor.acting_as,
        contractor_has_business_status=contractor_has_business_status,
    )

    from apps.milestones import services as milestones_services

    try:
        total = milestones_services.total_leaf_amount(contract)
    except ValueError as exc:
        raise EmptyMilestoneTreeError(str(exc)) from exc

    if contract.payment_method in Contract.PROTECTED_PAYMENT_METHODS:
        payee = contractor
        has_requisites = bool(
            payee.acting_as == _ACTING_AS.BUSINESS
            and payee.entity is not None
            and payee.entity.bank_details_encrypted
        )
        if not has_requisites:
            raise RequisitesMissingError(
                f"договор {contract.id}: payment_method={contract.payment_method!r} "
                "предполагает расчёты через платформу — реквизиты выплат исполнителя не заполнены"
            )

    snapshot = _build_snapshot(contract, segment=segment, total=total, parties=parties)
    integrity_hash = sha256_hex(canonical_json_bytes(snapshot))

    version = contract.versions.filter(integrity_hash=integrity_hash).first()
    if version is None:
        # Л.1 (docs/tasks/l10n-wave.md, уточнение к доку 32 v1.2, финал):
        # официальный язык — override PATCH || общий reviewed+ язык обеих
        # сторон || фолбэк по jurisdiction (`_resolve_official_language`);
        # рендеры — официальный язык + языки текущих сторон НА МОМЕНТ
        # заморозки. НЕ входят в snapshot/integrity_hash выше — посчитаны и
        # записаны уже ПОСЛЕ хеша, обратная совместимость хешей уже
        # подписанных договоров не затронута (test_l10n_signing.py).
        canonical_language = _resolve_official_language(contract, parties)
        target_languages = {canonical_language, *_party_locales(parties)}
        renders = {lang: _build_render(snapshot, language=lang) for lang in target_languages}

        timestamp = timestamp_provider.now()
        version = ContractVersion.objects.create(
            contract=contract,
            snapshot=snapshot,
            integrity_hash=integrity_hash,
            frozen_at=timestamp.at,
            trusted_timestamp_source=timestamp.source,
            trusted_timestamp_at=timestamp.at,
            canonical_language=canonical_language,
            renders=renders,
        )

    contract.segment = segment
    contract.frozen_version = version
    contract.negotiation_status = _NEGOTIATION.PENDING_SIGNATURE
    contract.save(update_fields=["segment", "frozen_version", "negotiation_status"])
    outbox.publish(
        Topic.NEGOTIATION_FROZEN,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "version_id": str(version.id),
            "integrity_hash": integrity_hash,
            "segment": segment,
        },
        actor={"user_id": str(user.id)},
    )
    return version


@transaction.atomic
def route_signatory(
    contract: Contract,
    *,
    user: User,
    side: str,
    version_id: UUID,
    signatory_user_id: UUID,
    comment: str = "",
) -> SignatureRequest:
    """POST /contracts/{id}/signature-requests (tech-spec.md §8.4): выбор и
    маршрутизация подписанта по ОДНОЙ стороне (второй вызов, для другой
    стороны — self-loop, `NEGOTIATION_FSM` таблица в начале модуля). Каждая
    сторона маршрутизирует только СВОЮ подпись (не может выбрать подписанта
    за контрагента) — `NotThisSidePartyError`. `version_id` адресует
    заморозку явно (та же защита от «устарело», что `sign` на `version_hash`)."""
    party = contract.parties.select_related("profile__owner_user").get(role=side)
    if party.profile_id not in user_owned_profile_ids(user):
        raise NotThisSidePartyError(
            f"пользователь {user.id} не сторона {side!r} договора {contract.id}"
        )
    transition = NEGOTIATION_FSM.assert_transition("route_signatory", contract.negotiation_status)

    if contract.frozen_version_id is None or contract.frozen_version_id != version_id:
        raise StaleVersionError(
            f"version_id {version_id} не совпадает с текущей замороженной версией "
            f"договора {contract.id}"
        )
    if contract.signature_requests.filter(
        side=side, status=_SIG_STATUS.PENDING, amendment__isnull=True
    ).exists():
        raise SignatureRequestAlreadyPendingError(
            f"у стороны {side!r} договора {contract.id} уже есть незакрытый запрос подписи"
        )

    options = {s["user_id"]: s for s in list_signatories(contract, side=side)}
    option = options.get(signatory_user_id)
    if option is None:
        raise SignatoryNotEligibleError(
            f"{signatory_user_id} не входит в список подписантов стороны {side!r}"
        )
    signatory = User.objects.get(pk=signatory_user_id)

    request = SignatureRequest.objects.create(
        contract=contract,
        version_id=version_id,
        side=side,
        routed_by=user,
        signatory=signatory,
        # ADR-096: каким ОСНОВАНИЕМ маршрутизирована подпись — перепроверяется
        # при подписи (assert_can_sign); NULL для person-стороны.
        signing_authority_id=option.get("authority_id"),
        comment=comment,
    )
    deadline = deadlines_services.create_deadline(
        kind="signature_request_expiry",
        subject_type="signature_request",
        subject_id=request.id,
        starts_from="event",
        anchor_at=timezone.now(),
    )
    request.expires_at = deadline.deadline_at
    request.save(update_fields=["expires_at"])

    if contract.negotiation_status != transition.target:
        contract.negotiation_status = transition.target
        contract.save(update_fields=["negotiation_status"])

    # ADR-178: person-сторона — единственный подписант её собственный user
    # (list_signatories выше), поэтому маршрутизирующий и подписант часто
    # СОВПАДАЮТ — «попросил подписать сам себя» уведомлением быть не должно.
    if signatory.id != user.id:
        notifications_services.place_notification(
            recipient=signatory,
            template="signature_requested",
            payload={"contract_id": str(contract.id), "side": side},
            legal_significance=True,
        )
    outbox.publish(
        Topic.NEGOTIATION_SIGNATURE_REQUESTED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "signature_request_id": str(request.id),
            "side": side,
            "signatory_user_id": str(signatory.id),
        },
        actor={"user_id": str(user.id)},
    )
    return request


def _signature_identity(
    request: SignatureRequest, party: ContractParty, *, amount: Money | None
) -> tuple[str, dict[str, Any]]:
    """(signature_basis, entity_snapshot) для Signature (ADR-096). Business:
    право, зафиксированное при маршрутизации, перепроверяется ПРИ КАЖДОЙ
    подписи (domain-model.md §4 — МЧД могла быть отозвана) и попадает слепком
    в entity_snapshot; basis — настоящий код основания. Person — как раньше."""
    entity_snapshot: dict[str, Any] = {}
    if party.entity is not None:
        entity_snapshot = {
            "entity_id": str(party.entity_id),
            "name": party.entity.name,
            "local_form_code": party.entity.local_form_code,
        }
    if party.acting_as != _ACTING_AS.BUSINESS:
        return "person", entity_snapshot
    authority = authority_services.assert_can_sign(request.signing_authority_id, amount=amount)
    entity_snapshot["signing_authority"] = {
        "id": str(authority.id),
        "basis": authority.basis,
        "poa_registry_id": authority.poa_registry_id,
    }
    return authority.basis, entity_snapshot


def _amendment_effective_total(amendment: Amendment) -> Money | None:
    """Итоговая сумма договора ПОСЛЕ применения допника (ADR-096) — лимит
    права подписи сверяется с суммой, которую подписант авторизует, не со
    старой. Дельта в другой валюте сюда не доходит (валидируется при
    добавлении правок) — оборонительно возвращаем текущий итог."""
    total = _contract_total(amendment.contract)
    delta, _days = compute_amendment_deltas(amendment)
    if total is None or delta is None:
        return total
    try:
        return total + delta
    except CurrencyMismatchError:
        return total


def _assert_is_signatory(request: SignatureRequest, user: User) -> None:
    if request.signatory_id != user.id:
        raise NotTheSignatoryError(
            f"пользователь {user.id} не адресат запроса подписи {request.id}"
        )


def _assert_request_pending(request: SignatureRequest) -> None:
    if request.status != _SIG_STATUS.PENDING:
        raise SignatureRequestNotPendingError(
            f"запрос подписи {request.id} уже не pending (status={request.status})"
        )


@transaction.atomic
def sign(request: SignatureRequest, *, user: User, version_hash: str) -> Signature:
    """POST /signature-requests/{id}/sign (tech-spec.md §8.4, §6.1): подпись
    строго на `version_hash`, переданный в теле запроса — устаревший/чужой
    hash подписать невозможно (`StaleVersionError`, `409 version_stale` в
    api/). **Вторая подпись — ОДНА транзакция**: `signed` +
    `execution_status=pending_start` + событие `contract.signed`
    (etap-4.md Э4.4). Никакой комиссии (финмодель v2, док 28) —
    `contract.signed` не сопровождается `contract.fee_charged`
    (tech-spec.md §6.1 в исходной редакции его публикует, здесь — архив)."""
    contract = request.contract
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    frozen_version = contract.frozen_version
    if frozen_version is None or frozen_version.integrity_hash != version_hash:
        raise StaleVersionError(
            f"version_hash {version_hash!r} не совпадает с текущей замороженной версией "
            f"договора {contract.id}"
        )

    transition = NEGOTIATION_FSM.assert_transition("sign", contract.negotiation_status)

    party = contract.parties.select_related("entity").get(role=request.side)
    signature_basis, entity_snapshot = _signature_identity(
        request, party, amount=_contract_total(contract)
    )
    contact_snapshot = {"user_id": str(user.id), "phone": user.phone, "email": user.email}

    signature = Signature.objects.create(
        contract=contract,
        version_hash=version_hash,
        side=request.side,
        signatory=user,
        signature_basis=signature_basis,
        entity_snapshot=entity_snapshot,
        contact_snapshot=contact_snapshot,
    )
    # Л.1 (docs/tasks/l10n-wave.md, п.4) — «что именно видел подписант»,
    # проверяемо: locale ДЕЙСТВИТЕЛЬНО показанного рендера (не обязательно
    # текущая locale user — resolve_shown_locale честно падает на канон,
    # если рендера для его locale в замороженной версии нет).
    request.status = _SIG_STATUS.SIGNED
    request.locale = resolve_shown_locale(frozen_version, user)
    request.save(update_fields=["status", "locale"])

    other_side = _ROLE.CONTRACTOR if request.side == _ROLE.CUSTOMER else _ROLE.CUSTOMER
    both_sides_signed = contract.signatures.filter(side=other_side, amendment__isnull=True).exists()

    if both_sides_signed:
        final_transition = NEGOTIATION_FSM.assert_transition(
            "complete_signing", contract.negotiation_status
        )
        contract.negotiation_status = final_transition.target
        contract.execution_status = "pending_start"
        contract.save(update_fields=["negotiation_status", "execution_status"])
        outbox.publish(
            Topic.CONTRACT_SIGNED,
            subject={"type": "contract", "id": str(contract.id)},
            payload={"integrity_hash": version_hash, "party_user_ids": _party_user_ids(contract)},
            actor={"user_id": str(user.id)},
        )
    else:
        if contract.negotiation_status != transition.target:
            contract.negotiation_status = transition.target
            contract.save(update_fields=["negotiation_status"])
        outbox.publish(
            Topic.NEGOTIATION_SIGNED,
            subject={"type": "contract", "id": str(contract.id)},
            payload={"side": request.side, "integrity_hash": version_hash},
            actor={"user_id": str(user.id)},
        )
    return signature


@transaction.atomic
def forward_signature_request(
    request: SignatureRequest, *, user: User, comment: str = ""
) -> SignatureRequest:
    """POST /signature-requests/{id}/forward (tech-spec.md §8.4):
    переадресация — содержимое договора не меняется, но выбор подписанта
    открывается заново (`awaiting_signatures -> pending_signature`, §6.1);
    новый подписант выбирается повторным `route_signatory`."""
    contract = request.contract
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    transition = NEGOTIATION_FSM.assert_transition(
        "forward_signature_request", contract.negotiation_status
    )
    request.status = _SIG_STATUS.FORWARDED
    if comment:
        request.comment = comment
    request.save(update_fields=["status", "comment"])
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.NEGOTIATION_SIGNATURE_FORWARDED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"signature_request_id": str(request.id), "side": request.side},
        actor={"user_id": str(user.id)},
    )
    return request


@transaction.atomic
def decline_for_revision(request: SignatureRequest, *, user: User, comment: str) -> Contract:
    """POST /signature-requests/{id}/decline (tech-spec.md §8.4, §6.1):
    заморозка снята, ВСЕ активные запросы подписи и подписи текущего раунда
    аннулируются (ADR-006: «удаляет активные SignatureRequest/подписи»,
    общий `_annul_signing_round`) -> `under_review`. Адресуется подписанту
    pending-запроса; жест «любой стороной без запроса» — `return_for_revision`
    (ADR-124)."""
    contract = request.contract
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    transition = NEGOTIATION_FSM.assert_transition(
        "decline_for_revision", contract.negotiation_status
    )
    annulled = _annul_signing_round(contract)
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.NEGOTIATION_REOPENED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"reason": "declined_for_revision", "comment": comment, **annulled},
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def expire_signature_request(request: SignatureRequest) -> None:
    """Срабатывание доменного дедлайна `kind=signature_request_expiry`
    (apps.deadlines sweep, ЭФ.2) — `apps.contracts.handlers` подписан на
    `domain_deadline.fired` и вызывает это по `subject_id=request.id`.
    Тайм-аут -> `pending_signature` (tech-spec.md §6.1), запрос помечается
    `expired`. Не действие пользователя — без `actor`."""
    if request.status != _SIG_STATUS.PENDING:
        return  # уже обработан (подписан/переадресован/отклонён раньше срабатывания sweep)
    contract = request.contract
    if not NEGOTIATION_FSM.can_transition("expire_signature_request", contract.negotiation_status):
        return  # decline_for_revision уже вернул договор в under_review — нечего делать
    transition = NEGOTIATION_FSM.assert_transition(
        "expire_signature_request", contract.negotiation_status
    )
    request.status = _SIG_STATUS.EXPIRED
    request.save(update_fields=["status"])
    contract.negotiation_status = transition.target
    contract.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.NEGOTIATION_SIGNATURE_REQUEST_EXPIRED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"signature_request_id": str(request.id), "side": request.side},
        actor={},
    )


# --- Э4.5: допники -----------------------------------------------------------


def _get_amendment_milestone_target(contract_id: UUID, target: UUID | None) -> _Milestone:
    from apps.milestones.models import Milestone

    if target is None:
        raise AmendmentChangeTargetNotFoundError("для этого типа изменения нужен target")
    try:
        return Milestone.objects.get(pk=target, contract_id=contract_id)
    except Milestone.DoesNotExist as exc:
        raise AmendmentChangeTargetNotFoundError(
            f"этап {target} не найден в договоре {contract_id}"
        ) from exc


def _get_amendment_material_target(contract_id: UUID, target: UUID | None) -> _ContractMaterial:
    from apps.milestones.models import ContractMaterial

    if target is None:
        raise AmendmentChangeTargetNotFoundError("для этого типа изменения нужен target")
    try:
        return ContractMaterial.objects.select_related("milestone").get(
            pk=target, milestone__contract_id=contract_id
        )
    except ContractMaterial.DoesNotExist as exc:
        raise AmendmentChangeTargetNotFoundError(
            f"материал {target} не найден в договоре {contract_id}"
        ) from exc


def _create_amendment_change(
    amendment: Amendment,
    *,
    type: str,
    target: UUID | None,
    payload: dict[str, Any],  # noqa: A002
) -> AmendmentChange:
    """Резолвит цель, считает `amount_delta`/`days_delta` СЕРВЕРОМ (не
    принимает от клиента — иначе рассинхрон между заявленной дельтой и тем,
    что реально случится с деревом при `apply_amendment`), проверяет гейты
    «нельзя удешевить/убрать принятое» и «нельзя убрать полученный
    материал» — ДО записи (etap-4.md Э4.5, приёмка: `422` на создании, не
    на подписании)."""
    amount_delta: Money | None = None
    days_delta = 0
    contract_id = amendment.contract_id

    if type == _CHANGE_TYPE.ADD_MILESTONE:
        amount, currency = payload.get("amount"), payload.get("currency")
        if amount is not None and currency is not None:
            amount_delta = Money(amount, currency)

    elif type == _CHANGE_TYPE.REMOVE_MILESTONE:
        milestone = _get_amendment_milestone_target(contract_id, target)
        if milestone.children.exists():
            raise AmendmentRemoveTargetNotLeafError(
                f"этап {milestone.id} — не лист, допник убирает только листья"
            )
        if milestone.accepted_at is not None:
            raise AmendmentTargetsAcceptedMilestoneError(
                f"этап {milestone.id} уже принят — убрать допником нельзя"
            )
        if milestone.amount is not None:
            # milestone_amount_currency_together гарантирует пару.
            assert milestone.amount_currency is not None
            amount_delta = Money(-milestone.amount, milestone.amount_currency)

    elif type == _CHANGE_TYPE.MODIFY_MILESTONE:
        milestone = _get_amendment_milestone_target(contract_id, target)
        new_amount, new_currency = payload.get("amount"), payload.get("currency")
        if new_amount is not None and new_currency is not None:
            new = Money(new_amount, new_currency)
            old = None
            if milestone.amount is not None:
                # milestone_amount_currency_together гарантирует пару.
                assert milestone.amount_currency is not None
                old = Money(milestone.amount, milestone.amount_currency)
            amount_delta = new - old if old is not None else new
            if milestone.accepted_at is not None and old is not None and amount_delta.amount < 0:
                raise AmendmentTargetsAcceptedMilestoneError(
                    f"этап {milestone.id} уже принят — удешевить допником нельзя"
                )
        new_deadline_raw = payload.get("deadline")
        if new_deadline_raw is not None and milestone.deadline is not None:
            # payload — сырой JSON (JSONField), не типизированные поля
            # сериалайзера: даты приходят строкой, парсим явно (тот же приём,
            # что apps.milestones.services.materialize_loan_schedule).
            days_delta = (datetime.fromisoformat(new_deadline_raw) - milestone.deadline).days

    elif type == _CHANGE_TYPE.ADD_MATERIAL:
        # target — этап (лист), к которому крепится материал; сам гейт
        # «только лист» проверит apply_amendment_material_add на применении
        # (та же валидация, что create_material — не дублируем здесь).
        _get_amendment_milestone_target(contract_id, target)
        unit_price, currency = payload.get("unit_price"), payload.get("unit_price_currency")
        quantity = payload.get("quantity")
        if unit_price is not None and currency is not None and quantity is not None:
            amount_delta = Money(Decimal(str(unit_price)) * Decimal(str(quantity)), currency)

    elif type == _CHANGE_TYPE.MODIFY_MATERIAL:
        material = _get_amendment_material_target(contract_id, target)
        unit_price = payload.get("unit_price", material.unit_price)
        currency = payload.get("unit_price_currency", material.unit_price_currency)
        quantity = payload.get("quantity", material.quantity)
        old = Money(material.unit_price * material.quantity, material.unit_price_currency)
        new = Money(Decimal(str(unit_price)) * Decimal(str(quantity)), currency)
        amount_delta = new - old

    elif type == _CHANGE_TYPE.REMOVE_MATERIAL:
        material = _get_amendment_material_target(contract_id, target)
        if material.received:
            raise AmendmentTargetsReceivedMaterialError(
                f"материал {material.id} уже получен — убрать допником нельзя"
            )
        amount_delta = Money(
            -(material.unit_price * material.quantity), material.unit_price_currency
        )

    # CUSTOM_TERM: без дельт — чисто текстовое условие.

    return AmendmentChange.objects.create(
        amendment=amendment,
        type=type,
        target=target,
        payload=payload,
        amount_delta=amount_delta.amount if amount_delta is not None else None,
        amount_delta_currency=amount_delta.currency if amount_delta is not None else None,
        days_delta=days_delta,
    )


@transaction.atomic
def create_amendment(
    contract: Contract,
    *,
    user: User,
    reason: str,
    changes: list[dict[str, Any]],
    custom_terms: str = "",
) -> Amendment:
    """POST /contracts/{id}/amendments (tech-spec.md §8.6, domain-model.md
    §9): допник к уже ПОДПИСАННОМУ договору — `ContractNotSignedError`
    иначе. `changes` — список `{"type", "target", "payload"}`, создаётся
    ОДНОЙ транзакцией вместе с Amendment; список неизменяем после создания
    (Р1 — без PATCH допника, см. ADR). `order` — авто, следующий по
    договору."""
    get_party_for_user(contract, user)
    if contract.negotiation_status != _NEGOTIATION.SIGNED:
        raise ContractNotSignedError(
            f"договор {contract.id} не подписан — допник можно завести только к подписанному"
        )
    next_order = (contract.amendments.aggregate(Max("order"))["order__max"] or 0) + 1
    amendment = Amendment.objects.create(
        contract=contract,
        order=next_order,
        reason=reason,
        custom_terms=custom_terms,
        created_by=user,
    )
    for change_data in changes:
        _create_amendment_change(
            amendment,
            type=change_data["type"],
            target=change_data.get("target"),
            payload=change_data.get("payload") or {},
        )
    outbox.publish(
        Topic.AMENDMENT_DRAFTED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={
            "contract_id": str(contract.id),
            "order": next_order,
            "changes_count": len(changes),
        },
        actor={"user_id": str(user.id)},
    )
    return amendment


def _assert_draft_amendment_of_initiator(amendment: Amendment, user: User) -> None:
    """Гейт правки/удаления черновика допника (ADR-161). Порядок проверок —
    сначала «чей», потом «в каком состоянии»: чужой допник не должен даже
    подсказывать, отправлен он уже или нет."""
    get_party_for_user(amendment.contract, user)
    if amendment.created_by_id != user.id:
        raise NotInitiatorError(f"пользователь {user.id} не инициатор допника {amendment.id}")
    if amendment.negotiation_status != _NEGOTIATION.DRAFT:
        raise AmendmentNotDraftError(
            f"допник {amendment.id} уже отправлен ({amendment.negotiation_status}) — "
            "правки только через withdraw и новый допник"
        )


@transaction.atomic
def update_draft_amendment(
    amendment: Amendment,
    *,
    user: User,
    reason: str,
    changes: list[dict[str, Any]],
    custom_terms: str = "",
) -> Amendment:
    """PATCH /amendments/{id} (ADR-161): правка ЧЕРНОВИКА допника его
    инициатором. Список `changes` заменяется ЦЕЛИКОМ — точечные правки
    отдельных `AmendmentChange` не вводим: дельты (`amount_delta`,
    `days_delta`) считаются сервером от текущего состояния дерева, и
    пересоздание всего списка тем же `_create_amendment_change` — то же
    самое, что делает `create_amendment`, без второго кодового пути с
    собственными гейтами. Транзакция общая: если хоть одно изменение не
    прошло гейты (422), прежний список остаётся нетронутым.

    События не публикуются: черновик до `send` — рабочая заготовка,
    видимая только инициатору, а не юрзначимый факт (ADR-161 §4)."""
    _assert_draft_amendment_of_initiator(amendment, user)
    amendment.reason = reason
    amendment.custom_terms = custom_terms
    amendment.save(update_fields=["reason", "custom_terms"])
    amendment.changes.all().delete()
    for change_data in changes:
        _create_amendment_change(
            amendment,
            type=change_data["type"],
            target=change_data.get("target"),
            payload=change_data.get("payload") or {},
        )
    return amendment


@transaction.atomic
def delete_draft_amendment(amendment: Amendment, *, user: User) -> None:
    """DELETE /amendments/{id} (ADR-161): инициатор выбрасывает СВОЙ
    черновик. Не нарушает «мягкого удаления юрзначимых сущностей нет»
    (CLAUDE.md): черновик не заморожен, не подписан, второй стороне не
    показан — юридического следа за ним нет. Номер освободившегося черновика
    переиспользуется (`create_amendment` берёт `max(order)+1` по ОСТАВШИМСЯ),
    и это верно: сквозная нумерация допников договора не должна зиять
    дырами от выброшенных заготовок, а занять чужой номер нельзя —
    отправленный допник не удаляется."""
    _assert_draft_amendment_of_initiator(amendment, user)
    amendment.delete()


@transaction.atomic
def send_amendment_for_review(amendment: Amendment, *, user: User) -> Amendment:
    """POST /amendments/{id}/send: draft -> under_review — ТОТ ЖЕ переход
    `NEGOTIATION_FSM`, что и у договора (Э4.2), на своём поле
    `negotiation_status`."""
    get_party_for_user(amendment.contract, user)
    NEGOTIATION_FSM.assert_transition("send", amendment.negotiation_status)
    amendment.negotiation_status = _NEGOTIATION.UNDER_REVIEW
    amendment.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.AMENDMENT_SENT,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={"contract_id": str(amendment.contract_id)},
        actor={"user_id": str(user.id)},
    )
    return amendment


# Ключ анти-waiver-оговорки в payload изменения допника (§20.3, ADR-131):
# скидка закрывает ТОЛЬКО указанный дефект и не является отказом от
# остальных требований по этапу. Живёт в payload, а значит — в замороженном
# снимке допника, который стороны подписывают.
AMENDMENT_ANTI_WAIVER_KEY = "anti_waiver"


@transaction.atomic
def create_discount_amendment(
    contract: Contract,
    *,
    user: User,
    milestone_id: UUID,
    new_amount: Decimal,
    currency: str,
    reason: str,
    anti_waiver_note: str,
    checklist_item_id: UUID | None = None,
) -> Amendment:
    """ФАСАД для apps.disputes (ADR-131, tech-spec.md §5.2.7: «discount_
    agreement подписывается через ОБЩИЙ контур amendment (скидка = допник с
    MODIFY_MILESTONE)»).

    Зачем фасад, а не сборка `changes=[...]` на стороне apps.disputes: знание
    «скидка выражается изменением типа MODIFY_MILESTONE с ключами
    amount/currency и анти-waiver-оговоркой в payload» — знание ДОГОВОРНОГО
    контура. Продублированное в disputes, оно разъехалось бы при первом же
    изменении формата `AmendmentChange.payload`. Направление импорта
    disputes -> contracts законно (import-linter запрещает только обратное).

    Допник сразу уходит на согласование (`send_amendment_for_review`):
    черновик скидки, о котором вторая сторона не знает, бессмыслен — это
    предложение, а не заготовка. Дальше — общий контур §8.6 (заморозка,
    маршрутизация подписанта, две подписи), по второй подписи
    `apply_amendment` меняет сумму листа и публикуется `contract.amended`."""
    if contract.negotiation_status != _NEGOTIATION.SIGNED:
        raise ContractNotSignedError(
            f"договор {contract.id} не подписан — скидка оформляется допником к подписанному"
        )
    amendment = create_amendment(
        contract,
        user=user,
        reason=reason,
        changes=[
            {
                "type": _CHANGE_TYPE.MODIFY_MILESTONE,
                "target": milestone_id,
                "payload": {
                    "amount": str(new_amount),
                    "currency": currency,
                    AMENDMENT_ANTI_WAIVER_KEY: {
                        "note": anti_waiver_note,
                        "covers_checklist_item_id": (
                            str(checklist_item_id) if checklist_item_id else None
                        ),
                    },
                },
            }
        ],
    )
    return send_amendment_for_review(amendment, user=user)


def compute_amendment_deltas(amendment: Amendment) -> tuple[Money | None, int]:
    """Суммарные `amount_delta`/`days_delta` допника по всем его
    `AmendmentChange` — переиспользуется и в canonical-снимке
    (`_build_amendment_snapshot`), и в `GET /amendments/{id}` (api/
    serializers.py), не копируется."""
    total_amount_delta: Money | None = None
    total_days_delta = 0
    for change in amendment.changes.all():
        if change.amount_delta is not None:
            # CheckConstraint amendment_change_amount_delta_currency_together
            # гарантирует пару — mypy об этом не знает.
            assert change.amount_delta_currency is not None
            delta = Money(change.amount_delta, change.amount_delta_currency)
            total_amount_delta = delta if total_amount_delta is None else total_amount_delta + delta
        total_days_delta += change.days_delta
    return total_amount_delta, total_days_delta


def _build_amendment_snapshot(amendment: Amendment) -> dict[str, Any]:
    changes = [
        {
            "type": change.type,
            "target": change.target,
            "payload": change.payload,
            "amount_delta": (
                {"amount": change.amount_delta, "currency": change.amount_delta_currency}
                if change.amount_delta is not None
                else None
            ),
            "days_delta": change.days_delta,
        }
        for change in amendment.changes.all()
    ]
    total_amount_delta, total_days_delta = compute_amendment_deltas(amendment)
    document: dict[str, Any] = _json_safe(
        {
            "amendment_id": str(amendment.id),
            "contract_id": str(amendment.contract_id),
            "order": amendment.order,
            "reason": amendment.reason,
            "custom_terms": amendment.custom_terms,
            "changes": changes,
            "amount_delta": (
                {"amount": total_amount_delta.amount, "currency": total_amount_delta.currency}
                if total_amount_delta is not None
                else None
            ),
            "days_delta": total_days_delta,
        }
    )
    return document


@transaction.atomic
def freeze_amendment(
    amendment: Amendment,
    *,
    user: User,
    timestamp_provider: TimestampProvider = DEFAULT_TIMESTAMP_PROVIDER,
) -> ContractVersion:
    """POST /amendments/{id}/freeze — ТА ЖЕ таблица `ContractVersion`
    (`contract=amendment.contract`), та же canonical-сериализация + sha256 +
    `TimestampProvider`, что `freeze_contract` (Э4.4). Протокола разногласий
    на допниках нет в этой ветке (сеам) — «нет открытых ревизий» здесь
    нечего проверять."""
    get_party_for_user(amendment.contract, user)
    NEGOTIATION_FSM.assert_transition("freeze", amendment.negotiation_status)

    snapshot = _build_amendment_snapshot(amendment)
    integrity_hash = sha256_hex(canonical_json_bytes(snapshot))

    version = amendment.contract.versions.filter(integrity_hash=integrity_hash).first()
    if version is None:
        timestamp = timestamp_provider.now()
        version = ContractVersion.objects.create(
            contract=amendment.contract,
            snapshot=snapshot,
            integrity_hash=integrity_hash,
            frozen_at=timestamp.at,
            trusted_timestamp_source=timestamp.source,
            trusted_timestamp_at=timestamp.at,
        )

    amendment.frozen_version = version
    amendment.negotiation_status = _NEGOTIATION.PENDING_SIGNATURE
    amendment.save(update_fields=["frozen_version", "negotiation_status"])
    outbox.publish(
        Topic.AMENDMENT_FROZEN,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={
            "contract_id": str(amendment.contract_id),
            "version_id": str(version.id),
            "integrity_hash": integrity_hash,
        },
        actor={"user_id": str(user.id)},
    )
    return version


@transaction.atomic
def route_amendment_signatory(
    amendment: Amendment,
    *,
    user: User,
    side: str,
    version_id: UUID,
    signatory_user_id: UUID,
    comment: str = "",
) -> SignatureRequest:
    """POST /amendments/{id}/signature-requests — структурно `route_signatory`
    (Э4.4), но пишет `amendment.negotiation_status`/`.frozen_version_id`;
    подписанты те же стороны ДОГОВОРА (`list_signatories(amendment.contract,
    ...)`, без изменений — у допника своих сторон нет)."""
    contract = amendment.contract
    party = contract.parties.select_related("profile__owner_user").get(role=side)
    if party.profile_id not in user_owned_profile_ids(user):
        raise NotThisSidePartyError(
            f"пользователь {user.id} не сторона {side!r} договора {contract.id}"
        )
    transition = NEGOTIATION_FSM.assert_transition("route_signatory", amendment.negotiation_status)

    if amendment.frozen_version_id is None or amendment.frozen_version_id != version_id:
        raise StaleVersionError(
            f"version_id {version_id} не совпадает с текущей замороженной версией допника "
            f"{amendment.id}"
        )
    if amendment.signature_requests.filter(side=side, status=_SIG_STATUS.PENDING).exists():
        raise SignatureRequestAlreadyPendingError(
            f"у стороны {side!r} допника {amendment.id} уже есть незакрытый запрос подписи"
        )

    # ADR-096: лимит права сверяется с ИТОГОВОЙ суммой (с учётом дельты
    # допника) — подписант авторизует новую сумму договора, не старую.
    options = {
        s["user_id"]: s
        for s in list_signatories(contract, side=side, amount=_amendment_effective_total(amendment))
    }
    option = options.get(signatory_user_id)
    if option is None:
        raise SignatoryNotEligibleError(
            f"{signatory_user_id} не входит в список подписантов стороны {side!r}"
        )
    signatory = User.objects.get(pk=signatory_user_id)

    request = SignatureRequest.objects.create(
        contract=contract,
        amendment=amendment,
        version_id=version_id,
        side=side,
        routed_by=user,
        signatory=signatory,
        signing_authority_id=option.get("authority_id"),
        comment=comment,
    )
    deadline = deadlines_services.create_deadline(
        kind="signature_request_expiry",
        subject_type="signature_request",
        subject_id=request.id,
        starts_from="event",
        anchor_at=timezone.now(),
    )
    request.expires_at = deadline.deadline_at
    request.save(update_fields=["expires_at"])

    if amendment.negotiation_status != transition.target:
        amendment.negotiation_status = transition.target
        amendment.save(update_fields=["negotiation_status"])

    # ADR-178: как и в route_signatory — не уведомляем, если маршрутизирующий
    # и подписант совпадают (person-сторона маршрутизирует сама на себя).
    if signatory.id != user.id:
        notifications_services.place_notification(
            recipient=signatory,
            template="signature_requested",
            payload={
                "contract_id": str(contract.id),
                "amendment_id": str(amendment.id),
                "side": side,
            },
            legal_significance=True,
        )
    outbox.publish(
        Topic.AMENDMENT_SIGNATURE_REQUESTED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={
            "signature_request_id": str(request.id),
            "side": side,
            "signatory_user_id": str(signatory.id),
        },
        actor={"user_id": str(user.id)},
    )
    return request


@transaction.atomic
def sign_amendment(request: SignatureRequest, *, user: User, version_hash: str) -> Signature:
    """POST /signature-requests/{id}/sign — ветка дуальной развилки (api/
    views.py) для запроса с непустым `amendment`. Структурно `sign` (Э4.4);
    на ВТОРОЙ подписи — ОДНА транзакция: `signed` + `apply_amendment`
    (применение к дереву, etap-4.md Э4.5) + событие `contract.amended`
    (НЕ `contract.signed` — это не первичное подписание договора)."""
    amendment = request.amendment
    if amendment is None:  # pragma: no cover — гарантируется развилкой в views.py
        raise ValueError(f"запрос подписи {request.id} не про допник")
    contract = request.contract
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    frozen_version = amendment.frozen_version
    if frozen_version is None or frozen_version.integrity_hash != version_hash:
        raise StaleVersionError(
            f"version_hash {version_hash!r} не совпадает с текущей замороженной версией "
            f"допника {amendment.id}"
        )

    transition = NEGOTIATION_FSM.assert_transition("sign", amendment.negotiation_status)

    party = contract.parties.select_related("entity").get(role=request.side)
    signature_basis, entity_snapshot = _signature_identity(
        request, party, amount=_amendment_effective_total(amendment)
    )
    contact_snapshot = {"user_id": str(user.id), "phone": user.phone, "email": user.email}

    signature = Signature.objects.create(
        contract=contract,
        amendment=amendment,
        version_hash=version_hash,
        side=request.side,
        signatory=user,
        signature_basis=signature_basis,
        entity_snapshot=entity_snapshot,
        contact_snapshot=contact_snapshot,
    )
    request.status = _SIG_STATUS.SIGNED
    request.save(update_fields=["status"])

    other_side = _ROLE.CONTRACTOR if request.side == _ROLE.CUSTOMER else _ROLE.CUSTOMER
    both_sides_signed = amendment.signatures.filter(side=other_side).exists()

    if both_sides_signed:
        final_transition = NEGOTIATION_FSM.assert_transition(
            "complete_signing", amendment.negotiation_status
        )
        amendment.negotiation_status = final_transition.target
        amendment.save(update_fields=["negotiation_status"])
        apply_amendment(amendment)
        outbox.publish(
            Topic.CONTRACT_AMENDED,
            subject={"type": "contract", "id": str(contract.id)},
            payload={"amendment_id": str(amendment.id), "integrity_hash": version_hash},
            actor={"user_id": str(user.id)},
        )
    else:
        if amendment.negotiation_status != transition.target:
            amendment.negotiation_status = transition.target
            amendment.save(update_fields=["negotiation_status"])
        outbox.publish(
            Topic.AMENDMENT_SIGNED,
            subject={"type": "amendment", "id": str(amendment.id)},
            payload={"side": request.side, "integrity_hash": version_hash},
            actor={"user_id": str(user.id)},
        )
    return signature


@transaction.atomic
def forward_amendment_signature_request(
    request: SignatureRequest, *, user: User, comment: str = ""
) -> SignatureRequest:
    """POST /signature-requests/{id}/forward — ветка дуальной развилки,
    структурно `forward_signature_request` (Э4.4) на `amendment`."""
    amendment = request.amendment
    if amendment is None:  # pragma: no cover
        raise ValueError(f"запрос подписи {request.id} не про допник")
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    transition = NEGOTIATION_FSM.assert_transition(
        "forward_signature_request", amendment.negotiation_status
    )
    request.status = _SIG_STATUS.FORWARDED
    if comment:
        request.comment = comment
    request.save(update_fields=["status", "comment"])
    amendment.negotiation_status = transition.target
    amendment.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.AMENDMENT_SIGNATURE_FORWARDED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={"signature_request_id": str(request.id), "side": request.side},
        actor={"user_id": str(user.id)},
    )
    return request


@transaction.atomic
def decline_amendment_for_revision(
    request: SignatureRequest, *, user: User, comment: str
) -> Amendment:
    """POST /signature-requests/{id}/decline — ветка дуальной развилки,
    структурно `decline_for_revision` (Э4.4) на `amendment`: аннулирует
    активные запросы/подписи ТЕКУЩЕГО РАУНДА ДОПНИКА (не трогает договорные
    — фильтрация через `amendment=amendment`, отдельная реверс-связь от
    `contract.signature_requests`/`contract.signatures`)."""
    amendment = request.amendment
    if amendment is None:  # pragma: no cover
        raise ValueError(f"запрос подписи {request.id} не про допник")
    _assert_is_signatory(request, user)
    _assert_request_pending(request)
    transition = NEGOTIATION_FSM.assert_transition(
        "decline_for_revision", amendment.negotiation_status
    )

    annulled = _annul_amendment_signing_round(amendment)
    amendment.negotiation_status = transition.target
    amendment.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.AMENDMENT_REOPENED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={"reason": "declined_for_revision", "comment": comment, **annulled},
        actor={"user_id": str(user.id)},
    )
    return amendment


def _annul_amendment_signing_round(amendment: Amendment) -> dict[str, list[str]]:
    """Аналог `_annul_signing_round` для РАУНДА ДОПНИКА: активные запросы
    подписи допника -> `declined_for_revision`, подписи допника удаляются,
    `amendment.frozen_version` снимается. Договорный раунд не трогается —
    фильтрация идёт через реверс-связи самого допника
    (`amendment.signature_requests`/`amendment.signatures`). Не сохраняет
    `amendment` — вызывающий делает `save(update_fields=[..., "frozen_version"])`
    вместе со сменой статуса в одной транзакции. `ContractVersion` не
    удаляется (append-only история снимков)."""
    pending_requests = amendment.signature_requests.filter(status=_SIG_STATUS.PENDING)
    annulled_request_ids = [str(i) for i in pending_requests.values_list("id", flat=True)]
    annulled_signature_ids = [str(i) for i in amendment.signatures.values_list("id", flat=True)]
    pending_requests.update(status=_SIG_STATUS.DECLINED_FOR_REVISION)
    amendment.signatures.all().delete()
    amendment.frozen_version = None
    return {
        "annulled_signature_request_ids": annulled_request_ids,
        "annulled_signature_ids": annulled_signature_ids,
    }


@transaction.atomic
def withdraw_amendment(amendment: Amendment, *, user: User, reason: str = "") -> Amendment:
    """POST /amendments/{id}/withdraw (дополнение 26.08 к ADR-075): under_review /
    pending_signature / awaiting_signatures -> withdrawn_by_initiator,
    терминально, только ИНИЦИАТОР допника (`Amendment.created_by`) — тот же
    переход `withdraw` того же `NEGOTIATION_FSM`, что у `withdraw_negotiation`.
    Из заморозки — с аннулированием раунда подписания допника
    (`_annul_amendment_signing_round`). Подписанный допник неизменяем: из
    `signed` перехода нет -> `InvalidTransitionError` (409).

    Допник скидки по спору (ADR-131): спор возвращается в `open` ПОДПИСЧИКОМ
    apps.disputes на `amendment.withdrawn` — contracts про disputes не знает
    (import-linter), связка «допник -> спор» живёт в `DiscountAgreement`."""
    get_party_for_user(amendment.contract, user)
    if amendment.created_by_id != user.id:
        raise NotInitiatorError(f"пользователь {user.id} не инициатор допника {amendment.id}")
    transition = NEGOTIATION_FSM.assert_transition("withdraw", amendment.negotiation_status)
    annulled = _annul_amendment_signing_round(amendment)
    amendment.negotiation_status = transition.target
    amendment.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.AMENDMENT_WITHDRAWN,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={
            "contract_id": str(amendment.contract_id),
            "order": amendment.order,
            "reason": reason,
            **annulled,
        },
        actor={"user_id": str(user.id)},
    )
    return amendment


@transaction.atomic
def reject_amendment(
    amendment: Amendment, *, user: User, reason: str = "", cause: str = ""
) -> Amendment:
    """POST /amendments/{id}/reject (дополнение 26.08 к ADR-075): under_review /
    pending_signature / awaiting_signatures -> rejected_by_counterparty,
    терминально, только ВТОРАЯ сторона (не `Amendment.created_by`) —
    зеркало `reject_negotiation`. Из заморозки — с аннулированием раунда
    подписания допника. Спор по скидке возвращает в `open` подписчик
    apps.disputes на `amendment.rejected` (см. `withdraw_amendment`).

    `cause` — непустой, когда отклонение НЕ самостоятельное действие
    стороны, а следствие другого (дополнение 26.08 к ADR-131: отказ от
    скидки в споре закрывает и допник скидки — `cause="discount_declined"`).
    Уходит в payload события: реестры уведомлений по нему глушат второе
    уведомление о том же моменте (ADR-126 §4); сам факт в хронике допника и
    Audit Vault остаётся. Пустая строка — обычное ручное отклонение."""
    get_party_for_user(amendment.contract, user)
    if amendment.created_by_id == user.id:
        raise NotCounterpartyError(
            f"пользователь {user.id} инициатор допника {amendment.id} — "
            "reject только для второй стороны"
        )
    transition = NEGOTIATION_FSM.assert_transition("reject", amendment.negotiation_status)
    annulled = _annul_amendment_signing_round(amendment)
    amendment.negotiation_status = transition.target
    amendment.save(update_fields=["negotiation_status", "frozen_version"])
    outbox.publish(
        Topic.AMENDMENT_REJECTED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={
            "contract_id": str(amendment.contract_id),
            "order": amendment.order,
            "reason": reason,
            "cause": cause,
            **annulled,
        },
        actor={"user_id": str(user.id)},
    )
    return amendment


@transaction.atomic
def expire_amendment_signature_request(request: SignatureRequest) -> None:
    """Срабатывание `signature_request_expiry` для запроса допника — та же
    диспетчеризация из `apps.contracts.handlers`, что `expire_signature_request`
    (Э4.4), по наличию `request.amendment_id`."""
    if request.status != _SIG_STATUS.PENDING:
        return
    amendment = request.amendment
    if amendment is None:  # pragma: no cover
        return
    if not NEGOTIATION_FSM.can_transition("expire_signature_request", amendment.negotiation_status):
        return
    transition = NEGOTIATION_FSM.assert_transition(
        "expire_signature_request", amendment.negotiation_status
    )
    request.status = _SIG_STATUS.EXPIRED
    request.save(update_fields=["status"])
    amendment.negotiation_status = transition.target
    amendment.save(update_fields=["negotiation_status"])
    outbox.publish(
        Topic.AMENDMENT_SIGNATURE_REQUEST_EXPIRED,
        subject={"type": "amendment", "id": str(amendment.id)},
        payload={"signature_request_id": str(request.id), "side": request.side},
        actor={},
    )


@transaction.atomic
def apply_amendment(amendment: Amendment) -> None:
    """Применение изменений к дереву — вызывается ИЗ `sign_amendment` на
    второй подписи, В ТОЙ ЖЕ транзакции (etap-4.md Э4.5: «применение
    изменений к дереву после signed допника»). Отложенный импорт
    apps.milestones — тот же разрыв цикла, что во `freeze_contract`/
    `_build_snapshot`."""
    from apps.milestones import services as milestones_services

    for change in amendment.changes.all().order_by("created_at"):
        # target — nullable в модели (custom_term/add_milestone его не
        # используют), но для остальных типов уже проверен на существование
        # при создании допника (_create_amendment_change) — гарантированно
        # не None здесь; mypy об этой связи не знает.
        if change.type == _CHANGE_TYPE.ADD_MILESTONE:
            milestones_services.apply_amendment_milestone_add(
                amendment.contract, amendment=amendment, payload=change.payload
            )
        elif change.type == _CHANGE_TYPE.REMOVE_MILESTONE:
            assert change.target is not None
            milestones_services.apply_amendment_milestone_remove(target=change.target)
        elif change.type == _CHANGE_TYPE.MODIFY_MILESTONE:
            assert change.target is not None
            milestones_services.apply_amendment_milestone_modify(
                target=change.target, payload=change.payload
            )
        elif change.type == _CHANGE_TYPE.ADD_MATERIAL:
            assert change.target is not None
            milestones_services.apply_amendment_material_add(
                milestone_id=change.target, payload=change.payload
            )
        elif change.type == _CHANGE_TYPE.MODIFY_MATERIAL:
            assert change.target is not None
            milestones_services.apply_amendment_material_modify(
                target=change.target, payload=change.payload
            )
        elif change.type == _CHANGE_TYPE.REMOVE_MATERIAL:
            assert change.target is not None
            milestones_services.apply_amendment_material_remove(target=change.target)
        # CUSTOM_TERM: не мутирует дерево — текстовое условие уходит в
        # effective_terms() снимком замороженного допника, дерева не касается.


def effective_terms(contract: Contract) -> dict[str, Any]:
    """«Склейка эффективных условий» (etap-4.md Э4.5) — БЕЗ глубокого диффа
    неизменяемого `ContractVersion.snapshot` (append-only история): базовый
    замороженный снимок договора + хронологический список ПРИМЕНЁННЫХ
    (`signed`) допников. Текущее состояние дерева этапов — источник истины
    самого дерева, эта функция не пытается его продублировать структурным
    диффом; `total_amount` — ЖИВАЯ сумма (`total_leaf_amount`), не из
    снимка."""
    from apps.milestones import services as milestones_services

    base = dict(contract.frozen_version.snapshot) if contract.frozen_version else {}
    amendments = []
    for amendment in contract.amendments.filter(negotiation_status=_NEGOTIATION.SIGNED).order_by(
        "order"
    ):
        frozen = amendment.frozen_version
        amendments.append(
            {
                "order": amendment.order,
                "reason": amendment.reason,
                "custom_terms": amendment.custom_terms,
                "amount_delta": frozen.snapshot.get("amount_delta") if frozen else None,
                "days_delta": frozen.snapshot.get("days_delta") if frozen else 0,
            }
        )
    try:
        total = milestones_services.total_leaf_amount(contract)
        total_amount: dict[str, Any] | None = {
            "amount": str(total.amount),
            "currency": total.currency,
        }
    except ValueError:
        total_amount = None
    return {**base, "amendments": amendments, "total_amount": total_amount}


# --- Э4.6: исполнение договора (tech-spec.md §6.2, docs/tasks/etap-4.md) ----
#
# Своя `StateMachine` — домен исполнения отдельный от согласования подписи
# (NEGOTIATION_FSM), начинается уже с `pending_start` (Э4.4 сама пишет это
# значение на второй подписи, до появления этой FSM). Переходы вызываются
# ИЗ apps.milestones (гейт первого листа -> start_execution; последний лист
# paid -> complete_execution) — apps.contracts НЕ импортирует apps.milestones
# для этого модуля (тот же однонаправленный вызов milestones -> contracts,
# что и `is_party`/`get_party_for_user` в остальных ветках Э4.3-4.5).
# `terminate_by_customer`/`terminate_by_contractor` — ТОЛЬКО заглушки
# перехода (ADR-028: полный денежный расчёт расторжения — этап 7).
_EXECUTION = Contract.ExecutionStatus

EXECUTION_FSM = StateMachine(
    states=[s.value for s in _EXECUTION],
    transitions=[
        Transition("start_execution", _EXECUTION.PENDING_START, _EXECUTION.IN_PROGRESS),
        Transition("complete_execution", _EXECUTION.IN_PROGRESS, _EXECUTION.COMPLETED),
        Transition("enter_warranty", _EXECUTION.COMPLETED, _EXECUTION.WARRANTY),
        Transition("close_contract", _EXECUTION.WARRANTY, _EXECUTION.CLOSED),
        # ADR-138: сделка без движения 3 месяца закрывается автоматически —
        # СРАЗУ в `closed`, минуя `completed`/`warranty`: работы не приняты
        # и не оплачены, «завершённым» такой договор не был (репутация
        # считает `contract.completed`, гарантия — на принятый результат).
        Transition("auto_close_idle", _EXECUTION.IN_PROGRESS, _EXECUTION.CLOSED),
        # ADR-028: заказчик расторгает «в любой момент» — до старта работ
        # (pending_start) и во время исполнения (in_progress).
        Transition(
            "terminate_by_customer", _EXECUTION.PENDING_START, _EXECUTION.TERMINATED_BY_CUSTOMER
        ),
        Transition(
            "terminate_by_customer", _EXECUTION.IN_PROGRESS, _EXECUTION.TERMINATED_BY_CUSTOMER
        ),
        # Исполнитель — НЕ свободное право (ADR-028: «требует основания,
        # проходит через окно оспаривания», этап 7) — доступно только пока
        # исполнение уже идёт, не до старта (до старта нет оснований для
        # обвинения заказчика в непредоставлении материалов/доступа).
        Transition(
            "terminate_by_contractor", _EXECUTION.IN_PROGRESS, _EXECUTION.TERMINATED_BY_CONTRACTOR
        ),
    ],
)

# Гарантийный период — DeadlineKindConfig (данные, не константа в коде,
# CLAUDE.md), тот же приём, что `signature_request_expiry`: явного числа в
# спеке нет (ADR-029 «по согласованию сторон, платформа подсказывает по
# категории» — JurisdictionConfig.warranty_recommendation ещё не заведён,
# domain-model.md §12), здесь единая длительность — предмет согласования с
# юристом (см. apps/deadlines/migrations и её сид).
_WARRANTY_DEADLINE_KIND = "contract_warranty"

# ADR-138: дедлайны «без движения». `contract_idle` — 3 месяца от последнего
# движения (переносится обновлением строки при каждом движении);
# `contract_idle_retry` — отсрочка на 14 суток, когда закрытию мешают
# незавершённые действия сторон. Длительности — DeadlineKindConfig
# (apps/deadlines/migrations/0007), серия предупреждений —
# ReminderPointConfig(kind="contract_idle") (apps/notifications/migrations/0020).
IDLE_DEADLINE_KIND = "contract_idle"
IDLE_RETRY_DEADLINE_KIND = "contract_idle_retry"
_IDLE_DEADLINE_KINDS = (IDLE_DEADLINE_KIND, IDLE_RETRY_DEADLINE_KIND)
# Исходы дедлайнов idle (DomainDeadline.outcome — свободный текст, §5.2.10).
_IDLE_OUTCOME_ACTIVITY = "activity"
_IDLE_OUTCOME_EXECUTION_FINISHED = "execution_finished"
_IDLE_OUTCOME_AUTO_CLOSED = "auto_closed"
_IDLE_OUTCOME_POSTPONED = "postponed"
_IDLE_OUTCOME_STALE = "stale"
# Статусы этапов, при которых автозакрытие откладывается (см. ADR-138 §3):
# этап на приёмке (окно приёмки тикает, исход — действие заказчика либо
# автоприёмка) и принятый, но не оплаченный (закрыть договор с долгом за
# принятую работу — ущемить исполнителя). Значения — Milestone.Status
# (apps.milestones), по значению: рантайм-импорт модели здесь не нужен,
# `contract.milestones` — обратная связь FK.
_IDLE_BLOCKING_MILESTONE_STATUSES = ("under_acceptance", "accepted")


class InvalidExecutionTransitionError(ValueError):
    """Обёртка `common.fsm.InvalidTransitionError` для EXECUTION_FSM —
    отдельный домен от NEGOTIATION_FSM (api/ должен уметь различить два
    ошибочных кода: `invalid_negotiation_transition` vs
    `invalid_execution_transition`, тот же класс исключения иначе не дал бы
    этого сделать через `_SERVICE_ERROR_STATUS` по типу)."""


class TerminationReasonRequiredError(ValueError):
    """ADR-028: расторжение исполнителем — не свободное право, требует
    основания (`reason` пуст)."""


def _assert_execution_transition(name: str, source: str | None) -> Any:  # noqa: ANN401
    try:
        return EXECUTION_FSM.assert_transition(name, source or "")
    except InvalidTransitionError as exc:
        raise InvalidExecutionTransitionError(str(exc)) from exc


@transaction.atomic
def start_execution(contract: Contract) -> Contract:
    """`pending_start -> in_progress` — гейт ПЕРВОГО листа (tech-spec.md
    §6.2). Вызывается `apps.milestones.services.start_milestone` при первом
    успешном проходе гейта листа договора — ИДЕМПОТЕНТНО: несколько листьев
    без взаимной зависимости (`depends_on`) могут пройти гейт «одновременно»
    (в пределах одной sweep-волны), повторный вызов на уже `in_progress`
    договоре — NOOP, не ошибка."""
    if contract.execution_status == _EXECUTION.IN_PROGRESS:
        return contract
    transition = _assert_execution_transition("start_execution", contract.execution_status)
    contract.execution_status = transition.target
    contract.save(update_fields=["execution_status"])
    # ADR-138: старт исполнения — первое движение, от которого тикает
    # `contract_idle`; прямой вызов, не через подписчика (событие ниже без
    # актора и движением не считается).
    record_contract_activity(contract, at=timezone.now())
    outbox.publish(
        Topic.CONTRACT_STARTED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"parties": party_identity_snapshot(contract)},
        actor={},
    )
    return contract


@transaction.atomic
def complete_execution(contract: Contract) -> Contract:
    """`in_progress -> completed -> warranty` — переход в `warranty`
    немедленно вслед за `completed` (даты разделяют только `warranty` и
    `closed`, tech-spec.md §6.2). Вызывается `apps.milestones.services.
    confirm_payment`, когда ПОСЛЕДНИЙ лист становится `paid`. Публикует ОБА
    события раздельно — «доп. требование, док 31 §7»: `contract.completed`
    — самостоятельный неизменяемый исход для будущей репутационной карточки
    (ГВ.4), даже если `warranty_started` наступает в ту же секунду."""
    complete_transition = _assert_execution_transition(
        "complete_execution", contract.execution_status
    )
    contract.execution_status = complete_transition.target
    contract.save(update_fields=["execution_status"])
    _close_idle_deadlines(contract, outcome=_IDLE_OUTCOME_EXECUTION_FINISHED)
    now = timezone.now()
    parties = party_identity_snapshot(contract)
    outbox.publish(
        Topic.CONTRACT_COMPLETED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "contract_id": str(contract.id),
            "contract_type_code": contract.contract_type_id,
            "segment": contract.segment,
            "parties": parties,
            "completed_at": now.isoformat(),
            # ADR-163 §4/§6: объём сделки и уровень защиты платежа —
            # аддитивные поля для read-модели репутации. Они СЧИТАЮТСЯ, но
            # публичной карточке не отдаются (сумма чужой сделки —
            # коммерческая тайна стороны, а не факт её надёжности); видны
            # только владельцу в приватном `/insights`. Деньги — парой,
            # суммой строкой (CLAUDE.md); `null` — дерева этапов нет.
            "total": (
                {"amount": str(total.amount), "currency": total.currency}
                if (total := _contract_total(contract)) is not None
                else None
            ),
            "payment_method": contract.payment_method or "",
            "payment_protected": contract.protected,
        },
        actor={},
    )
    # feat/notifications-wiring: actor события выше ВСЕГДА пуст (системный
    # гейт последнего оплаченного листа, не действие конкретного
    # пользователя) — ни один из реестров settings.NOTIFICATION_TOPIC_
    # ADDRESSEE_TEMPLATES / _COUNTERPARTY_TEMPLATES этот топик не маппит.
    # «Договор завершён» — двусторонний факт, обеим
    # сторонам отдельно, тем же прямым вызовом, что уже используют
    # evidence_received/signature_requested/milestone_submitted_for_
    # acceptance (apps.notifications.services.place_notification, минуя
    # topic-реестр).
    for role in (_ROLE.CUSTOMER, _ROLE.CONTRACTOR):
        party = contract.parties.filter(role=role).first()
        party_recipient = party_user(party) if party is not None else None
        if party_recipient is not None:
            notifications_services.place_notification(
                recipient=party_recipient,
                template="contract.completed",
                payload={"contract_id": str(contract.id)},
                legal_significance=True,
                subject_type="contract",
                subject_id=str(contract.id),
            )

    warranty_transition = _assert_execution_transition("enter_warranty", contract.execution_status)
    contract.execution_status = warranty_transition.target
    contract.save(update_fields=["execution_status"])
    outbox.publish(
        Topic.CONTRACT_WARRANTY_STARTED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={"parties": parties, "occurred_at": now.isoformat()},
        actor={},
    )
    deadlines_services.create_deadline(
        kind=_WARRANTY_DEADLINE_KIND,
        subject_type="contract",
        subject_id=contract.id,
        starts_from="event",
        anchor_at=now,
    )
    return contract


@transaction.atomic
def close_contract(contract: Contract) -> Contract:
    """`warranty -> closed` — по дате (sweep, `apps.contracts.handlers`,
    `kind=contract_warranty`). Не вызывается напрямую из api/ (нет ручного
    закрытия по датам — «по датам через sweep», etap-4.md Э4.6)."""
    transition = _assert_execution_transition("close_contract", contract.execution_status)
    contract.execution_status = transition.target
    contract.save(update_fields=["execution_status"])
    outbox.publish(
        Topic.CONTRACT_CLOSED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "parties": party_identity_snapshot(contract),
            "occurred_at": timezone.now().isoformat(),
        },
        actor={},
    )
    return contract


@transaction.atomic
def terminate_by_customer(contract: Contract, *, user: User, reason: str = "") -> Contract:
    """`POST /contracts/{id}/terminate-by-customer` — ЗАГЛУШКА эндпоинта
    (etap-4.md Э4.6: «расторжение — только заглушка эндпоинтов, полный
    контур — этап 7»): переход состояния БЕЗ расчёта по ADR-028 (принятые
    этапы + фактически выполненная часть + переданные материалы — этот
    расчёт появится вместе с полным контуром расторжения)."""
    get_party_for_user(contract, user)
    transition = _assert_execution_transition("terminate_by_customer", contract.execution_status)
    contract.execution_status = transition.target
    contract.save(update_fields=["execution_status"])
    _close_idle_deadlines(contract, outcome=_IDLE_OUTCOME_EXECUTION_FINISHED)
    outbox.publish(
        Topic.CONTRACT_TERMINATED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "parties": party_identity_snapshot(contract),
            "terminated_by": "customer",
            "reason": reason,
            "occurred_at": timezone.now().isoformat(),
        },
        actor={"user_id": str(user.id)},
    )
    return contract


@transaction.atomic
def terminate_by_contractor(contract: Contract, *, user: User, reason: str = "") -> Contract:
    """`POST /contracts/{id}/terminate-by-contractor` — та же заглушка, что
    `terminate_by_customer` (ADR-028: «не свободное право, требует
    основания» — здесь `reason` обязателен, но окно оспаривания основания
    ЕЩЁ не подключено, этап 7)."""
    if not reason.strip():
        raise TerminationReasonRequiredError("расторжение исполнителем требует основания (ADR-028)")
    get_party_for_user(contract, user)
    transition = _assert_execution_transition("terminate_by_contractor", contract.execution_status)
    contract.execution_status = transition.target
    contract.save(update_fields=["execution_status"])
    _close_idle_deadlines(contract, outcome=_IDLE_OUTCOME_EXECUTION_FINISHED)
    outbox.publish(
        Topic.CONTRACT_TERMINATED,
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "parties": party_identity_snapshot(contract),
            "terminated_by": "contractor",
            "reason": reason,
            "occurred_at": timezone.now().isoformat(),
        },
        actor={"user_id": str(user.id)},
    )
    return contract


# --- ADR-138: сделка без движения — учёт движения и автозакрытие -------------
#
# Движение = действие стороны: событие outbox с `actor.user_id` по любому
# семейству договорного контура (milestone.*, payment.*, dispute.*,
# evidence.*, message.*, amendment.*, negotiation.*, warranty.*, contract.*).
# Метку двигает подписчик `handlers.handle_contract_activity` (ключ «*»
# реестра OUTBOX_SUBSCRIBERS) — apps.contracts не импортирует чужих моделей,
# ему хватает `subject`/`payload.contract_id` события. Прямой вызов — только
# из собственных переходов (`start_execution`).


def _active_idle_deadlines(contract: Contract) -> Any:  # noqa: ANN401
    return deadlines_selectors.list_active_for_subject(
        subject_type="contract", subject_id=contract.id
    ).filter(kind__in=_IDLE_DEADLINE_KINDS)


def _close_idle_deadlines(contract: Contract, *, outcome: str) -> None:
    """Досрочно закрыть активные дедлайны idle (договор ушёл из `in_progress`
    либо появилось движение, снявшее отсрочку). Без события: срабатывания
    не было (`deadlines_services.close_deadline`)."""
    for deadline in _active_idle_deadlines(contract):
        deadlines_services.close_deadline(deadline, outcome=outcome)


def _schedule_idle_deadline(contract: Contract, *, at: datetime) -> None:
    """Завести либо перенести `contract_idle` от момента `at`. Одна СТРОКА
    на договор: перенос — `reschedule_deadline` (обновление `anchor_at`/
    `deadline_at`), не новая строка на каждое сообщение в чате. Активная
    отсрочка (`contract_idle_retry`) движением снимается — незавершённое
    действие, ради которого её давали, стороны, судя по движению, ведут.
    Серия предупреждений обеим сторонам перепланируется от нового отсчёта."""
    main: Any = None
    for deadline in _active_idle_deadlines(contract):
        if deadline.kind == IDLE_RETRY_DEADLINE_KIND:
            deadlines_services.close_deadline(deadline, outcome=_IDLE_OUTCOME_ACTIVITY)
        elif main is None:
            main = deadline
    if main is None:
        main = deadlines_services.create_deadline(
            kind=IDLE_DEADLINE_KIND,
            subject_type="contract",
            subject_id=contract.id,
            starts_from="event",
            anchor_at=at,
        )
    else:
        deadlines_services.reschedule_deadline(main, anchor_at=at)
    notifications_services.replan_reminder_series(main, recipients=party_users(contract))


@transaction.atomic
def record_contract_activity(contract: Contract, *, at: datetime) -> Contract:
    """Учесть движение по договору в момент `at` (ADR-138 §1). Монотонно и
    идемпотентно: более ранняя или та же метка — NOOP (реле доставляет
    at-least-once и не гарантирует порядок между темами). Дедлайн idle
    ведётся ТОЛЬКО в `in_progress`: у согласования и подписания свои
    тайм-ауты (`signature_request_expiry`), у гарантии — свой срок
    (`contract_warranty`), `pending_start` до гейта первого листа не
    тикает (см. ADR-138 «Открытые вопросы»)."""
    if contract.last_activity_at >= at:
        return contract
    contract.last_activity_at = at
    contract.save(update_fields=["last_activity_at"])
    if contract.execution_status == _EXECUTION.IN_PROGRESS:
        _schedule_idle_deadline(contract, at=at)
    return contract


def _pending_actions(contract: Contract) -> dict[str, int]:
    """Незавершённые действия сторон, откладывающие автозакрытие (ADR-138
    §3): число этапов по блокирующим статусам. Пустой словарь — препятствий
    нет."""
    counts: dict[str, int] = {}
    for status in _IDLE_BLOCKING_MILESTONE_STATUSES:
        n = contract.milestones.filter(status=status).count()
        if n:
            counts[status] = n
    return counts


@transaction.atomic
def auto_close_idle_contract(contract: Contract, *, deadline: Any) -> Contract:  # noqa: ANN401
    """Срабатывание `contract_idle`/`contract_idle_retry` (свип ->
    `handlers.handle_deadline_fired`). Actor — система (пустой, как у
    `finalize_acceptance(auto=True)`).

    Порядок проверок:
    1. договор уже не `in_progress` — NOOP (повторная доставка события,
       ADR-064; либо договор завершился/расторгнут раньше свипа);
    2. движение после отсчёта сработавшего дедлайна (гонка: свип успел
       выстрелить, а `record_contract_activity` — перенести/пересоздать
       строку) — NOOP, исход `stale`;
    3. есть незавершённые действия сторон (этап на приёмке / принят, но не
       оплачен) — отсрочка `contract_idle_retry` от «сейчас» + событие
       `contract.idle_blocked` обеим сторонам, исход `postponed`;
    4. иначе `in_progress -> closed` (`auto_close_idle`) + событие
       `contract.auto_closed` (reason=idle, idle_days) обеим сторонам.
    Отдельно `contract.closed` НЕ публикуется: тот топик означает «гарантийный
    срок истёк» (текст уведомления, ADR-126 §4 «один момент — одно
    уведомление»); потребители «договор окончен» (Э6 хранение, ADR-137)
    слушают `contract.auto_closed` рядом с `completed/closed/terminated`."""
    if contract.execution_status != _EXECUTION.IN_PROGRESS:
        return contract
    if deadline.anchor_at is not None and contract.last_activity_at > deadline.anchor_at:
        deadline.outcome = _IDLE_OUTCOME_STALE
        deadline.save(update_fields=["outcome"])
        return contract
    now = timezone.now()
    idle_days = (now - contract.last_activity_at).days
    parties = party_identity_snapshot(contract)
    pending = _pending_actions(contract)
    if pending:
        retry = deadlines_services.create_deadline(
            kind=IDLE_RETRY_DEADLINE_KIND,
            subject_type="contract",
            subject_id=contract.id,
            starts_from="event",
            anchor_at=now,
        )
        deadline.outcome = _IDLE_OUTCOME_POSTPONED
        deadline.save(update_fields=["outcome"])
        retry_days = (retry.deadline_at - now).days if retry.deadline_at is not None else 0
        outbox.publish(
            "contract.idle_blocked",
            subject={"type": "contract", "id": str(contract.id)},
            payload={
                "contract_id": str(contract.id),
                "idle_days": idle_days,
                "retry_days": retry_days,
                "pending": pending,
                "retry_deadline_at": (
                    retry.deadline_at.isoformat() if retry.deadline_at is not None else None
                ),
                "parties": parties,
                "occurred_at": now.isoformat(),
            },
            actor={},
        )
        return contract

    transition = _assert_execution_transition("auto_close_idle", contract.execution_status)
    contract.execution_status = transition.target
    contract.save(update_fields=["execution_status"])
    deadline.outcome = _IDLE_OUTCOME_AUTO_CLOSED
    deadline.save(update_fields=["outcome"])
    _close_idle_deadlines(contract, outcome=_IDLE_OUTCOME_EXECUTION_FINISHED)
    outbox.publish(
        "contract.auto_closed",
        subject={"type": "contract", "id": str(contract.id)},
        payload={
            "contract_id": str(contract.id),
            "reason": "idle",
            "idle_days": idle_days,
            "last_activity_at": contract.last_activity_at.isoformat(),
            "parties": parties,
            "occurred_at": now.isoformat(),
        },
        actor={},
    )
    return contract
