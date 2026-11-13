"""Use cases apps.social (tech-spec.md §5.2.1b, §7.2, §8.1b; domain-model.md
§3.6; docs/tasks/etap-3.md 3.3; docs/tasks/etap-3-delta-adr059.md — дельта
первична при расхождении с etap-3.md).

Границы (CLAUDE.md, import-linter): apps.social зависит ТОЛЬКО от
apps.accounts. Согласие profile_public НЕ дёргает apps.profiles напрямую —
публикуется в outbox (topic="social.consent_recorded"), apps.profiles сам
подписан и реагирует (apps/profiles/subscriber.py), см. docstring models.py."""

from __future__ import annotations

import re
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from apps.accounts import services as accounts_services
from apps.accounts.models import User
from common import outbox
from common.crypto import encrypt_for_subject
from common.images import WEBP_CONTENT_TYPE, process_fit_webp, process_square_webp
from common.object_store import ObjectStore
from common.uuid7 import uuid7

from . import hashing, selectors
from .models import (
    AddressableGroup,
    Consent,
    Contact,
    GroupMembership,
    GroupPortfolioPhoto,
    GroupPortfolioProject,
    Handle,
    PhonebookHash,
)
from .storage import build_group_media_store, build_logo_store

_HANDLE_RE = re.compile(r"^[a-z0-9_]{3,32}$")


class InvalidHandleFormatError(ValueError):
    """Хендл — 3–32 символа: латиница нижнего регистра, цифры, подчёркивание."""


class HandleTakenError(ValueError):
    """Значение занято другим АКТИВНЫМ хендлом (смена освобождает старый —
    занятость проверяется только среди is_active=True)."""


class InvalidPhonebookHashError(ValueError):
    """Элемент списка — не хеш ожидаемого формата (в т.ч. сырой номер) или
    неподдерживаемая схема хеширования."""


class PdProcessingConsentRequiredError(ValueError):
    """Без согласия на обработку ПД (value=True) регистрация не может
    завершиться — не «отложено», а жёсткий отказ (152-ФЗ)."""


class GroupPermissionDeniedError(ValueError):
    """Действие над объединением доступно только leader/admin."""


class HandleRequiredForReputationLinkError(ValueError):
    """GET /users/me/reputation-link требует активный хендл — ссылка
    адресуется по @handle, не по trust_id (тот никогда не публикуется)."""


def _normalize_handle(value: str) -> str:
    normalized = value.strip().lstrip("@").lower()
    if not _HANDLE_RE.fullmatch(normalized):
        raise InvalidHandleFormatError(
            "хендл — 3–32 символа: латиница в нижнем регистре, цифры, подчёркивание"
        )
    return normalized


@transaction.atomic
def claim_handle(
    *, user: User | None = None, group: AddressableGroup | None = None, value: str
) -> Handle:
    """POST /users/me/handle (и внутренний путь для групп). Смена
    освобождает старый (is_active=False, история строкой — antifraud)."""
    assert (user is None) != (group is None), "хендл — либо пользователя, либо группы"
    normalized = _normalize_handle(value)

    conflict = Handle.objects.filter(value=normalized, is_active=True)
    conflict = conflict.exclude(user=user) if user is not None else conflict.exclude(group=group)
    if conflict.exists():
        raise HandleTakenError(f"@{normalized} уже занят")

    previous = Handle.objects.filter(user=user, group=group, is_active=True).first()
    if previous is not None:
        if previous.value == normalized:
            return previous
        previous.is_active = False
        previous.changed_at = timezone.now()
        previous.save(update_fields=["is_active", "changed_at"])

    return Handle.objects.create(user=user, group=group, value=normalized)


def add_contact(
    owner: User,
    *,
    target_user: User | None = None,
    target_phone_hash: str | None = None,
    source: str,
    display_name: str | None = None,
) -> Contact:
    """POST /users/me/contacts (manual/link — phonebook создаётся
    reconcile_phonebook, deal — этап 4)."""
    assert target_user is not None or target_phone_hash is not None, (
        "контакт должен ссылаться либо на пользователя, либо на хеш телефона"
    )
    encrypted_kwargs: dict[str, Any] = {}
    if display_name:
        encrypted = encrypt_for_subject(display_name, subject_type="user", subject_id=owner.id)
        encrypted_kwargs = {
            "display_name_encrypted": encrypted.ciphertext,
            "encryption_key_ref": encrypted.key_ref,
        }
    return Contact.objects.create(
        owner=owner,
        target_user=target_user,
        target_phone_hash=target_phone_hash,
        source=source,
        **encrypted_kwargs,
    )


