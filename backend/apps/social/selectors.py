"""Read-слой apps.social."""

from __future__ import annotations

from typing import Any

from django.db.models import Q, QuerySet
from django.db.models.functions import Collate
from django.http import Http404
from django.shortcuts import get_object_or_404

from apps.accounts.models import User

from .models import (
    AddressableGroup,
    Consent,
    Contact,
    GroupMembership,
    GroupPortfolioPhoto,
    GroupPortfolioProject,
    Handle,
)


def get_active_handle_or_404(value: str) -> Handle:
    return get_object_or_404(Handle, value=value.strip().lstrip("@").lower(), is_active=True)


def get_active_handle_for_user(user: User) -> Handle | None:
    """Текущий активный хендл пользователя (или `None`, если ещё не назначен —
    свежий GLOBAL-аккаунт до шага «Профиль»). Композируется в `GET /v1/users/me`
    (apps.accounts) через `settings.USER_ME_HANDLE_SELECTOR` + `import_string` —
    тот же приём, что уже применён для `apps.profiles` в
    `UserMeSerializer.get_profiles` (import-linter: apps.accounts не может
    импортировать apps.social напрямую, docs/tasks/
    Задача_fix_web-profile-handle-real-api.md)."""
    return Handle.objects.filter(user=user, is_active=True).first()


def list_contacts(owner: User) -> QuerySet[Contact]:
    """Граф доверия приватен: список — ТОЛЬКО собственные рёбра владельца
    (tech-spec.md §8.1b: чужие рёбра невидимы, не просто скрыты полем)."""
    return Contact.objects.filter(owner=owner).order_by("-created_at")


def get_contact_or_404(owner: User, contact_id: Any) -> Contact:
    """Скоуп по owner прямо в запросе — чужой контакт по id даёт 404, а не
    403 (etap-3.md 3.3, приватность графа)."""
    return get_object_or_404(Contact, pk=contact_id, owner=owner)


def list_public_groups() -> QuerySet[AddressableGroup]:
    return AddressableGroup.objects.filter(is_public=True).order_by("name")


def get_group_or_404(group_id: Any) -> AddressableGroup:
    return get_object_or_404(AddressableGroup, pk=group_id)


def get_visible_group_or_404(group_id: Any, *, viewer: User | None) -> AddressableGroup:
    """ADR-117 §6: аноним видит только публичные объединения; чужое
    приватное — 404, не 403 (как чужие контакты — существование не
    раскрывается). Авторизованный видит любое (приглашённому нужно видеть
    закрытое объединение до вступления)."""
    group = get_object_or_404(AddressableGroup, pk=group_id)
    if viewer is None and not group.is_public:
        raise Http404("объединение не найдено")
    return group


def list_user_public_groups(user: User) -> list[AddressableGroup]:
    """ADR-117 §7: блок «состоит в объединениях» публичной карточки —
    только АКТИВНЫЕ членства в ПУБЛИЧНЫХ объединениях (членство в закрытом
    на публичную карточку не попадает по построению)."""
    return list(
        AddressableGroup.objects.filter(
            is_public=True,
            memberships__member=user,
            memberships__status=GroupMembership.Status.ACTIVE,
        ).order_by("name")
    )


def get_membership_or_404(group: AddressableGroup, member_id: Any) -> GroupMembership:
    return get_object_or_404(GroupMembership, group=group, member_id=member_id)


def active_group_handle(group: AddressableGroup) -> Handle | None:
    return Handle.objects.filter(group=group, is_active=True).first()


def list_group_members(group: AddressableGroup) -> QuerySet[GroupMembership]:
    """Участники и заявки — свежие сверху; вышедшие не показываются."""
    return (
        GroupMembership.objects.filter(group=group)
        .exclude(status=GroupMembership.Status.LEFT)
        .select_related("member")
        .order_by("-joined_at", "-id")
    )


def my_membership(group: AddressableGroup, user: User) -> GroupMembership | None:
    return GroupMembership.objects.filter(group=group, member=user).first()


def group_logo_url(group: AddressableGroup, *, size: int = 256) -> str | None:
    """`logo_url` для сериализаторов (ADR-117 §8): None — логотипа нет.
    `v` — cache-buster (хвост logo_key, uuid7 загрузки), как avatar_url
    (apps/profiles/selectors.py); подписи `t` нет — логотип виден ровно
    тем, кому видна сама карточка объединения."""
    if not group.logo_key:
        return None
    from django.urls import reverse

    base = reverse("group-logo", kwargs={"group_id": group.id})
    version = group.logo_key.rsplit("/", 1)[-1][:12]
    return f"{base}?size={size}&v={version}"


