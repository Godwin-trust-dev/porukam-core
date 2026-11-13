"""Read-слой apps.reputation — поверх `DealFact` (никогда напрямую поверх
apps.contracts/apps.milestones/apps.disputes: read-модель ГВ.4 намеренно
не знает о них, только о своих строках, накопленных подписчиком по
событиям, docs/tasks/global-wave.md ГВ.4)."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.db.models import Count, IntegerField, OuterRef, Q, QuerySet, Subquery
from django.utils import timezone

from apps.profiles.models import Profile

from .models import DealFact, MilestoneFact


def completed_deals_for_profile(profile_id: Any) -> QuerySet[DealFact]:
    return DealFact.objects.filter(
        Q(customer_profile_id=profile_id) | Q(contractor_profile_id=profile_id),
        is_completed=True,
    ).order_by("-completed_at")


def deals_count(profile_id: Any) -> int:
    return completed_deals_for_profile(profile_id).count()


def counterparties_count(profile_id: Any) -> int:
    ids = {
        str(other)
        for deal in completed_deals_for_profile(profile_id)
        if (other := deal.counterparty_profile_id(profile_id)) is not None
    }
    return len(ids)


def is_counterparty(profile_id: Any, other_profile_id: Any) -> bool:
    """Виден ли `profile_id` как сторона ХОТЯ БЫ одной завершённой сделки
    с `other_profile_id` — единственная проверка «контрагент сделки»,
    которую допускает ADR-059 для видимости `link_and_deals` без прямого
    обращения к apps.contracts (сама ГВ.4-модель уже знает обе стороны)."""
    if profile_id is None or other_profile_id is None:
        return False
    return DealFact.objects.filter(
        Q(customer_profile_id=profile_id, contractor_profile_id=other_profile_id)
        | Q(customer_profile_id=other_profile_id, contractor_profile_id=profile_id),
        is_completed=True,
    ).exists()


def card_visible_in_full(profile: Profile, *, viewer_profile_id: Any) -> bool:
    """ADR-059: `public` — полная карточка любому, включая анонимного
    гостя (и бизнес-профиль — CheckConstraint `profile_business_always_public`
    держит его public всегда, пока операбелен, apps.profiles.models).
    `link_and_deals` — полная карточка ТОЛЬКО владельцу профиля и
    подтверждённым контрагентам хотя бы одной завершённой сделки; всем
    остальным, включая анонимного гостя без `X-Acting-Profile`, — стартовая
    карточка (`docs/tasks/global-wave.md` ГВ.4: «гостю — стартовая
    карточка», решение зафиксировано в
    `docs/adr/ADR-076-reputation-card-read-model.md`)."""
    if (
        profile.kind == Profile.Kind.BUSINESS
        or profile.profile_visibility == Profile.Visibility.PUBLIC
    ):
        return True
    if viewer_profile_id is None:
        return False
    if str(viewer_profile_id) == str(profile.id):
        return True
    return is_counterparty(profile.id, viewer_profile_id)


def contractor_profile_ids_in_spheres(sphere_codes: list[str], *, limit: int = 100) -> list[Any]:
    """Исполнители с завершёнными сделками в сферах (ADR-121, поиск по
    сферам): «репутация на фактах» — единственный источник «человек работает
    в сфере X», который платформа подтверждает сама. Порядок — по свежести
    завершения; дубли профилей схлопнуты."""
    if not sphere_codes:
        return []
    seen: list[Any] = []
    qs = (
        DealFact.objects.filter(is_completed=True, contractor_profile_id__isnull=False)
        .order_by("-completed_at")
        .values_list("contractor_profile_id", "sphere_codes")
    )
    wanted = set(sphere_codes)
    for profile_id, codes in qs.iterator():
        if not wanted.intersection(codes or []):
            continue
        if profile_id in seen:
            continue
        seen.append(profile_id)
        if len(seen) >= limit:
            break
    return seen


def contractor_sphere_deal_q(sphere_codes: list[str]) -> Q:
    """Q для фильтра каталога (план 11.09 §5, ADR-184, продолжение ADR-121):
    профиль имеет ЗАВЕРШЁННУЮ сделку ИСПОЛНИТЕЛЕМ в одной из сфер —
    «репутация на фактах», единственный источник подтверждённой сферы,
    который платформа гарантирует сама (в отличие от заявленной сферы
    профиля, `apps.profiles.selectors.declared_sphere_q`). КАК `Q`, не
    материализованный список id (в отличие от `contractor_profile_ids_in_spheres`
    выше) — каталог комбинирует это условие с гео/опытом на уровне ОДНОГО
    queryset'а с keyset-пагинацией."""
    if not sphere_codes:
        return Q(pk__in=[])
    sphere_q = Q()
    for code in sphere_codes:
        sphere_q |= Q(sphere_codes__contains=[code])
    matching = DealFact.objects.filter(
        sphere_q, is_completed=True, contractor_profile_id__isnull=False
    ).values("contractor_profile_id")
    return Q(pk__in=Subquery(matching))