def remove_contact(contact: Contact) -> None:
    """DELETE /users/me/contacts/{id}. Контакт — не юрзначимая сущность
    (личная адресная книга, не доказательная база) — обычное удаление,
    без ограничения CLAUDE.md на soft-delete юрзначимых сущностей."""
    contact.delete()


@transaction.atomic
def reconcile_phonebook(
    user: User, *, hashes: list[str], algorithm: str, salt_ref: str
) -> list[User]:
    """POST /users/me/phonebook (docs/tasks/etap-3-delta-adr059.md Р8):
    сверка ТОЛЬКО против discoverable_by_phone=True пользователей;
    несматченные хеши удаляются в ЭТОЙ ЖЕ транзакции — в БД не остаётся
    хешей лиц вне платформы или без согласия (тест 1 и 3 дельты §2).
    Совпадения материализуются как Contact(source=phonebook)."""
    if algorithm != hashing.ALGORITHM or salt_ref != hashing.SALT_REF:
        raise InvalidPhonebookHashError(
            f"неподдерживаемая схема хеширования: {algorithm}/{salt_ref}"
        )
    for value in hashes:
        if not hashing.is_valid_hash_format(value):
            raise InvalidPhonebookHashError(f"это не похоже на хеш: {value!r}")

    hash_set = set(hashes)
    PhonebookHash.objects.filter(user=user).exclude(phone_hash__in=hash_set).delete()
    for value in hash_set:
        PhonebookHash.objects.get_or_create(
            user=user,
            phone_hash=value,
            defaults={"algorithm": algorithm, "salt_ref": salt_ref},
        )

    def _hash_of(candidate: User) -> str:
        # queryset ниже уже отфильтровал phone__isnull=True/"" — mypy этого
        # не видит (фильтрация queryset непрозрачна для типов).
        assert candidate.phone
        return hashing.phone_hash(candidate.phone)

    candidates = (
        User.objects.filter(discoverable_by_phone=True)
        .exclude(pk=user.pk)
        .exclude(phone__isnull=True)
        .exclude(phone="")
    )
    matches = [c for c in candidates if _hash_of(c) in hash_set]
    matched_hashes = {_hash_of(c) for c in matches}

    # Несматченные (включая те, чей владелец с тех пор отозвал находимость)
    # удаляются — только что созданный набор сужается до совпавших.
    PhonebookHash.objects.filter(user=user).exclude(phone_hash__in=matched_hashes).delete()

    for match in matches:
        contact, _created = Contact.objects.get_or_create(
            owner=user,
            target_user=match,
            defaults={
                "target_phone_hash": _hash_of(match),
                "source": Contact.Source.PHONEBOOK,
            },
        )
        reverse_exists = Contact.objects.filter(owner=match, target_user=user).exists()
        if reverse_exists and not contact.is_mutual:
            Contact.objects.filter(pk=contact.pk).update(is_mutual=True)
            Contact.objects.filter(owner=match, target_user=user).update(is_mutual=True)

    return matches


# Локаль по умолчанию — RU-контур, поведение до ГВ.2 не меняется (ADR-071).
DEFAULT_CONSENT_LOCALE = "ru"


def _consent_text_version(consent_type: str, *, locale: str = DEFAULT_CONSENT_LOCALE) -> str:
    versions: dict[str, dict[str, str]] = settings.CONSENT_TEXT_VERSIONS
    per_type = versions.get(consent_type, {})
    return per_type.get(locale) or per_type.get(DEFAULT_CONSENT_LOCALE, "v1")


@transaction.atomic
def record_consent(
    user: User,
    *,
    consent_type: str,
    value: bool,
    locale: str = DEFAULT_CONSENT_LOCALE,
    device: str = "",
    ip: str | None = None,
) -> Consent:
    """Одно согласие = одна новая строка (история не перезаписывается,
    docs/tasks/etap-3-delta-adr059.md §1.2). text_version — из
    settings.CONSENT_TEXT_VERSIONS (сервер, не клиент); locale выбирает
    RU/EN версию текста (ГВ.2, ADR-071) и записывается на саму строку —
    какой язык реально видел пользователь (Л.2 п.5, docs/tasks/
    l10n-wave.md, ADR-077); сам текст согласия здесь по-прежнему не
    хранится, только его версия+язык."""
    consent = Consent.objects.create(
        user=user,
        consent_type=consent_type,
        value=value,
        text_version=_consent_text_version(consent_type, locale=locale),
        locale=locale,
        device=device,
        ip=ip,
    )
    if consent_type == Consent.ConsentType.PHONE_DISCOVERABILITY:
        accounts_services.set_phone_discoverability(user, value)
    outbox.publish(
        "social.consent_recorded",
        subject={"type": "user", "id": str(user.id)},
        payload={"consent_type": consent_type, "value": value},
        actor={"user_id": str(user.id)},
    )
    return consent


