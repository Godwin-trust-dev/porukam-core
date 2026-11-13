"""Read-слой apps.dashboards (CLAUDE.md: «только selectors поверх остальных»;
docs/plan.md, этап 8: «чистые селекторы, каждый элемент с action-ссылкой»).

Минимальный дашборд запуска (ADR-090, docs/tasks/Задача_feat_dashboard-real-api.md):
ТОЛЬКО «что требует моего действия» (`attention`) — cross-cutting агрегация,
которой раньше нигде не было (ни `apps.contracts`, ни `apps.milestones` не
отдают такой срез готовым). «Мои сделки» на экране дашборда — НЕ здесь:
переиспользование уже реального `GET /v1/contracts` на фронте (ADR-090 §1 —
рассмотрено и отклонено дублировать `apps.contracts.api`/`realStatus.ts`
вторым агрегатом тех же данных под другим путём).

Прямой импорт `apps.contracts.selectors`/`apps.milestones.selectors` — не
`import_string` (ADR-090 §3: запрещающего import-linter-контракта в эту
сторону нет, `apps.dashboards` — верхний слой, обходить несуществующий
барьер незачем)."""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db.models import Case, IntegerField, Q, Value, When
from django.db.models.functions import Coalesce, Collate

from apps.accounts.models import User
from apps.catalog import search as catalog_search
from apps.catalog import selectors as catalog_selectors
from apps.contracts import selectors as contracts_selectors
from apps.l10n import selectors as l10n_selectors
from apps.milestones import selectors as milestones_selectors
from apps.milestones.models import Milestone
from apps.profiles import selectors as profiles_selectors
from apps.reputation import selectors as reputation_selectors