def contractor_completed_deals_count_subquery() -> Subquery:
    """Число завершённых сделок ИСПОЛНИТЕЛЕМ — подзапрос для `annotate()` на
    ЧУЖОМ queryset'е `Profile` (план 11.09 §5, ADR-184: «опыт» каталожного
    поиска исполнителей). Именно роль `contractor`, НЕ обе роли сразу — в
    отличие от `deals_count`/`card_aggregates` выше, которые не различают
    роль (карточка репутации человека целиком, а не «каталог исполнителей»,
    где релевантна конкретно роль исполнителя).

    Вызывающая сторона обязана annotate'ить queryset, где `OuterRef("pk")`
    резолвится в `Profile.id` (единственный ожидаемый потребитель —
    `apps.dashboards.selectors.get_search_catalog`)."""
    counts = (
        DealFact.objects.filter(contractor_profile_id=OuterRef("pk"), is_completed=True)
        .order_by()
        .values("contractor_profile_id")
        .annotate(n=Count("id"))
        .values("n")
    )
    return Subquery(counts, output_field=IntegerField())


# ---------------------------------------------------------------------------
# Агрегаты карточки (макет владельца 05.09, ADR-163)
# ---------------------------------------------------------------------------
#
# ДВЕ СИСТЕМЫ ОЦЕНКИ ПО РОЛИ (решение владельца 05.09) — исполнителя и
# заказчика НЕЛЬЗЯ мерить одной цифрой «в срок»: у исполнителя срок — это
# сдача работы, у заказчика — оплата и приёмка. Поэтому агрегаты режутся по
# роли (`by_role`) и по паре «сфера + роль» (`by_sphere`), а не по профилю
# целиком: один и тот же человек бывает и исполнителем, и заказчиком, и
# смешивать его цифры значило бы врать обеим сторонам.
#
# Волна 1 считает ТОЛЬКО то, что уже накоплено в `DealFact` из событий
# Э4.6 (`milestones_accepted/rejected`, `disputes_opened/resolved`,
# `sphere_codes`, `completed_at`) — новых событий не заводит. Оси сроков
# («сделано в срок» / «оплачено в срок» / «принято без затягивания») и
# гарантийные обращения приходят волной 2 (расширение payload + бэкфилл).

CONTRACTOR_ROLE = "contractor"
CUSTOMER_ROLE = "customer"


def role_in_deal(deal: DealFact, profile_id: Any) -> str | None:
    """Роль профиля в сделке. `None` — профиль не сторона (в выдачу такой
    строки не попадает, но селектор обязан переживать это без исключения:
    `DealFact` заводится по первому же событию, где вторая сторона может
    быть ещё не известна)."""
    if str(deal.contractor_profile_id) == str(profile_id):
        return CONTRACTOR_ROLE
    if str(deal.customer_profile_id) == str(profile_id):
        return CUSTOMER_ROLE
    return None