@transaction.atomic
def complete_privacy_step(
    user: User,
    *,
    pd_processing: bool,
    profile_public: bool,
    phone_discoverability: bool,
    device: str = "",
    ip: str | None = None,
) -> list[Consent]:
    """Шаг регистрации «Данные и приватность» (docs/tasks/
    etap-3-delta-adr059.md §1.1): ВСЕ ТРИ согласия обязательны и явные —
    сериализатор api/ уже требует их как required-поля без null, здесь —
    доменное правило поверх: без pd_processing=True регистрация не
    заканчивается вообще (жёсткий отказ, не пропуск шага)."""
    if not pd_processing:
        raise PdProcessingConsentRequiredError(
            "без согласия на обработку персональных данных использование платформы невозможно"
        )
    return [
        record_consent(
            user,
            consent_type=Consent.ConsentType.PD_PROCESSING,
            value=pd_processing,
            device=device,
            ip=ip,
        ),
        record_consent(
            user,
            consent_type=Consent.ConsentType.PROFILE_PUBLIC,
            value=profile_public,
            device=device,
            ip=ip,
        ),
        record_consent(
            user,
            consent_type=Consent.ConsentType.PHONE_DISCOVERABILITY,
            value=phone_discoverability,
            device=device,
            ip=ip,
        ),
    ]


@transaction.atomic
def complete_global_privacy_step(
    user: User,
    *,
    pd_processing: bool,
    profile_public: bool,
    phone_discoverability: bool,
    reputation_history_basis: bool,
    device: str = "",
    ip: str | None = None,
) -> list[Consent]:
    """Стартовый пакет согласий GLOBAL (ГВ.2, docs/tasks/global-wave.md,
    ADR-071) — те же три, что complete_privacy_step (RU, etap-3-delta-adr059
    §1.1), + четвёртое (история сделок как основа репутации, ГВ.4), все
    четыре — locale="en" (тексты-болванки EN до Ю-23). Не переиспользует
    complete_privacy_step: сигнатуры разные (4 обязательных поля против 3),
    RU-флоу остаётся нетронутым отдельной функцией — не общим параметром
    "locale"/"consents", чтобы не давать возможности случайно запросить
    RU-регистрацию без обязательного четвёртого согласия или наоборот."""
    if not pd_processing:
        raise PdProcessingConsentRequiredError(
            "без согласия на обработку персональных данных использование платформы невозможно"
        )
    consent_values = {
        Consent.ConsentType.PD_PROCESSING: pd_processing,
        Consent.ConsentType.PROFILE_PUBLIC: profile_public,
        Consent.ConsentType.PHONE_DISCOVERABILITY: phone_discoverability,
        Consent.ConsentType.REPUTATION_HISTORY_BASIS: reputation_history_basis,
    }
    return [
        record_consent(
            user, consent_type=consent_type, value=value, locale="en", device=device, ip=ip
        )
        for consent_type, value in consent_values.items()
    ]


def build_reputation_link(user: User) -> str:
    """GET /users/me/reputation-link — заглушка-URL (etap-3.md 3.3: полноценная
    публичная карточка репутации — более поздний этап). Адресуется по
    @handle, НИКОГДА по trust_id (тот не публикуется — apps.accounts)."""
    handle = Handle.objects.filter(user=user, is_active=True).first()
    if handle is None:
        raise HandleRequiredForReputationLinkError(
            "нужен активный @handle, чтобы поделиться ссылкой"
        )
    return f"{settings.PUBLIC_WEB_BASE_URL.rstrip('/')}/@{handle.value}"


class InvalidGroupSphereError(ValueError):
    """Сфера объединения обязательна и должна быть активным кодом каталога
    (ADR-117 §2; проверка через settings.GROUP_SPHERE_EXISTS_SELECTOR)."""


class InvalidGroupGeoError(ValueError):
    """ADR-117 §3: geo_scope=country требует country_code, city — оба."""


def _validate_sphere_code(sphere_code: str) -> str:
    normalized = sphere_code.strip()
    exists = import_string(settings.GROUP_SPHERE_EXISTS_SELECTOR)
    if not normalized or not exists(normalized):
        raise InvalidGroupSphereError(f"неизвестная сфера каталога: {sphere_code!r}")
    return normalized