def _attention_items(user: User, owned_profile_ids: set[Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []

    for sr in contracts_selectors.list_pending_signature_requests_for_user(user):
        items.append(
            {
                "id": f"signature:{sr.id}",
                "kind": "signature",
                "side": sr.side,
                "contract_id": str(sr.contract_id),
                "title": sr.contract.title,
                "deadline_at": sr.expires_at,
            }
        )

    # acceptance/submission — сторона фиксирована самим смыслом действия
    # (принимает только CUSTOMER, сдаёт только CONTRACTOR, domain-model.md
    # §7/§7.1) — не читаем её из БД отдельно, она константна для секции.
    for milestone in milestones_selectors.list_awaiting_acceptance_for_profiles(owned_profile_ids):
        window = milestones_selectors.acceptance_window_status(milestone)
        items.append(
            {
                "id": f"acceptance:{milestone.id}",
                "kind": "acceptance",
                "side": "customer",
                "contract_id": str(milestone.contract_id),
                "title": milestone.title,
                "deadline_at": window["deadline_at"],
            }
        )

    for milestone in milestones_selectors.list_in_progress_for_profiles(owned_profile_ids):
        items.append(
            {
                "id": f"submission:{milestone.id}",
                "kind": "submission",
                "side": "contractor",
                "contract_id": str(milestone.contract_id),
                "title": milestone.title,
                "deadline_at": milestone.deadline,
            }
        )

    items.sort(key=lambda item: (item["deadline_at"] is None, item["deadline_at"]))
    return items


def get_dashboard(user: User) -> dict[str, Any]:
    """`GET /v1/dashboard` (ADR-090): единственная секция — `attention`."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    return {"attention": _attention_items(user, owned)}


def _leaf_context(user: User, owned: set[Any]) -> list[tuple[Any, Any, Any]]:
    """(лист, моя сторона, контрагент) по всем договорам в исполнении.

    Стороны берутся из батч-префетча `list_contracts_by_ids` — селектор
    листьев несёт только `select_related("contract")` без сторон, а
    `resolve_counterparty` на предзагруженном договоре в БД уже не ходит.

    Стороны считаются по ОДНОМУ разу на договор, а не на лист: у договора с
    пятью листьями фасад `resolve_counterparty` заново выводил бы «мои
    профили» (запрос) на каждый лист."""
    leaves = list(milestones_selectors.list_execution_leaves_for_profiles(owned))
    contracts = {
        contract.id: contract
        for contract in contracts_selectors.list_contracts_by_ids(
            {leaf.contract_id for leaf in leaves}
        )
    }
    sides: dict[Any, tuple[Any, Any]] = {}
    rows = []
    for leaf in leaves:
        if leaf.contract_id not in sides:
            contract = contracts[leaf.contract_id]
            sides[leaf.contract_id] = (
                next(p for p in contract.parties.all() if p.profile_id in owned),
                contracts_selectors.resolve_counterparty(contract, user),
            )
        mine, other = sides[leaf.contract_id]
        rows.append((leaf, mine, other))
    return rows


def _counterparty_avatars(rows: list[tuple[Any, Any, Any]], request: Any) -> dict[str, str | None]:
    """ADR-173: фото контрагентов раздела — по ОДНОМУ разрешению на профиль.
    Один и тот же контрагент стоит в десятке строк, а у `deals_only` проверка
    права зрителя ходит в БД (ADR-103); сами профили уже предзагружены
    батчем `list_contracts_by_ids` — второго запроса за ними нет."""
    avatars: dict[str, str | None] = {}
    for _leaf, _mine, other in rows:
        key = str(other.profile_id)
        if key not in avatars:
            avatars[key] = profiles_selectors.avatar_url_for_request(other.profile, request)
    return avatars


def _counterparty_block(party: Any, avatars: dict[str, str | None]) -> dict[str, Any]:
    return {
        "profile_id": str(party.profile_id),
        "display_name": profiles_selectors.public_display_name(party.profile),
        # ADR-173: фото — лид строки раздела; None = фото нет ИЛИ зрителю
        # нельзя (avatar_visibility=deals_only без завершённой сделки).
        "avatar_url": avatars.get(str(party.profile_id)),
    }


def get_stages(user: User, request: Any = None) -> dict[str, Any]:
    """`GET /v1/dashboard/stages` — раздел «Этапы» (отсмотр 2026-08-22):
    сводка листьев по всем моим договорам в исполнении. Ветки группируют,
    ЛИСТЬЯ принимаются/оплачиваются (domain-model.md §7.1) — сводка только
    по листьям. Сортировка: ближайший дедлайн первым, без дедлайна — в конце.

    `request` — зритель для фото контрагента (ADR-173); без него фото
    отдаётся только у профилей с `avatar_visibility=public`."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    rows = _leaf_context(user, owned)
    avatars = _counterparty_avatars(rows, request)
    items = [
        {
            "id": str(leaf.id),
            "contract_id": str(leaf.contract_id),
            "contract_title": leaf.contract.title,
            "title": leaf.title,
            "status": leaf.status,
            "amount": str(leaf.amount) if leaf.amount is not None else None,
            "amount_currency": leaf.amount_currency,
            "deadline": leaf.deadline,
            "side": mine.role,
            "counterparty": _counterparty_block(other, avatars),
        }
        for leaf, mine, other in rows
    ]
    items.sort(key=lambda item: (item["deadline"] is None, item["deadline"]))
    return {"items": items}


def _payment_state(leaf: Any) -> str:
    """Платёжное состояние листа для раздела /payments. Денег платформа не
    держит (финмодель v2) — состояние выводится из двусторонних
    подтверждений-заглушек (tech-spec.md §6.3): PAID либо обе отметки
    `paid_confirmed_*` = «оплачен»; принят, но отметок нет — «ждёт
    подтверждения оплаты»; остальное — «предстоит»."""
    both_confirmed = (
        leaf.paid_confirmed_by_customer_at is not None
        and leaf.paid_confirmed_by_contractor_at is not None
    )
    if leaf.status == Milestone.Status.PAID or both_confirmed:
        return "paid"
    if leaf.status == Milestone.Status.ACCEPTED:
        return "awaiting_confirmation"
    return "upcoming"


def get_payments(user: User, request: Any = None) -> dict[str, Any]:
    """`GET /v1/dashboard/payments` — раздел «Платежи» (отсмотр 2026-08-22):
    денежные листья моих договоров в исполнении с выведенным платёжным
    состоянием. Сортировка: ждущие подтверждения → предстоящие (по дедлайну)
    → оплаченные.

    `request` — зритель для фото контрагента (ADR-173)."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    order = {"awaiting_confirmation": 0, "upcoming": 1, "paid": 2}
    rows = _leaf_context(user, owned)
    avatars = _counterparty_avatars(rows, request)
    items = []
    for leaf, mine, other in rows:
        if leaf.amount is None:
            continue
        state = _payment_state(leaf)
        confirmed_field = (
            leaf.paid_confirmed_by_customer_at
            if mine.role == "customer"
            else leaf.paid_confirmed_by_contractor_at
        )
        counterparty_field = (
            leaf.paid_confirmed_by_contractor_at
            if mine.role == "customer"
            else leaf.paid_confirmed_by_customer_at
        )
        items.append(
            {
                "milestone_id": str(leaf.id),
                "contract_id": str(leaf.contract_id),
                "contract_title": leaf.contract.title,
                "milestone_title": leaf.title,
                "amount": str(leaf.amount),
                "amount_currency": leaf.amount_currency,
                "payment_method": leaf.contract.payment_method,
                "state": state,
                "paid_confirmed_by_me": confirmed_field is not None,
                "paid_confirmed_by_counterparty": counterparty_field is not None,
                "accepted_at": leaf.accepted_at,
                "deadline": leaf.deadline,
                "side": mine.role,
                "counterparty": _counterparty_block(other, avatars),
            }
        )
    items.sort(key=lambda item: (order[item["state"]], item["deadline"] is None, item["deadline"]))
    return {"items": items}


# --- Раздел «Поиск» (ADR-114, отсмотр 2026-08-23) ---------------------------
#
# Люди ищутся ТОЛЬКО по @хендлу и телефону: ФИО зашифровано envelope-
# encryption (crypto-shredding, CLAUDE.md) — поиска по имени нет BY DESIGN.
# Объединения — по имени и @хендлу (имя группы публичное). Гео-зоны v1:
# world | country | city — страна из User.country_code, город из
# Profile.city_name (строка); «округ» появится вместе с гео-справочником.

SEARCH_ZONES = ("world", "country", "city")


def _digits(query: str) -> str:
    return "".join(ch for ch in query if ch.isdigit())


def _viewer_geo(user: User) -> tuple[str, str]:
    profile = profiles_selectors.get_person_profile_for_user(user)
    city = (profile.city_name or "").strip() if profile else ""
    country = (user.country_code or "").strip()
    return city, country


def _resolve_zone(user: User, requested: str | None) -> tuple[str, str, str]:
    """(applied_zone, city, country): по умолчанию — самая узкая доступная
    зона зрителя (город → страна → мир); явный запрос сужается так же, если
    данных для него нет (город не заполнен и т.п.)."""
    city, country = _viewer_geo(user)
    zone = requested if requested in SEARCH_ZONES else None
    if zone is None:
        zone = "city" if city else ("country" if country else "world")
    if zone == "city" and not city:
        zone = "country" if country else "world"
    if zone == "country" and not country:
        zone = "world"
    return zone, city, country


def _people_item(profile: Any, handle_value: str | None) -> dict[str, Any]:
    return {
        "profile_id": str(profile.id),
        "handle": f"@{handle_value}" if handle_value else None,
        "display_name": profiles_selectors.public_display_name(profile),
        "city_name": profile.city_name or "",
    }


def _zone_match(profile: Any, *, zone: str, city: str, country: str) -> bool:
    if zone == "world":
        return True
    # ADR-121: «работаю удалённо / из любого города» = география «весь мир» у
    # человека (то же, что geo_scope=world у объединения, ADR-117 §3) — виден из
    # любой зоны, как world-объединение.
    if getattr(profile, "works_remotely", False):
        return True
    owner = profile.owner_user
    if zone == "country":
        return bool(owner and (owner.country_code or "").strip().lower() == country.lower())
    return (profile.city_name or "").strip().lower() == city.lower()


# Сколько сфер считать «совпавшими» с запросом: поиск по сфере — каталожная
# выдача, а не автодополнение; шире трёх — шум («ремонт» не должен тянуть
# все строительные сферы разом).
_SPHERE_HITS_LIMIT = 3


def _localized_name(name_i18n: dict[str, str], locale: str) -> str:
    """Тот же фолбэк, что apps.catalog.api.serializers.localized_name (api-слой
    чужого приложения из селектора не импортируем)."""
    return name_i18n.get(locale) or name_i18n.get("ru") or next(iter(name_i18n.values()), "")


def _match_spheres(query: str, *, locale: str) -> list[dict[str, str]]:
    """Сферы каталога, совпавшие с запросом (ADR-121): те же кандидаты и то
    же ранжирование, что у `GET /spheres?q=` (имена сфер на языке зрителя +
    ru, имена категорий чек-листов — «маникюр» → beauty). Пустой список —
    запрос не про сферу (хендл/телефон/имя объединения)."""
    spheres = list(catalog_selectors.list_active_spheres())
    pack_names = {} if locale == "ru" else l10n_selectors.get_catalog_map("spheres", locale=locale)
    category_labels = dict(l10n_selectors.get_catalog_map("categories", locale="ru"))
    if locale != "ru":
        category_labels.update(l10n_selectors.get_catalog_map("categories", locale=locale))
    grouped: dict[str, list[str]] = {}
    for key, text in category_labels.items():
        sphere_code, _, category_code = key.partition(".")
        if category_code:
            grouped.setdefault(sphere_code, []).append(text)
    candidates = [
        catalog_search.SphereCandidate(
            code=s.code,
            names=tuple(
                {name for name in s.name_i18n.values() if name}
                | ({pack_names[s.code]} if s.code in pack_names else set())
            ),
            category_names=tuple(grouped.get(s.code, ())),
        )
        for s in spheres
    ]
    by_code = {s.code: s for s in spheres}
    ranked = catalog_search.rank_spheres(query, candidates)[:_SPHERE_HITS_LIMIT]
    return [
        {
            "code": code,
            "name": pack_names.get(code) or _localized_name(by_code[code].name_i18n, locale),
        }
        for code in ranked
    ]


def get_search(
    user: User, *, query: str, zone: str | None = None, locale: str = "ru"
) -> dict[str, Any]:
    """`GET /v1/dashboard/search?q=&zone=` — люди (@хендл/телефон) +
    объединения (имя/@хендл). Каталожная находимость людей: hide_from_catalog
    уважается для хендл-поиска; находимость по телефону — ОТДЕЛЬНОЕ явное
    согласие (User.discoverable_by_phone), оно сильнее каталожного скрытия.

    Зона НЕ применяется к точным совпадениям (@хендл/телефон) — отсмотр
    2026-08-24: «ввожу хендл — программа должна найти». Хендл/номер — адрес,
    а не каталожная выдача: человек из другого города обязан находиться из
    любой зоны (первый репро бага: дефолтная зона «город» отсекала всех, у
    кого город пуст или другой). applied_zone в ответе остаётся — зону будет
    использовать каталожный поиск по сферам (ADR-114 v2). Себя тоже находим
    (include_viewer=True): проверка «найди меня» — базовый сценарий поиска.
    """
    from apps.social import selectors as social_selectors

    applied_zone, city, country = _resolve_zone(user, zone)
    people: list[dict[str, Any]] = []
    seen_profiles: set[Any] = set()

    digits = _digits(query)
    if len(digits) >= 10:
        tail = digits[-10:]
        # Collate(..., "C"): phone под ICU-коллацией — LIKE без неё запрещён.
        for candidate in (
            User.objects.annotate(phone_c=Collate("phone", "C"))
            .filter(
                phone_c__endswith=tail,
                discoverable_by_phone=True,
                is_active=True,
                is_banned=False,
            )
            .exclude(pk=user.pk)[:5]
        ):
            profile = profiles_selectors.get_person_profile_for_user(candidate)
            if profile is None or profile.id in seen_profiles:
                continue
            handle = social_selectors.get_active_handle_for_user(candidate)
            item = _people_item(profile, handle.value if handle else None)
            # Вариант А (2026-08-24): номера вводятся без SMS-верификации —
            # телефонное совпадение честно помечается «номер не подтверждён»,
            # пока не появится реальный SMS-провайдер.
            item["phone_unverified"] = True
            people.append(item)
            seen_profiles.add(profile.id)
    else:
        for handle in social_selectors.search_handles(
            prefix=query, viewer=user, limit=20, include_viewer=True
        ):
            if handle.user is None:  # search_handles отдаёт только user-хендлы
                continue
            profile = profiles_selectors.get_person_profile_for_user(handle.user)
            if profile is None or profile.id in seen_profiles:
                continue
            if profile.hide_from_catalog:
                continue
            people.append(_people_item(profile, handle.value))
            seen_profiles.add(profile.id)

    # ADR-121 (ADR-114 v2): «ищу мастера по маникюру в Москве — должна найти
    # мастеров, гильдии, кланы». Сфера резолвится из текста запроса, люди —
    # исполнители с завершёнными сделками в этой сфере (репутация на фактах),
    # объединения — по sphere_code; к ОБОИМ применяется зона (в отличие от
    # точных @хендл/телефон).
    spheres = _match_spheres(query, locale=locale) if len(digits) < 10 else []
    sphere_codes = [s["code"] for s in spheres]
    # Сначала факты (завершённые сделки в сфере), затем заявленные сферы
    # профиля (ADR-122) — с пометкой источника; дубли схлопнуты.
    candidates = [
        *(
            (pid, "deals")
            for pid in reputation_selectors.contractor_profile_ids_in_spheres(sphere_codes)
        ),
        *(
            (pid, "declared")
            for pid in profiles_selectors.profile_ids_with_declared_spheres(sphere_codes)
        ),
    ]
    for profile_id, via in candidates:
        if profile_id in seen_profiles:
            continue
        profile = profiles_selectors.get_profile_or_none(profile_id)
        if profile is None or not profiles_selectors.is_visible_in_catalog(profile):
            continue
        if profile.owner_user is None or not profile.owner_user.discoverable_by_handle:
            continue
        if not _zone_match(profile, zone=applied_zone, city=city, country=country):
            continue
        handle = social_selectors.get_active_handle_for_user(profile.owner_user)
        item = _people_item(profile, handle.value if handle else None)
        item["sphere_match"] = via
        people.append(item)
        seen_profiles.add(profile.id)

    def group_item(group: Any) -> dict[str, Any]:
        return {
            "id": str(group.id),
            "name": group.name,
            "kind": group.kind,
            "join_policy": group.join_policy,
            "handle": (
                f"@{h.value}" if (h := social_selectors.active_group_handle(group)) else None
            ),
            "members_count": group.memberships.filter(status="active").count(),
            "sphere_code": group.sphere_code,
        }

    groups: list[dict[str, Any]] = []
    seen_groups: set[Any] = set()
    for group in [
        *social_selectors.search_groups(query),
        *social_selectors.search_groups_by_sphere(
            sphere_codes, zone=applied_zone, country=country, city=city
        ),
    ]:
        if group.id in seen_groups:
            continue
        seen_groups.add(group.id)
        groups.append(group_item(group))

    return {"applied_zone": applied_zone, "profiles": people, "groups": groups, "spheres": spheres}


# --- Раздел «Поиск» — каталожный фильтр исполнителей (план 11.09 §5, ---
# ADR-184) ---------------------------------------------------------------
#
# Отдельная ветка выдачи `catalog` в том же ответе `GET /dashboard/search`
# (не замена `q`/`zone` выше — та адресная находимость по хендлу/телефону
# никуда не девается): гео на ЛЮБОМ уровне (страна/регион/город — WorkArea,
# ADR-182) без фильтра «весь мир», сферы каталога (ИЛИ внутри списка,
# заявленные ИЛИ подтверждённые завершённой сделкой), опыт — порог по числу
# завершённых сделок ИСПОЛНИТЕЛЕМ (apps.reputation). Фильтры между собой —
# И. keyset-пагинация по (created_at, id) — тот же приём, что
# apps.notifications.selectors.feed_for_recipient/
# apps.geo.selectors.list_cities.

CATALOG_PAGE_SIZE_DEFAULT = 20
CATALOG_PAGE_SIZE_MAX = 50


class InvalidCatalogCursorError(ValueError):
    """Курсор `catalog.next_cursor` не разбирается."""


# Группа сортировки в курсоре (владелец 18.09, ADR-193: «местные первыми»,
# ниже — «работают удалённо»). `none` — гео-фильтр не задан вовсе, группы
# нет (старое поведение, сортировка только по created_at/id). Курсор несёт
# группу ОБЯЗАТЕЛЬНО (даже "none"): без неё вторая страница не может
# восстановить, с какой стороны границы local/remote она находится —
# формат СТАЛ трёхчастным, старый двухчастный курсор (до этой ветки)
# больше не разбирается и явно 400-ится, как и любой другой нечитаемый
# курсор (тот же путь ошибки, что уже был у InvalidCatalogCursorError).
_CATALOG_CURSOR_GROUPS = ("local", "remote", "none")


def _encode_catalog_cursor(profile: Any, *, group: str) -> str:
    raw = f"{group}|{profile.created_at.isoformat()}|{profile.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_catalog_cursor(cursor: str) -> tuple[str, datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        group, _, rest = raw.partition("|")
        created_raw, _, id_raw = rest.partition("|")
        created_at = datetime.fromisoformat(created_raw)
        profile_id = UUID(id_raw)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise InvalidCatalogCursorError(cursor) from exc
    if group not in _CATALOG_CURSOR_GROUPS or created_at.tzinfo is None:
        raise InvalidCatalogCursorError(cursor)
    return group, created_at, profile_id


def _work_area_display(work_area: Any, *, locale: str) -> dict[str, Any] | None:
    """Тот же фолбэк отображения, что `WorkAreaSerializer.get_location`
    (`apps.profiles.api.serializers`) — api-слой чужого приложения из
    селектора не импортируем (тот же приём, что `_localized_name` выше).
    `None` — `scope=world` (показывать нечего)."""
    if work_area.scope == "country" and work_area.country_id:
        # Ключ `code`, а НЕ `country`: ровно та же форма, что у
        # `apps.geo.api.serializers.CountrySerializer` (и, через него, у
        # `/v1/profiles/{id}/work-areas`) — одно понятие не должно
        # называться в двух эндпоинтах по-разному.
        return {"code": work_area.country_id}
    if work_area.scope == "region" and work_area.region_id:
        region = work_area.region
        name_i18n: dict[str, str] = region.name_i18n or {}
        return {
            "code": f"{region.country_id}-{region.code}",
            "country": region.country_id,
            "display_name": name_i18n.get(locale) or region.name or region.name_latin,
        }
    if work_area.scope == "city" and work_area.city_id:
        city = work_area.city
        name_i18n = city.name_i18n or {}
        return {
            "id": city.id,
            "country": city.country_id,
            "region": (f"{city.region.country_id}-{city.region.code}" if city.region_id else None),
            "display_name": name_i18n.get(locale) or city.name or city.name_latin,
            "population": city.population,
        }
    return None


def _catalog_item(
    profile: Any, *, locale: str, request: Any, geo_match: str | None
) -> dict[str, Any]:
    from apps.social import selectors as social_selectors

    handle = social_selectors.get_active_handle_for_user(profile.owner_user)
    return {
        "profile_id": str(profile.id),
        "handle": f"@{handle.value}" if handle else None,
        "display_name": profiles_selectors.public_display_name(profile),
        "avatar_url": profiles_selectors.avatar_url_for_request(profile, request),
        "completed_deals_count": getattr(profile, "completed_deals_count", 0) or 0,
        "work_areas": [
            {"scope": wa.scope, "location": _work_area_display(wa, locale=locale)}
            for wa in profiles_selectors.list_work_areas(profile)
        ],
        # «Местные первыми» (владелец 18.09, ADR-193): local — профиль указал
        # СВОЁ гео уровня страна/регион/город, покрывающее запрос; remote —
        # совпал ТОЛЬКО через scope=world («работаю удалённо», ADR-184: такой
        # профиль по-прежнему виден, просто не выдаётся ЗА местного). `None`
        # — гео-фильтр не задан вовсе, группировать нечего.
        "geo_match": geo_match,
    }


def get_search_catalog(
    *,
    viewer: User,
    country: str | None,
    region: str | None,
    city: int | None,
    sphere_codes: list[str],
    work_type_codes: list[str] | None = None,
    min_experience: int | None,
    limit: int = CATALOG_PAGE_SIZE_DEFAULT,
    cursor: str | None = None,
    locale: str = "ru",
    request: Any = None,
) -> dict[str, Any]:
    """`catalog` раздела `GET /dashboard/search` (план 11.09 §5, ADR-184;
    виды работ — ADR-190, 12.09; свой профиль исключён и «местные первыми»
    — ADR-193, 18.09): каталожный поиск исполнителей с фильтрами. Видимость
    — та же связка, что уже применяется к сфере-поиску выше
    (`is_visible_in_catalog` + `discoverable_by_handle`): бизнес-профили без
    собственного пользователя (`owner_entity`, без `owner_user`) этой
    связкой исключены — существующее ограничение, не новое (см. ADR-184
    «Пределы задачи»).

    `viewer` — САМ зритель: жалоба владельца («выдал… плюс сам мой
    аккаунт», ADR-193) — исключаем `owner_user=viewer` БЕЗ `kind=PERSON`
    (проще и не завязано на то, что `owner_user` структурно бывает только
    у person-профиля, CheckConstraint `profile_owner_matches_kind`,
    `apps.profiles.models.Profile.Meta`). Бизнес-профиль, которым зритель
    управляет через `owner_entity.claimed_by` (не `owner_user`) — ДРУГАЯ
    сущность, этим исключением не убирается (вне рамок задачи 18.09: там
    речь о «моём аккаунте», а не о бизнесах под управлением).

    `work_type_codes` — составные `<сфера>.<категория>` (ADR-190), ИЛИ
    между значениями, И с остальными фильтрами (в т.ч. с `sphere_codes` —
    это НЕЗАВИСИМЫЕ условия, передать оба одновременно не обязывает их
    ссылаться на одну и ту же сферу). ТОЛЬКО заявленное
    (`declared_work_type_q`) — в отличие от сфер, подтверждения
    завершённой сделкой для видов работ нет (`DealFact` не несёт категорию
    чек-листа, см. докстринг `declared_work_type_q`).

    Порядок и `geo_match` (ADR-193): когда гео-фильтр задан, профили с
    покрытием ТОЛЬКО через `scope=world` («работают удалённо») уезжают во
    ВТОРУЮ группу выдачи, после тех, кто указал реальное гео запроса —
    иначе местный исполнитель тонет за страницами «мирового» флага,
    поставленного миграцией старой галочки. Курсор несёт группу третьим
    полем (см. `_encode_catalog_cursor`/`_decode_catalog_cursor`) — без неё
    вторая страница не знает, с какой стороны границы local/remote она
    продолжает."""
    qs = profiles_selectors.list_catalog_profiles().filter(
        owner_user__isnull=False,
        owner_user__is_active=True,
        owner_user__is_banned=False,
        owner_user__discoverable_by_handle=True,
    )
    qs = qs.exclude(owner_user=viewer)

    geo_q = profiles_selectors.geo_filter_coverage_q(country=country, region=region, city=city)
    grouped = geo_q is not None
    # `geo_rank` аннотируется БЕЗУСЛОВНО (владелец 18.09, ADR-193): django-
    # stubs/mypy не связывает аннотацию, добавленную только в одной из веток
    # `if`, с последующими `qs.filter(geo_rank=…)` ниже по коду — тот же
    # приём, что уже применён к `completed_deals_count` (annotate() вне
    # условия). Без гео-фильтра ранг у всех одинаковый (0) — группировки
    # это не создаёт, `order_by`/`geo_match` ниже читают её только когда
    # `grouped=True`.
    if geo_q is not None:
        qs = qs.filter(geo_q)
        local_q = profiles_selectors.geo_filter_local_coverage_q(
            country=country, region=region, city=city
        )
        assert local_q is not None  # geo_q is not None ⇒ тот же гео-фильтр задан
        geo_rank_expr: Any = Case(
            When(local_q, then=Value(1)), default=Value(0), output_field=IntegerField()
        )
    else:
        geo_rank_expr = Value(0, output_field=IntegerField())
    qs = qs.annotate(geo_rank=geo_rank_expr)

    if sphere_codes:
        qs = qs.filter(
            profiles_selectors.declared_sphere_q(sphere_codes)
            | reputation_selectors.contractor_sphere_deal_q(sphere_codes)
        )

    if work_type_codes:
        qs = qs.filter(profiles_selectors.declared_work_type_q(work_type_codes))

    qs = qs.annotate(
        completed_deals_count=Coalesce(
            reputation_selectors.contractor_completed_deals_count_subquery(),
            Value(0),
            output_field=IntegerField(),
        )
    )
    if min_experience is not None:
        qs = qs.filter(completed_deals_count__gte=min_experience)

    if cursor:
        after_group, after_created, after_id = _decode_catalog_cursor(cursor)
        if grouped:
            if after_group not in ("local", "remote"):
                raise InvalidCatalogCursorError(cursor)
            after_rank = 1 if after_group == "local" else 0
            qs = qs.filter(
                Q(geo_rank__lt=after_rank)
                | Q(geo_rank=after_rank, created_at__lt=after_created)
                | Q(geo_rank=after_rank, created_at=after_created, id__lt=after_id)
            )
        else:
            if after_group != "none":
                raise InvalidCatalogCursorError(cursor)
            qs = qs.filter(
                Q(created_at__lt=after_created) | Q(created_at=after_created, id__lt=after_id)
            )

    if grouped:
        qs = qs.order_by("-geo_rank", "-created_at", "-id")
    else:
        qs = qs.order_by("-created_at", "-id")
    qs = qs.select_related("owner_user")
    # +1 строка — «есть ли ещё», без второго COUNT (тот же приём, что
    # apps.notifications.selectors.feed_for_recipient).
    rows = list(qs[: limit + 1])
    has_more = len(rows) > limit
    page = rows[:limit]

    def row_geo_match(profile: Any) -> str | None:
        """`None` — гео-фильтр не задан, группировать нечего; иначе — группа
        строки по её аннотации `geo_rank` (см. выше)."""
        if not grouped:
            return None
        return "local" if profile.geo_rank == 1 else "remote"

    return {
        "items": [
            _catalog_item(p, locale=locale, request=request, geo_match=row_geo_match(p))
            for p in page
        ],
        "next_cursor": (
            _encode_catalog_cursor(page[-1], group=row_geo_match(page[-1]) or "none")
            if has_more and page
            else None
        ),
    }