def _ratio(done: int, total: int) -> dict[str, int]:
    """Доля всегда парой «сделано / всего» — процент считает представление.
    Дробь не сворачивается в одно число ни здесь, ни в API: «36 из 39»
    проверяемо, «92 %» — нет (domain-model.md §13: только факты, единого
    балла нет)."""
    return {"done": done, "total": total}


def _first_time_done(deal: DealFact) -> int:
    """«Принято с первого раза» на уровне ЭТАПОВ: каждое отклонение —
    минус один этап, принятый без возврата. Даёт точную цифру, пока этап
    отклоняли не больше одного раза; при повторном возврате того же этапа
    цифра занижена (два отклонения — минус два), и это сознательный выбор
    в пользу занижения: карточка не должна показывать больше «с первого
    раза», чем было на самом деле. Отдельный счётчик «этапов без
    возвратов» появится только вместе с `MilestoneFact` (волна 2)."""
    return max(deal.milestones_accepted - deal.milestones_rejected, 0)


def _empty_role_stats() -> dict[str, Any]:
    return {
        "deals": 0,
        "first_time": _ratio(0, 0),
        "disputes_free": _ratio(0, 0),
        "disputes_opened": 0,
        "disputes_resolved": 0,
        # Оси сроков — по одной на «свою» роль (ADR-163 §1); в чужом блоке
        # ось остаётся 0/0 навсегда. Пустая пара «0 из 0» означает «нечего
        # мерить», не «плохо»: полоса в этом случае не рисуется вовсе.
        "on_time_delivery": _ratio(0, 0),
        "on_time_payment": _ratio(0, 0),
        "prompt_acceptance": _ratio(0, 0),
        "warranty_claims": 0,
    }


def _empty_sphere_stats(sphere_code: str, role: str) -> dict[str, Any]:
    return {
        "sphere_code": sphere_code,
        "role": role,
        "deals": 0,
        "first_time": _ratio(0, 0),
        "disputes": 0,
        "warranty": 0,
        "on_time": _ratio(0, 0),
    }


def _add_ratio(target: dict[str, int], done: int, total: int) -> None:
    target["done"] += done
    target["total"] += total


def _accumulate_role(stats: dict[str, Any], deal: DealFact, role: str) -> None:
    stats["deals"] += 1
    stats["first_time"]["done"] += _first_time_done(deal)
    stats["first_time"]["total"] += deal.milestones_accepted
    stats["disputes_free"]["total"] += 1
    if deal.disputes_opened == 0:
        stats["disputes_free"]["done"] += 1
    stats["disputes_opened"] += deal.disputes_opened
    stats["disputes_resolved"] += deal.disputes_resolved
    stats["warranty_claims"] += deal.warranty_claims
    # ADR-163 §1: КАЖДАЯ ось складывается только в блок ТОЙ стороны, чей
    # это срок. «Оплачено в срок» в блоке исполнителя было бы чужой
    # заслугой (платил заказчик), «сделано в срок» в блоке заказчика —
    # чужой работой. Поэтому развилка по роли здесь, а не на фронте.
    if role == CONTRACTOR_ROLE:
        _add_ratio(stats["on_time_delivery"], deal.milestones_on_time, deal.milestones_with_due)
    else:
        _add_ratio(stats["on_time_payment"], deal.payments_on_time, deal.payments_with_due)
        _add_ratio(stats["prompt_acceptance"], deal.acceptances_prompt, deal.acceptances_measured)


def _accumulate_sphere(stats: dict[str, Any], deal: DealFact, role: str) -> None:
    stats["deals"] += 1
    stats["first_time"]["done"] += _first_time_done(deal)
    stats["first_time"]["total"] += deal.milestones_accepted
    stats["disputes"] += deal.disputes_opened
    stats["warranty"] += deal.warranty_claims
    # Полоса строки сферы — «своя» ось роли (см. `_accumulate_role`).
    if role == CONTRACTOR_ROLE:
        _add_ratio(stats["on_time"], deal.milestones_on_time, deal.milestones_with_due)
    else:
        _add_ratio(stats["on_time"], deal.payments_on_time, deal.payments_with_due)