def _validate_geo(geo_scope: str, country_code: str, city_name: str) -> None:
    if geo_scope == AddressableGroup.GeoScope.COUNTRY and not country_code:
        raise InvalidGroupGeoError("для географии «страна» нужен country_code")
    if geo_scope == AddressableGroup.GeoScope.CITY and not (country_code and city_name):
        raise InvalidGroupGeoError("для географии «город» нужны country_code и city_name")


@transaction.atomic
def create_group(
    leader: User,
    *,
    kind: str,
    name: str,
    handle: str,
    sphere_code: str,
    description: str = "",
    is_public: bool = True,
    join_policy: str = AddressableGroup.JoinPolicy.OPEN,
    reputation_mode: str = AddressableGroup.ReputationMode.AGGREGATE_ONLY,
    geo_scope: str = AddressableGroup.GeoScope.WORLD,
    country_code: str = "",
    city_name: str = "",
    links: list[dict[str, str]] | None = None,
) -> AddressableGroup:
    """ADR-117 §5: хендл — ОБЯЗАТЕЛЕН и клеймится в этой же транзакции
    («хендл создаётся при регистрации»); занят/кривой формат — вся
    регистрация объединения откатывается (HandleTakenError /
    InvalidHandleFormatError наружу)."""
    sphere = _validate_sphere_code(sphere_code)
    _validate_geo(geo_scope, country_code, city_name)
    group = AddressableGroup.objects.create(
        kind=kind,
        leader=leader,
        name=name,
        description=description,
        sphere_code=sphere,
        is_public=is_public,
        join_policy=join_policy,
        reputation_mode=reputation_mode,
        geo_scope=geo_scope,
        country_code=country_code,
        city_name=city_name,
        links=links or [],
    )
    claim_handle(group=group, value=handle)
    GroupMembership.objects.create(
        group=group,
        member=leader,
        role=GroupMembership.Role.LEADER,
        status=GroupMembership.Status.ACTIVE,
        joined_at=timezone.now(),
    )
    return group


def _assert_can_manage(group: AddressableGroup, actor: User) -> None:
    if not selectors.can_manage_group(group, actor):
        raise GroupPermissionDeniedError("нужна активная роль leader/admin в объединении")


def update_group(group: AddressableGroup, actor: User, **fields: Any) -> AddressableGroup:
    _assert_can_manage(group, actor)
    update_fields = []
    if fields.get("sphere_code") is not None:
        fields["sphere_code"] = _validate_sphere_code(fields["sphere_code"])
    for field in (
        "name",
        "description",
        "is_public",
        "join_policy",
        "reputation_mode",
        "kind",
        "sphere_code",
        "geo_scope",
        "country_code",
        "city_name",
        "links",
    ):
        if fields.get(field) is not None:
            setattr(group, field, fields[field])
            update_fields.append(field)
    # Инвариант географии — по ИТОГОВОМУ состоянию (частичный PATCH может
    # прислать только geo_scope, а страна/город уже лежат на строке).
    _validate_geo(group.geo_scope, group.country_code, group.city_name)
    if update_fields:
        group.save(update_fields=update_fields)
    return group


def _notify_invited(group: AddressableGroup, actor: User, member: User) -> None:
    outbox.publish(
        "group.invited",
        subject={"type": "group", "id": str(group.id)},
        payload={"notify_user_id": str(member.id), "group_name": group.name},
        actor={"user_id": str(actor.id)},
    )


def invite_member(
    group: AddressableGroup, actor: User, member: User, *, role: str = GroupMembership.Role.MEMBER
) -> GroupMembership:
    _assert_can_manage(group, actor)
    membership, created = GroupMembership.objects.get_or_create(
        group=group,
        member=member,
        defaults={"role": role, "status": GroupMembership.Status.INVITED},
    )
    if created:
        _notify_invited(group, actor, member)
    return membership


def update_membership(
    group: AddressableGroup,
    actor: User,
    membership: GroupMembership,
    *,
    role: str | None = None,
    status: str | None = None,
) -> GroupMembership:
    _assert_can_manage(group, actor)
    update_fields = []
    if role is not None:
        membership.role = role
        update_fields.append("role")
    if status is not None:
        membership.status = status
        update_fields.append("status")
        if status == GroupMembership.Status.ACTIVE and membership.joined_at is None:
            membership.joined_at = timezone.now()
            update_fields.append("joined_at")
    if update_fields:
        membership.save(update_fields=update_fields)
    return membership


class LeaderCannotLeaveError(ValueError):
    """Лидер не выходит из объединения — сперва передача лидерства (v1: запрет)."""