def list_group_portfolio_projects(group: AddressableGroup) -> list[GroupPortfolioProject]:
    """Витрина работ объединения (ADR-128) — порядок из модели
    (`order`, свежие сверху при равном order); фото подтягиваем сразу,
    сериализатор отдаёт галерею каждым проектом."""
    return list(group.portfolio_projects.prefetch_related("photos"))


def get_group_portfolio_project_or_404(
    group: AddressableGroup, project_id: Any
) -> GroupPortfolioProject:
    """Скоуп по объединению прямо в запросе: проект ЧУЖОГО объединения по id
    даёт 404, а не 403 (приём get_contact_or_404) — id не должен работать
    как оракул принадлежности."""
    return get_object_or_404(GroupPortfolioProject, pk=project_id, group=group)


def get_group_portfolio_photo_or_404(
    project: GroupPortfolioProject, photo_id: Any
) -> GroupPortfolioPhoto:
    """Фото строго внутри проекта из URL (ADR-120 §2: чужой id → 404)."""
    return get_object_or_404(GroupPortfolioPhoto, pk=photo_id, project=project)


def group_portfolio_photo_url(photo: GroupPortfolioPhoto, *, size: int = 1280) -> str:
    """Относительный путь под /v1 (как `group_logo_url`); `v` — cache-buster
    из хвоста ключа (uuid7 загрузки), URL версионирован — кэш долгий."""
    from django.urls import reverse

    base = reverse(
        "group-portfolio-photo-item",
        kwargs={
            "group_id": photo.project.group_id,
            "project_id": photo.project_id,
            "photo_id": photo.id,
        },
    )
    version = photo.photo_key.rsplit("/", 1)[-1][:12]
    return f"{base}?size={size}&v={version}"


def can_manage_group(group: AddressableGroup, user: User) -> bool:
    """Активная роль leader/admin (единый рубеж: services._assert_can_manage
    и фильтрация заявок в GET /groups/{id}/members, ADR-117 §6)."""
    return GroupMembership.objects.filter(
        group=group,
        member=user,
        status=GroupMembership.Status.ACTIVE,
        role__in=[GroupMembership.Role.LEADER, GroupMembership.Role.ADMIN],
    ).exists()


def search_groups(query: str, *, limit: int = 20) -> list[AddressableGroup]:
    """Поиск объединений по имени (подстрока) и хендлу (префикс, с «@» или
    без) — отсмотр 2026-08-23. Только публичные витрины (is_public)."""
    normalized = query.strip().lstrip("@").lower()
    if len(normalized) < 2:
        return []
    # Collate(..., "C") — та же ICU-ловушка, что в search_handles выше.
    by_handle = (
        Handle.objects.annotate(value_c=Collate("value", "C"))
        .filter(is_active=True, group__isnull=False, value_c__startswith=normalized)
        .values_list("group_id", flat=True)
    )
    return list(
        AddressableGroup.objects.filter(is_public=True)
        .filter(Q(name__icontains=query.strip()) | Q(id__in=list(by_handle)))
        .order_by("name")[: max(1, min(limit, 50))]
    )


def search_groups_by_sphere(
    sphere_codes: list[str], *, zone: str, country: str, city: str, limit: int = 20
) -> list[AddressableGroup]:
    """Публичные объединения по сфере каталога (ADR-121, поиск по сферам) с
    учётом географии объединения (ADR-117 §3): `world`-объединение видно из
    любой зоны; `country` — при совпадении страны зрителя (зоны country/city);
    `city` — при совпадении города (зона city) или страны (зона country).
    Зона `world` не фильтрует."""
    if not sphere_codes:
        return []
    qs = AddressableGroup.objects.filter(is_public=True, sphere_code__in=sphere_codes)
    if zone == "country":
        qs = qs.filter(
            Q(geo_scope=AddressableGroup.GeoScope.WORLD) | Q(country_code__iexact=country)
        )
    elif zone == "city":
        qs = qs.filter(
            Q(geo_scope=AddressableGroup.GeoScope.WORLD)
            | Q(geo_scope=AddressableGroup.GeoScope.COUNTRY, country_code__iexact=country)
            | Q(geo_scope=AddressableGroup.GeoScope.CITY, city_name__iexact=city)
        )
    return list(qs.order_by("name")[: max(1, min(limit, 50))])


def latest_consents(user: User) -> dict[str, Consent]:
    """Последнее (по granted_at) согласие каждого типа — Consent история не
    схлопывается в таблице, схлопываем при чтении."""
    result: dict[str, Consent] = {}
    for consent in Consent.objects.filter(user=user).order_by("consent_type", "-granted_at"):
        result.setdefault(consent.consent_type, consent)
    return result