def repeat_counterparties(profile_id: Any) -> dict[str, int]:
    """«Повторные контрагенты»: `count` — сколько контрагентов пришли
    ВТОРОЙ раз и больше, `total` — сколько их всего. Повтор — самый
    сильный факт доверия, который платформа умеет подтвердить сама, и
    единственный, который нельзя изобразить одной сделкой."""
    per_counterparty: dict[str, int] = {}
    for deal in completed_deals_for_profile(profile_id):
        other = deal.counterparty_profile_id(profile_id)
        if other is None:
            continue
        key = str(other)
        per_counterparty[key] = per_counterparty.get(key, 0) + 1
    repeat = sum(1 for n in per_counterparty.values() if n > 1)
    return {"count": repeat, "total": len(per_counterparty)}


def card_aggregates(profile_id: Any) -> dict[str, Any]:
    """Агрегаты полной карточки одним проходом по завершённым сделкам.

    Один проход, а не пять запросов: `DealFact` уже денормализована под
    чтение (ADR-076), и агрегаты по JSON-полю `sphere_codes` в SQL всё
    равно не сворачиваются переносимо между PostgreSQL и тестовой БД.

    Строки `by_sphere` — пара «сфера + роль»: одна и та же сфера у одного
    профиля даёт ДВЕ строки, если он в ней и работал, и заказывал. Порядок
    — по числу сделок (убыв.), затем по коду сферы: карточка открывается с
    того, чем человек занимается больше всего."""
    by_role: dict[str, dict[str, Any]] = {
        CONTRACTOR_ROLE: _empty_role_stats(),
        CUSTOMER_ROLE: _empty_role_stats(),
    }
    by_sphere: dict[tuple[str, str], dict[str, Any]] = {}
    disputes_free = _ratio(0, 0)
    last_deal_at = None

    for deal in completed_deals_for_profile(profile_id):
        role = role_in_deal(deal, profile_id)
        if role is None:
            continue
        _accumulate_role(by_role[role], deal, role)
        disputes_free["total"] += 1
        if deal.disputes_opened == 0:
            disputes_free["done"] += 1
        if last_deal_at is None or (deal.completed_at and deal.completed_at > last_deal_at):
            last_deal_at = deal.completed_at
        for sphere_code in deal.sphere_codes or []:
            key = (sphere_code, role)
            stats = by_sphere.get(key)
            if stats is None:
                stats = _empty_sphere_stats(sphere_code, role)
                by_sphere[key] = stats
            _accumulate_sphere(stats, deal, role)

    return {
        "by_role": by_role,
        "by_sphere": sorted(
            by_sphere.values(), key=lambda s: (-int(s["deals"]), str(s["sphere_code"]))
        ),
        "disputes_free": disputes_free,
        "repeat_counterparties": repeat_counterparties(profile_id),
        "last_deal_at": last_deal_at,
    }


# ---------------------------------------------------------------------------
# Insights владельца (ADR-163 §8) — ПРИВАТНО, только сам профиль
# ---------------------------------------------------------------------------
#
# Отдельный документ, а не «карточка с флагом»: здесь раскрывается, ИЗ ЧЕГО
# сложилась каждая цифра (какие этапы отклоняли и почему, что сдано и
# оплачено с опозданием, где были споры), лежит подсказка «до зелёной зоны
# осталось N» и блок «считается, но не показывается другим» — объём и доля
# защищённых платежей (ADR-163 §4). Смешать это с публичной карточкой одним
# флагом значило бы, что одна ошибка в проверке прав раскрывает всё сразу.

#: Порог зелёной зоны в процентах (ADR-163 §3). Живёт здесь ТОЛЬКО ради
#: подсказки «сколько осталось» — сами зоны считает представление; сервер
#: не отдаёт ни процента, ни цвета.
GREEN_ZONE_PERCENT = 66

RECENT_WINDOW_DAYS = 30