class JoinRequestNotPendingError(ValueError):
    """approve/reject применим только к статусу requested."""


def join_group(group: AddressableGroup, user: User) -> GroupMembership:
    """POST /groups/{id}/join (отсмотр 2026-08-23): open → сразу участник;
    approval → заявка (requested) до решения лидера/админа. Приглашение
    (invited) этим же вызовом принимается. Идемпотентно для active."""
    membership = GroupMembership.objects.filter(group=group, member=user).first()
    now = timezone.now()
    if membership is not None and membership.status == GroupMembership.Status.ACTIVE:
        return membership
    if membership is not None and membership.status == GroupMembership.Status.INVITED:
        membership.status = GroupMembership.Status.ACTIVE
        membership.joined_at = now
        membership.save(update_fields=["status", "joined_at"])
        return membership
    target_status = (
        GroupMembership.Status.ACTIVE
        if group.join_policy == AddressableGroup.JoinPolicy.OPEN
        else GroupMembership.Status.REQUESTED
    )
    if membership is None:
        membership = GroupMembership.objects.create(
            group=group,
            member=user,
            role=GroupMembership.Role.MEMBER,
            status=target_status,
            joined_at=now if target_status == GroupMembership.Status.ACTIVE else None,
        )
    else:
        membership.status = target_status
        update_fields = ["status"]
        if target_status == GroupMembership.Status.ACTIVE:
            membership.joined_at = now
            update_fields.append("joined_at")
        membership.save(update_fields=update_fields)
    if target_status == GroupMembership.Status.REQUESTED:
        # Уведомление лидеру (payload.notify_user_id — social не может звать
        # place_notification напрямую: import-linter «social только accounts»).
        outbox.publish(
            "group.join_requested",
            subject={"type": "group", "id": str(group.id)},
            payload={"notify_user_id": str(group.leader_id), "group_name": group.name},
            actor={"user_id": str(user.id)},
        )
    return membership


def leave_group(group: AddressableGroup, user: User) -> GroupMembership | None:
    """POST /groups/{id}/leave — идемпотентно (нет членства/уже вышел — None).
    Лидер не выходит (LeaderCannotLeaveError): объединение без лидера —
    некому управлять; передача лидерства — следующая волна."""
    membership = GroupMembership.objects.filter(group=group, member=user).first()
    if membership is None or membership.status == GroupMembership.Status.LEFT:
        return membership
    if membership.role == GroupMembership.Role.LEADER:
        raise LeaderCannotLeaveError("лидер не может выйти из объединения")
    membership.status = GroupMembership.Status.LEFT
    membership.save(update_fields=["status"])
    return membership


def decide_join_request(
    group: AddressableGroup, actor: User, membership: GroupMembership, *, approve: bool
) -> GroupMembership:
    """POST /groups/{id}/requests/{membership_id}/approve|reject — только
    лидер/админ (тот же рубеж, что update_group)."""
    _assert_can_manage(group, actor)
    if membership.status != GroupMembership.Status.REQUESTED:
        raise JoinRequestNotPendingError("заявка уже решена или её не было")
    if approve:
        membership.status = GroupMembership.Status.ACTIVE
        membership.joined_at = timezone.now()
        membership.save(update_fields=["status", "joined_at"])
        outbox.publish(
            "group.request_approved",
            subject={"type": "group", "id": str(group.id)},
            payload={"notify_user_id": str(membership.member_id), "group_name": group.name},
            actor={"user_id": str(actor.id)},
        )
    else:
        membership.status = GroupMembership.Status.LEFT
        membership.save(update_fields=["status"])
    return membership


# --- логотип объединения (ADR-117 §8) ---------------------------------------

#: Те же размеры, что аватар (ADR-103): логотип живёт в тех же местах UI.
LOGO_SIZES: tuple[int, ...] = (256, 64)


class GroupLogoTooLargeError(ValueError):
    """Файл больше GROUP_LOGO_MAX_UPLOAD_BYTES (дефолт — лимит аватара)."""


def _logo_max_upload_bytes() -> int:
    return int(
        getattr(settings, "GROUP_LOGO_MAX_UPLOAD_BYTES", None)
        or settings.PROFILE_AVATAR_MAX_UPLOAD_BYTES
    )


def logo_object_key(logo_key: str, size: int) -> str:
    return f"{logo_key}/{size}.webp"


def _delete_logo_objects(logo_key: str, store: ObjectStore) -> None:
    for size in LOGO_SIZES:
        store.delete(logo_object_key(logo_key, size))