def is_privacy_step_complete(user: User) -> bool:
    """docs/tasks/etap-3-delta-adr059.md §2 тест 2: регистрация не
    завершена, пока не сделан явный выбор по всем трём согласиям
    (pd_processing должно быть granted=True — без него платформой пользоваться
    нельзя; profile_public/phone_discoverability — любое явное значение)."""
    consents = latest_consents(user)
    required = {
        Consent.ConsentType.PD_PROCESSING,
        Consent.ConsentType.PROFILE_PUBLIC,
        Consent.ConsentType.PHONE_DISCOVERABILITY,
    }
    if not required.issubset(consents.keys()):
        return False
    return consents[Consent.ConsentType.PD_PROCESSING].value is True


def is_global_privacy_step_complete(user: User) -> bool:
    """Аналог is_privacy_step_complete для стартового пакета GLOBAL (ГВ.2,
    docs/tasks/global-wave.md, ADR-071) — те же три + четвёртое
    (reputation_history_basis)."""
    consents = latest_consents(user)
    required = {
        Consent.ConsentType.PD_PROCESSING,
        Consent.ConsentType.PROFILE_PUBLIC,
        Consent.ConsentType.PHONE_DISCOVERABILITY,
        Consent.ConsentType.REPUTATION_HISTORY_BASIS,
    }
    if not required.issubset(consents.keys()):
        return False
    return consents[Consent.ConsentType.PD_PROCESSING].value is True


# --- префикс-поиск хендлов (GET /v1/handles?q=) ------------------------------
# Выбор контрагента в мастере создания договора (docs/tasks/
# audit-web-api-contract-sweep-report.md «Handle-поиск контрагента»): фронту
# нужен узкий лукап по префиксу, НЕ полнотекст и НЕ соц-граф.

#: Хендл — 3–32 символа (services._HANDLE_RE); осмысленный префикс — от 2.
#: Короче — пустой список, а не 400: строка ввода растёт по символу, и 400 на
#: первом же нажатии клавиши — не ошибка пользователя, а нормальное состояние
#: набора.
HANDLE_SEARCH_MIN_PREFIX = 2
HANDLE_SEARCH_DEFAULT_LIMIT = 20
HANDLE_SEARCH_MAX_LIMIT = 50


def search_handles(
    *,
    prefix: str,
    viewer: User,
    limit: int = HANDLE_SEARCH_DEFAULT_LIMIT,
    include_viewer: bool = False,
) -> list[Handle]:
    """Префикс-поиск активных хендлов ПОЛЬЗОВАТЕЛЕЙ для выбора стороны сделки.

    Границы выдачи (каждая — доменная, не косметика):
    - только `user`-хендлы: AddressableGroup — витрина, НЕ сторона договора
      (tech-spec.md §5.2.1b), её выбор контрагентом всё равно отвергнет
      `apps.contracts.services` (CounterpartyIsGroupError);
    - только `discoverable_by_handle=True` — единственный флаг находимости по
      хендлу (apps.accounts.models.User, etap-3.md 3.3); согласия 152-ФЗ его
      не покрывают (хендл публичен по своей природе);
    - без забаненных/неактивных — договор с ними всё равно не заключить;
    - без самого себя (контрагент — это ДРУГАЯ сторона), КРОМЕ
      include_viewer=True: общий поиск /search (apps.dashboards) обязан
      находить и владельца — «ввожу свой хендл — не работает» был первым
      репро бага поиска (отсмотр 2026-08-24).
    """
    normalized = prefix.strip().lstrip("@").lower()
    if len(normalized) < HANDLE_SEARCH_MIN_PREFIX:
        return []
    capped = max(1, min(limit, HANDLE_SEARCH_MAX_LIMIT))
    # Collate(..., "C") обязателен: Handle.value лежит под НЕдетерминированной
    # ICU-коллацией "case_insensitive" (migrations/0001_initial), а Postgres
    # запрещает по такой LIKE («nondeterministic collations are not supported
    # for LIKE») — и istartswith, и startswith упали бы на живой БД.
    # Регистронезависимость от этого не теряется: хендл нормализуется в нижний
    # регистр при выдаче (services._normalize_handle), префикс — здесь, выше.
    qs = (
        Handle.objects.select_related("user")
        .annotate(value_c=Collate("value", "C"))
        .filter(
            is_active=True,
            value_c__startswith=normalized,
            user__isnull=False,
            user__is_active=True,
            user__is_banned=False,
            user__discoverable_by_handle=True,
        )
    )
    if not include_viewer:
        qs = qs.exclude(user_id=viewer.pk)
    return list(qs.order_by("value")[:capped])