def _to_green(done: int, total: int) -> int | None:
    """Сколько ещё УДАЧНЫХ событий подряд нужно, чтобы доля дотянулась до
    зелёной зоны. `None` — считать нечего (`total == 0`) или уже зелёная.

    Решается неравенство `(done + n) / (total + n) >= p`: каждое новое
    удачное событие растит и числитель, и знаменатель — поэтому «не хватает
    3 %» и «не хватает 3 этапов» это разные величины, и подсказка обязана
    считать вторую."""
    if total <= 0:
        return None
    p = GREEN_ZONE_PERCENT / 100
    if done >= p * total:
        return None
    # n >= (p*total - done) / (1 - p)
    needed = (p * total - done) / (1 - p)
    n = int(needed)
    while (done + n) < p * (total + n):
        n += 1
    return max(n, 1)


def _milestone_facts_for_profile(profile_id: Any, *, role: str) -> QuerySet[MilestoneFact]:
    field = "contractor_profile_id" if role == CONTRACTOR_ROLE else "customer_profile_id"
    return MilestoneFact.objects.filter(**{field: profile_id}).order_by("-updated_at")


def _milestone_item(fact: MilestoneFact, *, ok: bool | None, detail: str) -> dict[str, Any]:
    return {
        "contract_id": str(fact.contract_id),
        "milestone_id": str(fact.milestone_id),
        "title": fact.title,
        "sphere_code": fact.sphere_code,
        "ok": ok,
        "detail": detail,
        "happened_at": fact.accepted_at or fact.submitted_at or fact.updated_at,
    }


def _delivery_metric(profile_id: Any, by_role: dict[str, Any]) -> dict[str, Any]:
    stats = by_role[CONTRACTOR_ROLE]["on_time_delivery"]
    items = [
        _milestone_item(
            fact,
            ok=fact.delivered_on_time,
            # Деталь — ГОЛЫЕ факты, без готовой фразы: перевод и склонение
            # живут во фронте (29 локалей), сервер их не собирает.
            detail="",
        )
        for fact in _milestone_facts_for_profile(profile_id, role=CONTRACTOR_ROLE)
        if fact.delivered_on_time is not None
    ]
    return {
        "code": "on_time_delivery",
        "role": CONTRACTOR_ROLE,
        **stats,
        "to_green": _to_green(stats["done"], stats["total"]),
        "items": items,
    }


def _payment_metric(profile_id: Any, by_role: dict[str, Any]) -> dict[str, Any]:
    stats = by_role[CUSTOMER_ROLE]["on_time_payment"]
    items = [
        _milestone_item(fact, ok=fact.payment_on_time, detail="")
        for fact in _milestone_facts_for_profile(profile_id, role=CUSTOMER_ROLE)
        if fact.payment_on_time is not None
    ]
    return {
        "code": "on_time_payment",
        "role": CUSTOMER_ROLE,
        **stats,
        "to_green": _to_green(stats["done"], stats["total"]),
        "items": items,
    }


def _acceptance_metric(profile_id: Any, by_role: dict[str, Any]) -> dict[str, Any]:
    stats = by_role[CUSTOMER_ROLE]["prompt_acceptance"]
    items = [
        _milestone_item(
            fact,
            ok=fact.acceptance_prompt,
            detail="auto_accepted" if fact.auto_accepted else "",
        )
        for fact in _milestone_facts_for_profile(profile_id, role=CUSTOMER_ROLE)
        if fact.acceptance_prompt is not None
    ]
    return {
        "code": "prompt_acceptance",
        "role": CUSTOMER_ROLE,
        **stats,
        "to_green": _to_green(stats["done"], stats["total"]),
        "items": items,
    }


def _first_time_metric(profile_id: Any, role: str, by_role: dict[str, Any]) -> dict[str, Any]:
    stats = by_role[role]["first_time"]
    items = [
        _milestone_item(fact, ok=False, detail=fact.last_rejection_reason)
        for fact in _milestone_facts_for_profile(profile_id, role=role)
        if fact.rejections > 0
    ]
    return {
        "code": "first_time",
        "role": role,
        **stats,
        "to_green": _to_green(stats["done"], stats["total"]),
        # Раскрытие показывает ТОЛЬКО возвраты: «принято с первого раза» —
        # отсутствие события, перечислять нечего, а причина возврата и есть
        # то, ради чего экран открывают.
        "items": items,
    }