def set_group_logo(
    group: AddressableGroup, actor: User, *, content: bytes, store: ObjectStore | None = None
) -> AddressableGroup:
    """POST /groups/{id}/logo — лидер/админ. Исходник нормализуется
    (квадрат, WebP 256/64, без EXIF — common.images), старые объекты
    удаляются ПОСЛЕ успешной записи новых (как set_avatar, ADR-103):
    при сбое посередине объединение остаётся со старым логотипом."""
    _assert_can_manage(group, actor)
    if len(content) > _logo_max_upload_bytes():
        raise GroupLogoTooLargeError(f"файл больше {_logo_max_upload_bytes()} байт")
    variants = process_square_webp(
        content, sizes=LOGO_SIZES, max_pixels=settings.PROFILE_AVATAR_MAX_SOURCE_PIXELS
    )
    store = store or build_logo_store()

    new_key = f"group-logos/{group.id}/{uuid7()}"
    for size, body in variants.items():
        store.put(logo_object_key(new_key, size), body, content_type=WEBP_CONTENT_TYPE)

    old_key = group.logo_key
    group.logo_key = new_key
    group.save(update_fields=["logo_key"])
    if old_key:
        _delete_logo_objects(old_key, store)
    return group


def remove_group_logo(
    group: AddressableGroup, actor: User, *, store: ObjectStore | None = None
) -> AddressableGroup:
    """DELETE /groups/{id}/logo — идемпотентно; объекты удаляются физически."""
    _assert_can_manage(group, actor)
    if not group.logo_key:
        return group
    store = store or build_logo_store()
    old_key = group.logo_key
    group.logo_key = ""
    group.save(update_fields=["logo_key"])
    _delete_logo_objects(old_key, store)
    return group


def set_group_handle(group: AddressableGroup, actor: User, *, value: str) -> Handle:
    """POST /groups/{id}/handle — хендл объединения (отсмотр 2026-08-23:
    «у объединения есть свой хендл, по нему также можно искать»). Только
    лидер/админ; та же нормализация/уникальность, что у пользовательских
    (claim_handle с group=...)."""
    _assert_can_manage(group, actor)
    return claim_handle(group=group, value=value)


def remove_member(
    group: AddressableGroup, actor: User, membership: GroupMembership
) -> GroupMembership:
    return update_membership(group, actor, membership, status=GroupMembership.Status.LEFT)


# --- Портфолио объединения (ADR-128) ------------------------------------------
# Витрина работ объединения по образцу личного портфолио (ADR-115/ADR-120,
# apps.profiles): до 5 фото на проект, первое — основное, дата завершения
# обязательна, город опционален. Управляют ТОЛЬКО leader/admin — тот же рубеж
# `_assert_can_manage`, что у логотипа и настроек объединения.

#: Как у личного портфолио (ADR-120): большая для просмотра + миниатюра сетки,
#: аспект сохраняется (в отличие от квадратного логотипа).
GROUP_PORTFOLIO_SIZES: tuple[int, ...] = (1280, 320)

GROUP_PORTFOLIO_MAX_PHOTOS = 5

#: Часовой «поле не передавали» для PATCH: `None` у `started_at` — это ЗНАЧЕНИЕ
#: («снять дату начала»), поэтому отличить его от «не трогать» может только
#: отдельный сентинел (приём `_UNSET` в apps/profiles/services.py).
_PORTFOLIO_UNSET: Any = object()


class GroupPortfolioDatesInvalidError(ValueError):
    """Нет даты завершения либо дата начала позже неё (ADR-120 §3)."""


class GroupPortfolioPhotosLimitError(ValueError):
    """Больше GROUP_PORTFOLIO_MAX_PHOTOS фото на проект."""


class GroupPortfolioPhotoTooLargeError(ValueError):
    """Файл больше GROUP_PORTFOLIO_MAX_UPLOAD_BYTES (дефолт — лимит личного портфолио)."""


def _portfolio_max_upload_bytes() -> int:
    return int(
        getattr(settings, "GROUP_PORTFOLIO_MAX_UPLOAD_BYTES", None)
        or settings.PROFILE_PORTFOLIO_MAX_UPLOAD_BYTES
    )


def group_portfolio_object_key(image_key: str, size: int) -> str:
    return f"{image_key}/{size}.webp"


def _assert_portfolio_dates(started_at: Any, completed_at: Any) -> None:
    if completed_at is None:
        raise GroupPortfolioDatesInvalidError("нужна дата завершения проекта")
    if started_at is not None and started_at > completed_at:
        raise GroupPortfolioDatesInvalidError("дата начала позже даты завершения")


