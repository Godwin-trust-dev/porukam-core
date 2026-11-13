"""Чтение витрин — docs/tasks/marketing-metrics.md §9.1.

Форма ответа СОВПАДАЕТ с формой моста `analytics/sql/*.sql` (§9.3): при
переходе клиента на API меняется только `analytics/client.py`, а расхождение
двух источников ловится одной командой `python -m analytics.pull --compare`.
Поэтому имена ключей здесь — не вопрос вкуса: они контракт.

Ни одно поле ответа не содержит имени, телефона, адреса, геометки или текста
договора (§1 п.3). Страна — кодом ISO, идентификаторы пользователей в
агрегаты не попадают.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import connections
from django.db.models import Count, F, Q, Sum
from django.utils import timezone

from .models import (
    CatalogSearchEvent,
    ConstructorStepEvent,
    InstallEvent,
    MartContractLifecycle,
    MartDailyPulse,
    MartDailyPulseSlice,
    MartRefreshRun,
    MartUserCohort,
)

UNKNOWN = "??"


def _now_iso() -> str:
    return timezone.now().astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _envelope(metric: str, **extra: Any) -> dict[str, Any]:
    return {"metric": metric, "generated_at": _now_iso(), "source": "api", **extra}


def _num(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def _share(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


def _day_range(days: int) -> list[dt.date]:
    today = timezone.now().astimezone(dt.UTC).date()
    return [today - dt.timedelta(days=offset) for offset in range(days - 1, -1, -1)]


# --------------------------------------------------------------------------
# 1. Ежедневный монитор (§10)
# --------------------------------------------------------------------------
def pulse(*, days: int = 30) -> dict[str, Any]:
    day_list = _day_range(days)
    rows = {row.day: row for row in MartDailyPulse.objects.filter(day__gte=day_list[0])}

    # Регистрации дня в двух разрезах сразу: страна И язык интерфейса. Язык —
    # такой же первоклассный разрез (§4), поэтому он в мониторе, а не только
    # в отчёте.
    by_country: dict[dt.date, dict[str, int]] = {}
    by_locale: dict[dt.date, dict[str, int]] = {}
    for field, target in (("country", by_country), ("locale", by_locale)):
        rows_for_field = (
            MartDailyPulseSlice.objects.filter(day__gte=day_list[0], registrations__gt=0)
            .values("day", field)
            .annotate(n=Sum("registrations"))
        )
        for item in rows_for_field:
            target.setdefault(item["day"], {})[item[field]] = item["n"]

    days_payload = []
    for day in day_list:
        row = rows.get(day)
        days_payload.append(
            {
                "day": day.isoformat(),
                "registrations": row.registrations if row else 0,
                "registrations_by_country": by_country.get(day, {}),
                "registrations_by_locale": by_locale.get(day, {}),
                "activations": row.activations if row else 0,
                "contracts_signed": row.contracts_signed if row else 0,
                "negotiations_sent": row.negotiations_sent if row else 0,
                "milestones_submitted": row.milestones_submitted if row else 0,
                "milestones_accepted_explicit": row.milestones_accepted_explicit if row else 0,
                "milestones_accepted_auto": row.milestones_accepted_auto if row else 0,
                "active_pairs": row.active_pairs if row else 0,
                "avg_leaves_in_signed": _num(row.avg_leaves_in_signed) or 0 if row else 0,
                "median_leaves_in_signed": _num(row.median_leaves_in_signed) or 0 if row else 0,
                "disputes_opened": row.disputes_opened if row else 0,
                "disputes_aging": row.disputes_aging if row else 0,
                "disputes_escalation": row.disputes_escalation if row else 0,
                "legal_notifications": row.legal_notifications if row else 0,
                "legal_notifications_placed": row.legal_notifications_placed if row else 0,
                "auto_accept_with_undelivered": (row.auto_accept_with_undelivered if row else 0),
                "cross_country_signed": row.cross_country_signed if row else 0,
                "abandoned_drafts": row.abandoned_drafts if row else 0,
                # Установки приложения (ADR-171): воронка «показали ->
                # нажали -> поставили» плюс использование установленного.
                "install_prompt_shown": row.install_prompt_shown if row else 0,
                "install_clicks": row.install_clicks if row else 0,
                "pwa_installs": row.pwa_installs if row else 0,
                "play_clicks": row.play_clicks if row else 0,
                "standalone_opens": row.standalone_opens if row else 0,
                # Уникальные ЛЮДИ, а не действия (ADR-171, §5.4). WAU — не
                # сумма семи DAU: складывать уникальных нельзя.
                "active_users_day": row.active_users_day if row else 0,
                "active_users_7d": row.active_users_7d if row else 0,
                # Шаг отвала — из единственного поведенческого слоя (§8.1).
                # Пока фронт не шлёт события конструктора, поле честно пусто.
                "abandoned_step": _abandoned_step(day),
            }
        )
    return _envelope("pulse", days=days_payload, audit_vault=audit_vault_health(days=days))


def _abandoned_step(day: dt.date) -> str | None:
    """Самый частый шаг, на котором в этот день уходили из конструктора
    (§10 строка 12). Возвращает None, пока слой событий конструктора пуст —
    ноль или выдуманный шаг здесь были бы неправдой."""
    start = dt.datetime.combine(day, dt.time.min, tzinfo=dt.UTC)
    top = (
        ConstructorStepEvent.objects.filter(
            occurred_at__gte=start,
            occurred_at__lt=start + dt.timedelta(days=1),
            action=ConstructorStepEvent.Action.LEFT,
        )
        .values("step_code")
        .annotate(n=Count("id"))
        .order_by("-n")
        .first()
    )
    return str(top["step_code"]) if top else None


# --------------------------------------------------------------------------
# 2. География (§4) — первый класс, не разрез
# --------------------------------------------------------------------------
def geography(*, window_days: int = 30) -> dict[str, Any]:
    """География И ЯЗЫКИ (§4). Оба разреза симметричны: одинаковый набор
    полей, одинаковая динамика по дням, одинаковое определение «живой».
    §4.3 называет три решения, и два из них — про страну («какую поднимать
    до плагина») и про язык («какой вычитывать носителем следующим»)."""
    today = timezone.now().astimezone(dt.UTC).date()
    from_date = today - dt.timedelta(days=window_days - 1)
    prev_from = today - dt.timedelta(days=window_days * 2 - 1)
    prev_to = today - dt.timedelta(days=window_days)
    day_list = _day_range(window_days)

    users = MartUserCohort.objects.all()
    users_total = users.count()

    def _blank(code: str) -> dict[str, Any]:
        return {
            "code": code,
            "users_total": 0,
            "registrations_window": 0,
            "registrations_prev_window": 0,
            "contracts_signed_window": 0,
            "contracts_signed_total": 0,
            "contracts_with_accepted_window": 0,
            "is_live": False,
        }

    def _dimension(field: str, customer_field: str, contractor_field: str) -> dict[str, Any]:
        rows: dict[str, dict[str, Any]] = {}
        for item in users.values(field).annotate(
            users_total=Count("user_id"),
            registrations_window=Count("user_id", filter=Q(registered_at__date__gte=from_date)),
            registrations_prev_window=Count(
                "user_id",
                filter=Q(registered_at__date__gte=prev_from, registered_at__date__lte=prev_to),
            ),
        ):
            code = item[field] or UNKNOWN
            rows[code] = {
                **_blank(code),
                "users_total": item["users_total"],
                "registrations_window": item["registrations_window"],
                "registrations_prev_window": item["registrations_prev_window"],
            }

        # Договор относится к ОБЕИМ сторонам: код «живой», если по нему есть
        # хотя бы один подписанный договор за окно (§4.2). Раскладка идёт в
        # питоне, потому что строка витрины даёт ДВА значения разреза —
        # SQL-группировка потребовала бы разворачивать пару в union.
        for row in MartContractLifecycle.objects.filter(signed_at__isnull=False).only(
            customer_field, contractor_field, "signed_at", "first_milestone_accepted_at"
        ):
            if row.signed_at is None:  # pragma: no cover — отфильтровано в запросе
                continue
            signed_day = row.signed_at.astimezone(dt.UTC).date()
            accepted_at = row.first_milestone_accepted_at
            accepted_day = accepted_at.astimezone(dt.UTC).date() if accepted_at else None
            sides = {
                getattr(row, customer_field) or UNKNOWN,
                getattr(row, contractor_field) or UNKNOWN,
            }
            for code in sides:
                entry = rows.setdefault(code, _blank(code))
                entry["contracts_signed_total"] += 1
                if signed_day >= from_date:
                    entry["contracts_signed_window"] += 1
                    entry["is_live"] = True
                if accepted_day is not None and accepted_day >= from_date:
                    entry["contracts_with_accepted_window"] += 1

        ordered = sorted(
            rows.values(),
            key=lambda r: (-r["registrations_window"], -r["users_total"], r["code"]),
        )

        # Динамика — плотный ряд по каждому коду: разворот тренда виден только
        # на ряду, не на итоге (§5.1).
        positions = {day: i for i, day in enumerate(day_list)}
        dynamics: dict[str, list[dict[str, Any]]] = {
            code: [{"day": day.isoformat(), "n": 0} for day in day_list] for code in rows
        }
        slice_rows = MartDailyPulseSlice.objects.filter(
            day__gte=day_list[0], registrations__gt=0
        ).values_list("day", field, "registrations")
        for slice_day, code, count in slice_rows:
            series = dynamics.get(code or UNKNOWN)
            if series is not None and slice_day in positions:
                series[positions[slice_day]]["n"] += count

        not_set = rows.get(UNKNOWN, _blank(UNKNOWN))["users_total"]
        summary: dict[str, Any] = {
            "users": not_set,
            "share": _share(not_set, users_total),
        }
        if field == "country":
            # В какой ветке онбординга дыра: человек не выбрал страну вовсе
            # или зашёл через Google и остался на стартовом GLOBAL.
            summary["by_reason"] = {
                reason: users.filter(country_source=reason).count()
                for reason in ("never_set", "global_default")
            }
        return {"rows": ordered, "dynamics": dynamics, "not_set": summary}

    countries = _dimension("country", "customer_country", "contractor_country")
    languages_dim = _dimension("locale", "customer_locale", "contractor_locale")

    signed_window = MartContractLifecycle.objects.filter(signed_at__date__gte=from_date)
    signed_count = signed_window.count()

    hours: dict[int, int] = {}
    for value in signed_window.values_list("signed_at", flat=True):
        if value is None:  # pragma: no cover — отфильтровано в запросе
            continue
        hour = value.astimezone(dt.UTC).hour
        hours[hour] = hours.get(hour, 0) + 1

    return _envelope(
        "geography",
        window_days=window_days,
        from_date=from_date.isoformat(),
        to_date=today.isoformat(),
        countries=countries["rows"],
        country_dynamics=countries["dynamics"],
        languages=languages_dim["rows"],
        language_dynamics=languages_dim["dynamics"],
        cross_country={
            "signed_window": signed_count,
            "cross_window": signed_window.filter(is_cross_country=True).count(),
            "share": _share(signed_window.filter(is_cross_country=True).count(), signed_count),
        },
        cross_language={
            "signed_window": signed_count,
            "cross_window": signed_window.filter(is_cross_language=True).count(),
            "share": _share(signed_window.filter(is_cross_language=True).count(), signed_count),
        },
        # «Страна не выбрана» и «язык не задан» — не география, а онбординг:
        # пока доля высока, выводы по разрезам считаются по меньшинству.
        country_not_chosen=countries["not_set"],
        locale_not_set=languages_dim["not_set"],
        contours=[
            {"contour": item["contour"] or UNKNOWN, "users": item["n"]}
            for item in users.values("contour").annotate(n=Count("user_id")).order_by("-n")
        ],
        signing_hours_utc=[{"hour": h, "n": hours[h]} for h in sorted(hours)],
        ip_vs_selected={
            "available": False,
            "reason": (
                "страна по IP при регистрации (§4.1) в схеме не хранится — "
                "нужна колонка кода страны ISO-3166 на регистрации, без сырого IP"
            ),
        },
    )


# --------------------------------------------------------------------------
# 3. Приток (§5.1) и виральность (§5.3)
# --------------------------------------------------------------------------
def acquisition(*, window_days: int = 90) -> dict[str, Any]:
    day_list = _day_range(window_days)
    per_day = {day: {"registrations": 0, "via_social": 0, "via_phone": 0} for day in day_list}
    # Читаем витрину когорт, а не разрезов: накопительный итог ниже считается
    # по ней же, и брать дневной ряд из другой таблицы значило бы допустить
    # ряд, который не сходится со своим же итогом.
    for item in (
        MartUserCohort.objects.filter(registered_at__date__gte=day_list[0])
        .values("registered_at__date", "source")
        .annotate(n=Count("user_id"))
    ):
        bucket = per_day.get(item["registered_at__date"])
        if bucket is None:
            continue
        bucket["registrations"] += item["n"]
        key = "via_social" if item["source"] == "social" else "via_phone"
        bucket[key] += item["n"]

    before_window = MartUserCohort.objects.filter(registered_at__date__lt=day_list[0]).count()
    daily: list[dict[str, Any]] = []
    running_window = 0
    running_total = before_window
    values = [per_day[day]["registrations"] for day in day_list]
    for i, day in enumerate(day_list):
        running_window += values[i]
        running_total += values[i]
        window7 = values[max(0, i - 6) : i + 1]
        window28 = values[max(0, i - 27) : i + 1]
        daily.append(
            {
                "day": day.isoformat(),
                "registrations": values[i],
                "ma7": round(sum(window7) / len(window7), 2),
                "ma28": round(sum(window28) / len(window28), 2),
                "cumulative_in_window": running_window,
                "cumulative_total": running_total,
                "via_social_login": per_day[day]["via_social"],
                "via_phone": per_day[day]["via_phone"],
            }
        )

    cumulative_by_country = {
        (item["country"] or UNKNOWN): item["n"]
        for item in MartUserCohort.objects.values("country").annotate(n=Count("user_id"))
    }
    cumulative_by_locale = {
        (item["locale"] or UNKNOWN): item["n"]
        for item in MartUserCohort.objects.values("locale").annotate(n=Count("user_id"))
    }

    # «Пришёл в конкретную сделку» (§5.1 — основной сценарий входа): человек
    # зарегистрировался и стал стороной договора, который создал НЕ он.
    arrival_hours = int(getattr(settings, "ANALYTICS_ARRIVAL_WINDOW_HOURS", 48))
    in_window = MartUserCohort.objects.filter(registered_at__date__gte=day_list[0])
    registrations_total = in_window.count()
    became_ever = in_window.filter(first_foreign_party_at__isnull=False).count()
    became_fast = in_window.filter(
        first_foreign_party_at__isnull=False,
        first_foreign_party_at__lte=F("registered_at") + dt.timedelta(hours=arrival_hours),
    ).count()
    hours = sorted(
        (foreign_at - registered_at).total_seconds() / 3600.0
        for registered_at, foreign_at in in_window.filter(
            first_foreign_party_at__isnull=False
        ).values_list("registered_at", "first_foreign_party_at")
        if foreign_at is not None
    )

    return _envelope(
        "acquisition",
        window_days=window_days,
        daily=daily,
        cumulative_by_country=cumulative_by_country,
        cumulative_by_locale=cumulative_by_locale,
        arrival={
            "window_hours": arrival_hours,
            "registrations": registrations_total,
            "became_party_ever": became_ever,
            "became_party_within_window": became_fast,
            "share_within_window": _share(became_fast, registrations_total),
            "hours_to_first_deal_p50": _percentile(hours, 0.5),
        },
        # Установка приложения — канал привлечения, а не деталь интерфейса
        # (ADR-171): именно здесь видно, окупается ли ссылка на Play и
        # предложение поставить PWA.
        installs=installs(window_days=window_days),
        # Сущности приглашения в домене НЕТ, и завести её нельзя без
        # продуктового решения: контур спроектирован и ждёт владельца.
        # Ноль здесь читался бы как «виральности нет» — а верно «канала ещё нет».
        invites={
            "available": False,
            "reason": (
                "сущности приглашения в домене нет: create_draft требует существующий "
                "профиль контрагента, телефонная книга не хранит хеши вне платформы. "
                "Контур спроектирован и ждёт решения владельца — "
                "docs/tasks/invites-design-proposal-2026-08-28.md, вариант C (ContractInvite)"
            ),
            "k_factor": None,
            "invitation_lifetime_days_p50": None,
            "reverse_virality_share": None,
        },
    )


def installs(*, window_days: int = 90) -> dict[str, Any]:
    """Воронка установки приложения за окно (ADR-171).

    Дневной ряд берётся из ВИТРИНЫ (mart_daily_pulse) — той же, из которой
    считается весь остальной пульс: два источника для одного числа рано или
    поздно разойдутся. Разрез по платформам и источникам читается прямо из
    слоя событий: в витрине его нет намеренно — платформа не ось продукта,
    а подсказка «где чинить установку».

    Что здесь НЕ считается и не будет:
    * уникальные устройства — для этого нужен отпечаток, которого мы не
      снимаем; pwa_installed — это события установки, а не устройства;
    * установки из Google Play — их знает только Play Console. Наш счётчик
      play_clicks меряет НАМЕРЕНИЕ (ушёл в магазин), и сравнивать его с
      установками в консоли можно только как воронку, а не как одно число.
      Как связать одно с другим — docs/ops/play-console.md, «Атрибуция
      установок с сайта» (UTM-referrer)."""
    day_list = _day_range(window_days)
    rows = {row.day: row for row in MartDailyPulse.objects.filter(day__gte=day_list[0])}
    keys = ("prompt_shown", "clicks", "pwa_installed", "play_clicks", "standalone_opens")
    daily: list[dict[str, Any]] = []
    totals = dict.fromkeys(keys, 0)
    for day in day_list:
        row = rows.get(day)
        counts = {
            "prompt_shown": row.install_prompt_shown if row else 0,
            "clicks": row.install_clicks if row else 0,
            "pwa_installed": row.pwa_installs if row else 0,
            "play_clicks": row.play_clicks if row else 0,
            "standalone_opens": row.standalone_opens if row else 0,
        }
        for key in keys:
            totals[key] += counts[key]
        daily.append({"day": day.isoformat(), **counts})

    start = dt.datetime.combine(day_list[0], dt.time.min, tzinfo=dt.UTC)
    events = InstallEvent.objects.filter(created_at__gte=start)
    by_platform: dict[str, dict[str, int]] = {}
    for item in events.values("platform", "kind").annotate(n=Count("id")):
        by_platform.setdefault(str(item["platform"]), {})[str(item["kind"])] = int(item["n"])
    by_source = {
        str(item["source"]): int(item["n"])
        for item in events.values("source").annotate(n=Count("id"))
    }

    return {
        "window_days": window_days,
        "daily": daily,
        "totals": totals,
        # Доля дошедших от показа предложения до установки. Ноль показов —
        # None, а не 0%: «никому не предлагали» и «предложили, не поставили»
        # это разные диагнозы.
        "prompt_to_click": _share(totals["clicks"], totals["prompt_shown"]),
        "click_to_install": _share(totals["pwa_installed"], totals["clicks"]),
        "by_platform": by_platform,
        "by_source": by_source,
        "play_installs": {
            "available": False,
            "reason": (
                "установки из Google Play видны только в Play Console: у магазина нет "
                "обратного вызова на сайт. Наш счётчик play_clicks меряет переход в "
                "магазин; сверять его с консолью — docs/ops/play-console.md, раздел "
                "«Атрибуция установок с сайта» (referrer utm_source=porukam.app)"
            ),
        },
    }


def installs_metric(*, window_days: int = 90) -> dict[str, Any]:
    """Та же воронка, но САМОСТОЯТЕЛЬНОЙ метрикой — в конверте §9.1
    (metric/generated_at/source), как у остальных эндпоинтов.

    Внутри `acquisition` установка едет без конверта: там она блок канала
    привлечения, а не отдельный ответ, и второй конверт внутри первого
    сломал бы сверку `python -m analytics.pull --compare`."""
    return _envelope("installs", **installs(window_days=window_days))


def search_filters(*, window_days: int = 90) -> dict[str, Any]:
    """Каталожный поиск с фильтром (ADR-186, часть 7 плана 11.09): один
    вопрос — пользуются ли новыми фильтрами каталога (часть 5, ADR-184) и
    какими именно, иначе не узнать, окупилась ли эта работа.

    Дневной ряд и суммарные `total`/`filtered` — из ВИТРИНЫ (mart_daily_pulse),
    тем же способом, что установки (§ installs выше): два источника для
    одного числа рано или поздно разойдутся. Разрез по видам фильтра и их
    СОЧЕТАНИЯМ читается прямо из слоя событий: он не аддитивен по дням (то
    же основание, что у `by_platform`/`by_source` установок) и в витрине не
    считается.

    Ни одно поле здесь не может указать на человека: `CatalogSearchEvent`
    вообще не хранит идентификатор пользователя (см. докстринг модели)."""
    day_list = _day_range(window_days)
    rows = {row.day: row for row in MartDailyPulse.objects.filter(day__gte=day_list[0])}
    daily: list[dict[str, Any]] = []
    totals = {"total": 0, "filtered": 0}
    for day in day_list:
        row = rows.get(day)
        counts = {
            "total": row.catalog_searches_total if row else 0,
            "filtered": row.catalog_searches_filtered if row else 0,
        }
        totals["total"] += counts["total"]
        totals["filtered"] += counts["filtered"]
        daily.append({"day": day.isoformat(), **counts})

    start = dt.datetime.combine(day_list[0], dt.time.min, tzinfo=dt.UTC)
    events = CatalogSearchEvent.objects.filter(created_at__gte=start)
    by_geo_level = {
        str(item["geo_level"]): int(item["n"])
        for item in events.values("geo_level").annotate(n=Count("id"))
    }
    by_sphere = {
        ("yes" if item["has_sphere"] else "no"): int(item["n"])
        for item in events.values("has_sphere").annotate(n=Count("id"))
    }
    by_experience = {
        ("yes" if item["has_experience"] else "no"): int(item["n"])
        for item in events.values("has_experience").annotate(n=Count("id"))
    }
    combinations = [
        {
            "geo_level": str(item["geo_level"]),
            "has_sphere": bool(item["has_sphere"]),
            "has_experience": bool(item["has_experience"]),
            "count": int(item["n"]),
        }
        for item in events.values("geo_level", "has_sphere", "has_experience")
        .annotate(n=Count("id"))
        .order_by("-n")
    ]

    return {
        "window_days": window_days,
        "daily": daily,
        "totals": totals,
        # Доля поисков, где применён хотя бы один фильтр — прямой ответ на
        # вопрос владельца «пользуются ли вообще».
        "filtered_share": _share(totals["filtered"], totals["total"]),
        "by_geo_level": by_geo_level,
        "by_sphere": by_sphere,
        "by_experience": by_experience,
        "combinations": combinations,
    }


def search_filters_metric(*, window_days: int = 90) -> dict[str, Any]:
    """Та же метрика в конверте §9.1 (metric/generated_at/source), как у
    остальных эндпоинтов."""
    return _envelope("search_filters", **search_filters(window_days=window_days))


# --------------------------------------------------------------------------
# 4. Воронка (§5.2) и глубина сделки с guardrail (§6)
# --------------------------------------------------------------------------
def funnel(*, window_days: int = 90) -> dict[str, Any]:
    today = timezone.now().astimezone(dt.UTC).date()
    from_date = today - dt.timedelta(days=window_days - 1)

    cohort = MartUserCohort.objects.filter(registered_at__date__gte=from_date)
    registrations = cohort.count()
    activated = cohort.filter(first_contract_signed_at__isnull=False).count()
    deltas = sorted(
        (signed_at - registered_at).total_seconds() / 86400.0
        for registered_at, signed_at in cohort.filter(
            first_contract_signed_at__isnull=False
        ).values_list("registered_at", "first_contract_signed_at")
        if signed_at is not None
    )

    drafted = MartContractLifecycle.objects.filter(drafted_at__date__gte=from_date)
    signed = MartContractLifecycle.objects.filter(signed_at__date__gte=from_date)

    leaves = sorted(signed.values_list("leaves", flat=True))
    signed_count = len(leaves)
    signed_aggregates = signed.aggregate(
        submitted=Sum("milestones_submitted"),
        accepted_explicit=Sum("milestones_accepted_explicit"),
        accepted_auto=Sum("milestones_accepted_auto"),
        amendments=Sum("amendments"),
        disputes=Sum("disputes"),
        resolved=Sum("disputes_resolved"),
        cap_reached=Sum("disputes_cap_reached"),
        escalated=Sum("disputes_escalated_to_court"),
        marked_paid=Sum("leaves_marked_paid"),
        confirmed_both=Sum("leaves_confirmed_both_sides"),
    )
    # Отвал на пороге подписания и качество чек-листов — про договоры,
    # СОЗДАННЫЕ в окне: считать их по подписанным значило бы выкинуть ровно те
    # сделки, ради которых метрика и заведена (§5.2).
    drafted_aggregates = drafted.aggregate(
        submitted_leaves=Sum("submitted_leaves"),
        submitted_full=Sum("submitted_leaves_full_evidence"),
        with_checklist=Sum("leaves_with_checklist"),
        all_from_catalog=Sum("leaves_checklist_all_from_catalog"),
        sig_total=Sum("signature_requests"),
        sig_forwarded=Sum("signature_requests_forwarded"),
        sig_declined=Sum("signature_requests_declined"),
        sig_expired=Sum("signature_requests_expired"),
    )
    agg = {key: value or 0 for key, value in {**signed_aggregates, **drafted_aggregates}.items()}

    # Воронка согласования ПО СТАТУСАМ ДОГОВОРА. Базовая единица продукта —
    # договор и его статус, поэтому воронка строится по статусам, а не по
    # гипотетическим приглашениям (§5.2).
    statuses = (
        "draft",
        "under_review",
        "pending_signature",
        "awaiting_signatures",
        "signed",
        "rejected_by_counterparty",
        "withdrawn_by_initiator",
    )
    status_counts = {
        status: drafted.filter(negotiation_status=status).count() for status in statuses
    }
    sent_for_review = drafted.filter(sent_at__isnull=False).count()
    signed_in_window = drafted.filter(signed_at__isnull=False).count()
    still_waiting = (
        drafted.filter(sent_at__isnull=False, signed_at__isnull=True)
        .exclude(negotiation_status__in=("rejected_by_counterparty", "withdrawn_by_initiator"))
        .count()
    )
    step_hours = _step_hours(drafted)

    abandoned_cutoff = today - dt.timedelta(
        days=int(getattr(settings, "ANALYTICS_ABANDONED_DRAFT_DAYS", 14))
    )
    return _envelope(
        "funnel",
        window_days=window_days,
        activation={
            "registrations": registrations,
            "activated": activated,
            "conversion": _share(activated, registrations),
            "time_to_first_contract_days_p50": _percentile(deltas, 0.5),
            "time_to_first_contract_days_p90": _percentile(deltas, 0.9),
        },
        negotiation={
            "contracts_created": drafted.count(),
            "by_status": status_counts,
            # Ответ ПРИГЛАШЁННОЙ СТОРОНЫ — самая узкая воронка продукта (§5.2).
            "counterparty_response": {
                "sent_for_review": sent_for_review,
                "signed": signed_in_window,
                "rejected": status_counts["rejected_by_counterparty"],
                "withdrawn": status_counts["withdrawn_by_initiator"],
                "still_waiting": still_waiting,
                "conversion": _share(signed_in_window, sent_for_review),
            },
            "step_hours": step_hours,
        },
        contract_funnel={
            "drafts_created": drafted.count(),
            "sent_to_negotiation": drafted.filter(sent_at__isnull=False).count(),
            "frozen": drafted.filter(frozen_at__isnull=False).count(),
            "signed": drafted.filter(signed_at__isnull=False).count(),
            "first_milestone_accepted": drafted.filter(
                first_milestone_accepted_at__isnull=False
            ).count(),
        },
        abandonment={
            "abandoned_drafts": MartContractLifecycle.objects.filter(
                negotiation_status="draft",
                sent_at__isnull=True,
                drafted_at__date__lte=abandoned_cutoff,
            ).count(),
            "abandoned_step": None,
            "abandoned_step_reason": (
                "нужен узкий слой событий конструктора (§8.1): доменного события "
                "«бросил на шаге N» нет и быть не должно"
            ),
            "at_signing_threshold": MartContractLifecycle.objects.filter(
                frozen_at__isnull=False, signed_at__isnull=True
            ).count(),
        },
        signing_threshold_events={
            "signature_requests": agg["sig_total"],
            "forwarded": agg["sig_forwarded"],
            "declined_for_revision": agg["sig_declined"],
            "expired": agg["sig_expired"],
        },
        depth={
            "contracts_signed": signed_count,
            "leaves_per_contract_avg": (
                round(sum(leaves) / signed_count, 2) if signed_count else 0
            ),
            "leaves_per_contract_median": _percentile([float(v) for v in leaves], 0.5, digits=None),
            "single_leaf_share": _share(sum(1 for value in leaves if value <= 1), signed_count),
            "amendments_per_contract": (
                round(agg["amendments"] / signed_count, 2) if signed_count else 0
            ),
        },
        acceptance={
            "submitted": agg["submitted"],
            "accepted_explicit": agg["accepted_explicit"],
            "accepted_auto": agg["accepted_auto"],
            # Главный guardrail (§6): автоприёмка — не успех, а фиксация того,
            # что заказчик пропустил окно.
            "auto_share": _share(agg["accepted_auto"], agg["submitted"]),
        },
        evidence={
            "submitted_with_checklist": agg["submitted_leaves"],
            "complete_share": _share(agg["submitted_full"], agg["submitted_leaves"]),
        },
        checklist_origin={
            "milestones_with_checklist": agg["with_checklist"],
            "all_items_from_catalog_share": _share(agg["all_from_catalog"], agg["with_checklist"]),
            "matched_by": "exact_description",
        },
        disputes={
            "opened": agg["disputes"],
            "disputed_share_of_submitted": _share(agg["disputes"], agg["submitted"]),
            "outcomes": {
                "resolved": agg["resolved"],
                "cap_reached": agg["cap_reached"],
                "escalated_to_court": agg["escalated"],
                "open": max(
                    agg["disputes"] - agg["resolved"] - agg["cap_reached"] - agg["escalated"], 0
                ),
            },
            # Потолок — аварийный клапан, а не рабочий сценарий (§6).
            "cap_reached_share": _share(agg["cap_reached"], agg["disputes"]),
            # §6: упор в потолок двух раундов = критерии приёмки были
            # неоднозначны с самого начала. Медиану нельзя сложить из
            # по-договорных сумм, поэтому считается запросом.
            "fix_rounds_median": _fix_rounds_median(from_date),
        },
        settlement={
            "leaves_marked_paid": agg["marked_paid"],
            "leaves_confirmed_both_sides": agg["confirmed_both"],
        },
        idle={
            "auto_closed": MartContractLifecycle.objects.filter(
                auto_closed_at__date__gte=from_date
            ).count()
        },
    )


def _step_hours(queryset: Any) -> dict[str, float | None]:
    """Сколько времени договор проводит на каждом шаге согласования: где
    именно застревает, а не только сколько дошло."""
    rows = list(queryset.values_list("drafted_at", "sent_at", "frozen_at", "signed_at"))

    def _spans(start_index: int, end_index: int) -> list[float]:
        return sorted(
            (row[end_index] - row[start_index]).total_seconds() / 3600.0
            for row in rows
            if row[start_index] is not None and row[end_index] is not None
        )

    return {
        "draft_to_sent_p50": _percentile(_spans(0, 1), 0.5),
        "sent_to_frozen_p50": _percentile(_spans(1, 2), 0.5),
        "frozen_to_signed_p50": _percentile(_spans(2, 3), 0.5),
        "draft_to_signed_p90": _percentile(_spans(0, 3), 0.9),
    }


def _fix_rounds_median(from_date: dt.date) -> float | None:
    with connections["default"].cursor() as cursor:
        cursor.execute(
            """
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.fix_rounds_used::double precision)
            FROM dispute d
            JOIN mart_contract_lifecycle cl ON cl.contract_id = d.contract_id
            WHERE cl.signed_at IS NOT NULL AND cl.signed_at::date >= %s
            """,
            [from_date],
        )
        (value,) = cursor.fetchone()
    return float(value) if value is not None else None


def _percentile(values: list[float], q: float, digits: int | None = 2) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    value = ordered[low] + (ordered[high] - ordered[low]) * (position - low)
    return round(value, digits) if digits is not None else value


# --------------------------------------------------------------------------
# 5. Языки (§4.2) — вход для приоритета вычитки
# --------------------------------------------------------------------------
def languages(*, window_days: int = 30) -> dict[str, Any]:
    today = timezone.now().astimezone(dt.UTC).date()
    from_date = today - dt.timedelta(days=window_days - 1)

    rows = {
        (item["locale"] or UNKNOWN): {
            "locale": item["locale"] or UNKNOWN,
            "users_total": item["users_total"],
            "registrations_window": item["registrations_window"],
            "users_signing_window": 0,
            "users_with_first_accept_window": 0,
        }
        for item in MartUserCohort.objects.values("locale").annotate(
            users_total=Count("user_id"),
            registrations_window=Count("user_id", filter=Q(registered_at__date__gte=from_date)),
        )
    }
    for item in (
        MartDailyPulseSlice.objects.filter(day__gte=from_date)
        .values("locale")
        .annotate(signing=Sum("users_signing"), accepted=Sum("first_milestone_accepted"))
    ):
        row = rows.get(item["locale"] or UNKNOWN)
        if row is not None:
            row["users_signing_window"] = item["signing"] or 0
            row["users_with_first_accept_window"] = item["accepted"] or 0

    locale_meta = _locale_catalog()
    empty_meta = {"name": None, "quality": None, "enabled": False, "rtl": False}
    interface_locales = []
    for locale, row in rows.items():
        interface_locales.append({**row, **locale_meta.get(locale, empty_meta)})
    interface_locales.sort(key=lambda r: (-r["users_total"], r["locale"]))

    contract_languages = [
        {"language": item["official_language"] or UNKNOWN, "contracts": item["n"]}
        for item in MartContractLifecycle.objects.filter(signed_at__date__gte=from_date)
        .values("official_language")
        .annotate(n=Count("contract_id"))
        .order_by("-n")
    ]

    # Очередь на вычитку: машинный пакет, на котором УЖЕ есть подписанные
    # договоры. Вычитывать надо языки, на которых реально работают (§4.3).
    priority = sorted(
        (
            {
                "locale": row["locale"],
                "quality": row.get("quality"),
                "users_total": row["users_total"],
                "users_signing_window": row["users_signing_window"],
            }
            for row in interface_locales
            if row.get("quality") not in {"reviewed", "native", None}
        ),
        key=lambda r: (-r["users_signing_window"], -r["users_total"]),
    )

    return _envelope(
        "languages",
        window_days=window_days,
        interface_locales=interface_locales,
        contract_languages=contract_languages,
        proofreading_priority=priority,
    )


def _locale_catalog() -> dict[str, dict[str, Any]]:
    """Справочник языков читается сырым запросом: apps.analytics не
    импортирует чужие модели (import-linter, см. README приложения)."""
    with connections["default"].cursor() as cursor:
        cursor.execute("SELECT code, name, quality, enabled, rtl FROM locale")
        return {
            code: {"name": name, "quality": quality, "enabled": enabled, "rtl": rtl}
            for code, name, quality, enabled, rtl in cursor.fetchall()
        }


# --------------------------------------------------------------------------
# 6. Когорты и удержание (§5.4)
# --------------------------------------------------------------------------
def cohorts(*, weeks: int = 12) -> dict[str, Any]:
    today = timezone.now().astimezone(dt.UTC).date()
    start_of_week = today - dt.timedelta(days=today.weekday())
    from_week = start_of_week - dt.timedelta(weeks=weeks - 1)

    rows = []
    users = MartUserCohort.objects.filter(cohort_week__gte=from_week)
    for item in (
        users.values("cohort_week")
        .annotate(
            users=Count("user_id"),
            activated=Count("user_id", filter=Q(first_contract_signed_at__isnull=False)),
            active_m1=Count("user_id", filter=Q(active_m1=True)),
            active_m3=Count("user_id", filter=Q(active_m3=True)),
            active_m6=Count("user_id", filter=Q(active_m6=True)),
            second_30=Count(
                "user_id",
                filter=Q(
                    second_contract_signed_at__isnull=False,
                    second_contract_signed_at__lte=F("first_contract_signed_at")
                    + dt.timedelta(days=30),
                ),
            ),
            second_90=Count(
                "user_id",
                filter=Q(
                    second_contract_signed_at__isnull=False,
                    second_contract_signed_at__lte=F("first_contract_signed_at")
                    + dt.timedelta(days=90),
                ),
            ),
        )
        .order_by("cohort_week")
    ):
        rows.append(
            {
                "cohort_week": item["cohort_week"].isoformat(),
                "users": item["users"],
                "activated": item["activated"],
                "activation_rate": _share(item["activated"], item["users"]),
                "second_contract_30d": item["second_30"],
                "second_contract_90d": item["second_90"],
                "repeat_rate_30d": _share(item["second_30"], item["activated"]),
                # Активность = участие в живом договоре; логин активностью не
                # считается (§5.4) — витрина уже исключила топики account.*.
                "active_m1": item["active_m1"],
                "active_m3": item["active_m3"],
                "active_m6": item["active_m6"],
            }
        )

    # Повторные пары: договор с ПРЕЖНИМ контрагентом — признак, что платформа
    # стала местом, где оформляют, а не разовым инструментом (§5.4).
    signed = list(
        MartContractLifecycle.objects.filter(signed_at__isnull=False)
        .exclude(pair_key="")
        .order_by("signed_at")
        .values_list("pair_key", flat=True)
    )
    seen: set[str] = set()
    returning = 0
    for pair in signed:
        if pair in seen:
            returning += 1
        seen.add(pair)

    disputed = MartUserCohort.objects.filter(
        first_contract_signed_at__isnull=False, first_contract_disputed=True
    )
    clean = MartUserCohort.objects.filter(
        first_contract_signed_at__isnull=False, first_contract_disputed=False
    )
    return _envelope(
        "cohorts",
        weeks=weeks,
        from_week=from_week.isoformat(),
        cohorts=rows,
        repeat_pairs={
            "signed_contracts": len(signed),
            "with_returning_pair": returning,
            "share": _share(returning, len(signed)),
        },
        dispute_churn={
            "first_contract_disputed": disputed.count(),
            "disputed_second_contract_90d": _returned_within(disputed, 90),
            "clean_first_contract": clean.count(),
            "clean_second_contract_90d": _returned_within(clean, 90),
        },
    )


def _returned_within(queryset: Any, days: int) -> int:
    count: int = queryset.filter(
        second_contract_signed_at__isnull=False,
        second_contract_signed_at__lte=F("first_contract_signed_at") + dt.timedelta(days=days),
    ).count()
    return count


# --------------------------------------------------------------------------
# 7. Здоровье системы (§7) — обещания, а не пожелания
# --------------------------------------------------------------------------
def health(*, days: int = 7) -> dict[str, Any]:
    """Здоровье — про «сейчас», а не про историю, поэтому считается по живым
    таблицам, а не по витринам: витрина по определению отстаёт на час, а
    недоставленное юрзначимое уведомление нельзя увидеть с часовой задержкой."""
    since = timezone.now() - dt.timedelta(days=days)
    with connections["default"].cursor() as cursor:
        cursor.execute(
            """
            SELECT count(*),
                   count(*) FILTER (WHERE placed_in_cabinet_at IS NOT NULL),
                   count(*) FILTER (
                       WHERE placed_in_cabinet_at IS NULL AND created_at < now() - interval '1 hour'
                   )
            FROM notification
            WHERE legal_significance IS TRUE AND created_at >= %s
            """,
            [since],
        )
        total, placed, overdue = cursor.fetchone()

        cursor.execute(
            """
            SELECT count(*) FROM outbox_event e
            WHERE e.topic = 'milestone.auto_accepted' AND e.occurred_at >= %s
            """,
            [since],
        )
        (auto_accepted,) = cursor.fetchone()

        cursor.execute(
            """
            SELECT count(DISTINCT (e.subject ->> 'id')::uuid)
            FROM outbox_event e
            JOIN notification n
              ON n.subject_type = 'milestone'
             AND n.subject_id = (e.subject ->> 'id')::uuid
             AND n.legal_significance IS TRUE
             AND n.placed_in_cabinet_at IS NULL
            WHERE e.topic = 'milestone.auto_accepted' AND e.occurred_at >= %s
            """,
            [since],
        )
        (incidents,) = cursor.fetchone()

        # §10 строка 9: любой сбой в СЕРИИ НАПОМИНАНИЙ перед автоприёмкой —
        # отдельный сигнал: именно она даёт заказчику шанс не пропустить окно.
        cursor.execute(
            """
            SELECT count(*)
            FROM outbox_event e
            JOIN notification n
              ON n.subject_type = 'milestone'
             AND n.subject_id = (e.subject ->> 'id')::uuid
             AND n.template = 'milestone_acceptance_reminder'
             AND n.placed_in_cabinet_at IS NULL
            WHERE e.topic = 'milestone.auto_accepted' AND e.occurred_at >= %s
            """,
            [since],
        )
        (reminder_gaps,) = cursor.fetchone()

        cursor.execute(
            """
            SELECT count(*),
                   percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY extract(epoch FROM (fired_at - deadline_at))),
                   percentile_cont(0.95) WITHIN GROUP (
                       ORDER BY extract(epoch FROM (fired_at - deadline_at))),
                   max(extract(epoch FROM (fired_at - deadline_at))),
                   count(*) FILTER (WHERE extract(epoch FROM (fired_at - deadline_at)) > 300)
            FROM domain_deadline
            WHERE fired_at IS NOT NULL AND deadline_at IS NOT NULL AND fired_at >= %s
            """,
            [since],
        )
        fired, lag_p50, lag_p95, lag_max, over_5min = cursor.fetchone()

        cursor.execute("SELECT name, extract(epoch FROM (now() - last_run_at)) FROM task_heartbeat")
        heartbeats = {name: round(float(age), 1) for name, age in cursor.fetchall()}

        cursor.execute(
            """
            SELECT count(*) FILTER (WHERE published_at IS NULL),
                   COALESCE(extract(epoch FROM (now() - min(created_at)
                       FILTER (WHERE published_at IS NULL))), 0)
            FROM outbox_event
            """
        )
        unpublished, oldest_age = cursor.fetchone()

        cursor.execute(
            """
            SELECT count(*),
                   count(*) FILTER (WHERE status = 'ready'),
                   count(*) FILTER (WHERE status = 'failed'),
                   count(*) FILTER (
                       WHERE status IN ('queued', 'running')
                         AND created_at < now() - interval '1 hour'
                   )
            FROM archive_export WHERE created_at >= %s
            """,
            [since],
        )
        exports_total, exports_ready, exports_failed, exports_stuck = cursor.fetchone()

        cursor.execute(
            """
            SELECT count(*), count(*) FILTER (WHERE placed_in_cabinet_at IS NOT NULL)
            FROM notification
            WHERE template = 'evidence.retention_expiring' AND created_at >= %s
            """,
            [since],
        )
        notices_total, notices_placed = cursor.fetchone()

    return _envelope(
        "health",
        days=days,
        legal_notifications={
            "total": total,
            "placed_in_cabinet": placed,
            "delivery_rate": _share(placed, total),
            "undelivered_over_1h": overdue,
        },
        auto_acceptance_incidents={
            "auto_accepted": auto_accepted,
            "with_undelivered_notification": incidents,
            "reminder_series_gaps": reminder_gaps,
        },
        deadline_sweep={
            "fired": fired,
            "lag_seconds_p50": round(float(lag_p50), 1) if lag_p50 is not None else None,
            "lag_seconds_p95": round(float(lag_p95), 1) if lag_p95 is not None else None,
            "lag_seconds_max": round(float(lag_max), 1) if lag_max is not None else None,
            "over_5min": over_5min,
        },
        heartbeats=heartbeats,
        outbox={
            "unpublished": unpublished,
            "oldest_unpublished_age_seconds": round(float(oldest_age), 1),
        },
        archive_exports={
            "total": exports_total,
            "ready": exports_ready,
            "failed": exports_failed,
            "stuck": exports_stuck,
        },
        retention_notices={"total": notices_total, "placed_in_cabinet": notices_placed},
        marts=mart_freshness(),
        api_availability={
            "available": False,
            "reason": (
                "считается по Prometheus (RED-метрики django-prometheus), не по БД — "
                "см. docs/performance-capacity.md"
            ),
        },
        audit_vault=audit_vault_health(days=days),
    )


def mart_freshness() -> dict[str, Any]:
    """Витрина, которая молча перестала пересчитываться, хуже отсутствующей:
    по ней принимают решения, считая её свежей."""
    out: dict[str, Any] = {}
    from .services import MART_ORDER

    for mart in MART_ORDER:
        last = MartRefreshRun.objects.filter(mart=mart, ok=True).first()
        out[mart] = (
            {
                "last_ok_at": last.finished_at.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "age_seconds": round((timezone.now() - last.finished_at).total_seconds(), 1),
                "rows": last.rows,
            }
            if last is not None
            else {"last_ok_at": None, "reason": "витрина ещё ни разу не пересчитывалась"}
        )
    return out


def audit_vault_health(*, days: int = 7) -> dict[str, Any]:
    """Целостность цепочки и кворум меток времени — ОТДЕЛЬНАЯ база
    (CLAUDE.md: audit_vault — отдельная БД). Недоступный vault сам по себе
    сигнал: молчать о нём нельзя, ронять из-за него весь ответ незачем."""
    since = timezone.now() - dt.timedelta(days=days)
    try:
        with connections["audit"].cursor() as cursor:
            cursor.execute("SELECT count(*) FROM audit_entry")
            (entries,) = cursor.fetchone()

            cursor.execute(
                """
                SELECT ok, entries_checked, first_broken_seq, verified_at
                FROM audit_chain_verification_run ORDER BY verified_at DESC LIMIT 1
                """
            )
            run = cursor.fetchone()

            cursor.execute(
                """
                SELECT count(*),
                       count(*) FILTER (WHERE tsa_status = 'attested'),
                       count(*) FILTER (WHERE tsa_status = 'unattested'),
                       count(*) FILTER (WHERE tsa_status = 'fake'),
                       count(*) FILTER (WHERE jsonb_array_length(
                           COALESCE(tsa_failures, '[]'::jsonb)) > 0)
                FROM audit_checkpoint WHERE created_at >= %s
                """,
                [since],
            )
            cp_total, attested, unattested, fake, with_failures = cursor.fetchone()

            cursor.execute(
                """
                SELECT seq_from, seq_to, tsa_status,
                       jsonb_array_length(COALESCE(timestamps, '[]'::jsonb)),
                       jsonb_array_length(COALESCE(tsa_failures, '[]'::jsonb)),
                       created_at
                FROM audit_checkpoint ORDER BY seq_to DESC LIMIT 1
                """
            )
            checkpoint = cursor.fetchone()
    except Exception as exc:  # noqa: BLE001 — недоступность vault не должна ронять ответ
        return {"available": False, "reason": str(exc)}

    return {
        "metric": "health_audit",
        "generated_at": _now_iso(),
        "source": "api",
        "days": days,
        "entries_total": entries,
        "chain_verification": (
            {
                "ok": run[0],
                "entries_checked": run[1],
                "first_broken_seq": run[2],
                "verified_at": run[3].astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "age_seconds": round((timezone.now() - run[3]).total_seconds(), 1),
            }
            if run is not None
            else {"ok": None, "reason": "прогонов проверки цепочки ещё не было"}
        ),
        "checkpoints_window": {
            "total": cp_total,
            "attested": attested,
            "unattested": unattested,
            "fake": fake,
            "quorum_rate": _share(attested, cp_total),
            "with_failures": with_failures,
        },
        "last_checkpoint": (
            {
                "seq_from": checkpoint[0],
                "seq_to": checkpoint[1],
                "tsa_status": checkpoint[2],
                "timestamp_layers": checkpoint[3],
                "failures": checkpoint[4],
                "created_at": checkpoint[5].astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "age_seconds": round((timezone.now() - checkpoint[5]).total_seconds(), 1),
            }
            if checkpoint is not None
            else {"seq_to": None, "reason": "чекпойнтов ещё нет"}
        ),
    }