def _disputes_metric(profile_id: Any, aggregates: dict[str, Any]) -> dict[str, Any]:
    stats = aggregates["disputes_free"]
    items = [
        {
            "contract_id": str(deal.contract_id),
            "milestone_id": None,
            "title": deal.last_milestone_title,
            "sphere_code": (deal.sphere_codes or [""])[0],
            "ok": False,
            "detail": ",".join(deal.dispute_resolutions or []),
            "happened_at": deal.completed_at,
        }
        for deal in completed_deals_for_profile(profile_id)
        if deal.disputes_opened > 0
    ]
    return {
        "code": "disputes_free",
        "role": "",
        **stats,
        "to_green": _to_green(stats["done"], stats["total"]),
        "items": items,
    }


def _recent(profile_id: Any) -> dict[str, Any]:
    """«За 30 дней»: сделки, новые контрагенты, возвраты этапов."""
    since = timezone.now() - timedelta(days=RECENT_WINDOW_DAYS)
    deals = [
        deal
        for deal in completed_deals_for_profile(profile_id)
        if deal.completed_at is not None and deal.completed_at >= since
    ]
    counterparties = {
        str(other)
        for deal in deals
        if (other := deal.counterparty_profile_id(profile_id)) is not None
    }
    rejections = sum(
        fact.rejections
        for fact in MilestoneFact.objects.filter(
            Q(customer_profile_id=profile_id) | Q(contractor_profile_id=profile_id),
            last_rejected_at__gte=since,
        )
    )
    return {
        "deals": len(deals),
        "counterparties": len(counterparties),
        "rejections": rejections,
    }


def _hidden_metrics(profile_id: Any) -> dict[str, Any]:
    """ADR-163 §4 — «считается, но не показывается другим». Объём — СПИСКОМ
    пар по валютам, а не одним числом: складывать разные валюты нельзя
    (CLAUDE.md), а курса у платформы нет и быть не должно."""
    volume: dict[str, Decimal] = {}
    protected = 0
    total = 0
    for deal in completed_deals_for_profile(profile_id):
        if deal.total_amount is not None and deal.total_currency:
            volume[deal.total_currency] = volume.get(deal.total_currency, Decimal("0")) + (
                deal.total_amount
            )
        if deal.payment_protected is not None:
            total += 1
            if deal.payment_protected:
                protected += 1
    return {
        "volume": [
            {"amount": str(amount), "currency": currency}
            for currency, amount in sorted(volume.items())
        ],
        "protected_payments": _ratio(protected, total),
    }


def insights_for_profile(profile_id: Any) -> dict[str, Any]:
    """Приватный разбор карточки для её ВЛАДЕЛЬЦА (ADR-163 §8). Проверку
    прав делает вьюха — селектор данных не охраняет (иначе право «кому
    видно» разъехалось бы между слоями)."""
    aggregates = card_aggregates(profile_id)
    by_role = aggregates["by_role"]
    metrics = [
        _delivery_metric(profile_id, by_role),
        _first_time_metric(profile_id, CONTRACTOR_ROLE, by_role),
        _payment_metric(profile_id, by_role),
        _acceptance_metric(profile_id, by_role),
        _first_time_metric(profile_id, CUSTOMER_ROLE, by_role),
        _disputes_metric(profile_id, aggregates),
    ]
    return {
        "profile_id": str(profile_id),
        "generated_at": timezone.now(),
        "deals": deals_count(profile_id),
        "counterparties": counterparties_count(profile_id),
        "recent": _recent(profile_id),
        # Метрики без знаменателя на экран не попадают: «0 из 0» — это не
        # цифра, а отсутствие данных, и подсказка «до зелёной зоны» для неё
        # не существует.
        "metrics": [m for m in metrics if m["total"] > 0],
        "hidden": _hidden_metrics(profile_id),
    }