def _normalize_portfolio_sphere(sphere_code: str, group: AddressableGroup) -> str:
    """Пусто — берём сферу самого объединения (обычный случай: гильдия
    показывает работы по своему профилю); иначе код обязан быть активной
    сферой каталога (тот же `GROUP_SPHERE_EXISTS_SELECTOR`, ADR-117 §2)."""
    normalized = (sphere_code or "").strip()
    if not normalized:
        return group.sphere_code
    return _validate_sphere_code(normalized)


@transaction.atomic
def create_group_portfolio_project(
    group: AddressableGroup,
    actor: User,
    *,
    title: str,
    description: str = "",
    sphere_code: str = "",
    started_at: Any = None,
    completed_at: Any = None,
    location_label: str = "",
) -> GroupPortfolioProject:
    """POST /groups/{id}/portfolio/projects — leader/admin."""
    _assert_can_manage(group, actor)
    _assert_portfolio_dates(started_at, completed_at)
    return GroupPortfolioProject.objects.create(
        group=group,
        title=title,
        description=description,
        sphere_code=_normalize_portfolio_sphere(sphere_code, group),
        started_at=started_at,
        completed_at=completed_at,
        location_label=location_label,
    )


@transaction.atomic
def update_group_portfolio_project(
    project: GroupPortfolioProject,
    actor: User,
    *,
    title: str | None = None,
    description: str | None = None,
    sphere_code: str | None = None,
    started_at: Any = _PORTFOLIO_UNSET,
    completed_at: Any = None,
    location_label: str | None = None,
    order: int | None = None,
) -> GroupPortfolioProject:
    """PATCH /groups/{id}/portfolio/projects/{project_id} — leader/admin.
    `started_at=None` явно снимает дату начала (_PORTFOLIO_UNSET — не трогать);
    `completed_at` снять нельзя (обязательна, как в ADR-120 §3)."""
    _assert_can_manage(project.group, actor)
    update_fields: list[str] = []
    if sphere_code is not None:
        project.sphere_code = _normalize_portfolio_sphere(sphere_code, project.group)
        update_fields.append("sphere_code")
    for field, value in (
        ("title", title),
        ("description", description),
        ("completed_at", completed_at),
        ("location_label", location_label),
        ("order", order),
    ):
        if value is not None:
            setattr(project, field, value)
            update_fields.append(field)
    if started_at is not _PORTFOLIO_UNSET:
        project.started_at = started_at
        update_fields.append("started_at")
    _assert_portfolio_dates(project.started_at, project.completed_at)
    if update_fields:
        project.save(update_fields=update_fields)
    return project


@transaction.atomic
def delete_group_portfolio_project(
    project: GroupPortfolioProject,
    actor: User,
    *,
    store: ObjectStore | None = None,
) -> None:
    """DELETE /groups/{id}/portfolio/projects/{project_id} — leader/admin.
    Витрина не юрзначима (объединение не сторона договора), поэтому удаление
    физическое, вместе с байтами всех фото; восстановления нет."""
    _assert_can_manage(project.group, actor)
    keys = list(project.photos.values_list("photo_key", flat=True))
    project.delete()
    store = store or build_group_media_store()
    for key in keys:
        _delete_group_portfolio_variants(key, store)


def _store_group_portfolio_variants(
    group: AddressableGroup, content: bytes, store: ObjectStore
) -> str:
    """Санитария — common.images.process_fit_webp (EXIF в пиксели и прочь,
    первый кадр, порог decompression-bomb), WebP 1280/320 БЕЗ кропа."""
    if len(content) > _portfolio_max_upload_bytes():
        raise GroupPortfolioPhotoTooLargeError(f"файл больше {_portfolio_max_upload_bytes()} байт")
    variants = process_fit_webp(
        content,
        sizes=GROUP_PORTFOLIO_SIZES,
        max_pixels=settings.PROFILE_AVATAR_MAX_SOURCE_PIXELS,
    )
    new_key = f"group-portfolio/{group.id}/{uuid7()}"
    for size, body in variants.items():
        store.put(group_portfolio_object_key(new_key, size), body, content_type=WEBP_CONTENT_TYPE)
    return new_key


def _delete_group_portfolio_variants(key: str, store: ObjectStore) -> None:
    for size in GROUP_PORTFOLIO_SIZES:
        store.delete(group_portfolio_object_key(key, size))


def _sync_group_cover(project: GroupPortfolioProject) -> None:
    """`photo_key` — зеркало основного фото (photos[0]): пересчёт порядка без
    дыр + запись ключа обложки (приём `_sync_cover`, ADR-120)."""
    photos = list(project.photos.order_by("order", "created_at"))
    for index, photo in enumerate(photos):
        if photo.order != index:
            photo.order = index
            photo.save(update_fields=["order"])
    cover = photos[0].photo_key if photos else ""
    if project.photo_key != cover:
        project.photo_key = cover
        project.save(update_fields=["photo_key"])


@transaction.atomic
def add_group_portfolio_photo(
    project: GroupPortfolioProject,
    actor: User,
    *,
    content: bytes,
    store: ObjectStore | None = None,
) -> GroupPortfolioPhoto:
    """POST .../projects/{project_id}/photos — добавить фото в конец галереи;
    первое добавленное становится основным. Шестое —
    GroupPortfolioPhotosLimitError (409)."""
    _assert_can_manage(project.group, actor)
    if project.photos.count() >= GROUP_PORTFOLIO_MAX_PHOTOS:
        raise GroupPortfolioPhotosLimitError(
            f"не больше {GROUP_PORTFOLIO_MAX_PHOTOS} фото на проект"
        )
    store = store or build_group_media_store()
    new_key = _store_group_portfolio_variants(project.group, content, store)
    photo = GroupPortfolioPhoto.objects.create(
        project=project, photo_key=new_key, order=project.photos.count()
    )
    _sync_group_cover(project)
    return photo


@transaction.atomic
def remove_group_portfolio_photo(
    project: GroupPortfolioProject,
    actor: User,
    photo: GroupPortfolioPhoto,
    *,
    store: ObjectStore | None = None,
) -> GroupPortfolioProject:
    """DELETE .../photos/{photo_id} — объекты удаляются физически, следующее
    фото становится основным."""
    _assert_can_manage(project.group, actor)
    key = photo.photo_key
    photo.delete()
    _sync_group_cover(project)
    _delete_group_portfolio_variants(key, store or build_group_media_store())
    return project


@transaction.atomic
def set_primary_group_portfolio_photo(
    project: GroupPortfolioProject, actor: User, photo: GroupPortfolioPhoto
) -> GroupPortfolioProject:
    """POST .../photos/{photo_id}/primary — сделать основным (первым);
    остальные сдвигаются, относительный порядок сохраняется."""
    _assert_can_manage(project.group, actor)
    others = project.photos.exclude(pk=photo.pk).order_by("order", "created_at")
    photo.order = 0
    photo.save(update_fields=["order"])
    for index, other in enumerate(others, start=1):
        other.order = index
        other.save(update_fields=["order"])
    _sync_group_cover(project)
    return project


# --- Удаление аккаунта (ADR-169) -----------------------------------------


@transaction.atomic
def purge_personal_data(user_id: Any) -> None:  # noqa: ANN401
    """Уничтожение ПД apps.social при удалении аккаунта (DELETE /users/me,
    ADR-169). Вызывается через `settings.ACCOUNT_DELETION_PURGERS` +
    `import_string` — обратной статической зависимости apps.accounts ->
    apps.social не существует (import-linter, «social зависит только от
    accounts»), и заводить её нельзя.

    Удаляется:

    * `Contact` владельца — его личная адресная книга (не юрзначимая
      сущность, см. `remove_contact`). Подписи контактов зашифрованы ключом
      субъекта ("user", owner.id), который apps.accounts уже уничтожил, —
      но оставлять нечитаемые строки незачем, и после уничтожения ключа их
      всё равно некому прочесть.
    * `PhonebookHash` — необратимые хеши ЧУЖИХ номеров, загруженные этим
      человеком (152-ФЗ: это его выгрузка телефонной книги, и уходит она
      вместе с ним).
    * активный `Handle` гасится (`is_active=False`) — имя освобождается для
      других. История хендлов остаётся: она антифродовая (domain-model.md
      §3.6) и ПД не содержит.

    НЕ трогается:

    * `Contact`, где удаляемый — `target_user`: это чужая адресная книга,
      подписи в ней зашифрованы ключом ЕЁ владельца.
    * `Consent` — юридическое доказательство данного согласия (append-only,
      152-ФЗ); удалять его вместе с аккаунтом означало бы уничтожить
      доказательство законности уже совершённой обработки.
    * `AddressableGroup`, где человек был лидером: объединение принадлежит
      своим участникам, а не ему (смена лидера — отдельный сценарий).
    """
    Contact.objects.filter(owner_id=user_id).delete()
    PhonebookHash.objects.filter(user_id=user_id).delete()
    Handle.objects.filter(user_id=user_id, is_active=True).update(
        is_active=False, changed_at=timezone.now()
    )
