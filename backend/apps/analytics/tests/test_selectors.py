"""Селекторы метрик поверх витрин (§9.1). Данные витрин создаются напрямую —
приложение не импортирует чужие модели, и тесты тоже: сквозная проверка «от
реального договора до витрины» живёт в backend/tests/test_analytics_marts.py.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.analytics import selectors
from apps.analytics.models import (
    ConstructorStepEvent,
    InstallEvent,
    MartContractLifecycle,
    MartDailyPulse,
    MartDailyPulseSlice,
    MartUserCohort,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

# Строки, которых НЕ ДОЛЖНО быть ни в одном ответе: аналитика без
# персональных данных — условие совместимости с crypto-shredding (§1 п.3).
FORBIDDEN_KEYS = {
    "phone",
    "email",
    "full_name",
    "name_encrypted",
    "address",
    "geo",
    "ip",
    "raw_ip",
    "contract_text",
    "form_data",
}


def _today() -> dt.date:
    return timezone.now().astimezone(dt.UTC).date()


def _keys(payload: object) -> set[str]:
    found: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            found.add(str(key))
            found |= _keys(value)
    elif isinstance(payload, list):
        for item in payload:
            found |= _keys(item)
    return found


def test_pulse_returns_dense_day_series() -> None:
    """✅ Ряд плотный: день без событий присутствует нулями, а не пропущен —
    иначе средняя за 7 дней считалась бы по 3 дням и врала."""
    MartDailyPulse.objects.create(day=_today(), registrations=5, contracts_signed=2)
    payload = selectors.pulse(days=7)
    assert len(payload["days"]) == 7
    assert payload["days"][-1]["registrations"] == 5
    assert payload["days"][0]["registrations"] == 0


def test_pulse_registrations_by_country_comes_from_slices() -> None:
    """✅ Разрез по странам берётся из витрины разрезов (§8.2)."""
    day = _today()
    MartDailyPulse.objects.create(day=day, registrations=3)
    MartDailyPulseSlice.objects.create(
        day=day, country="RU", locale="ru", source="phone", registrations=2
    )
    MartDailyPulseSlice.objects.create(
        day=day, country="KZ", locale="ru", source="social", registrations=1
    )
    payload = selectors.pulse(days=2)
    assert payload["days"][-1]["registrations_by_country"] == {"RU": 2, "KZ": 1}


def test_pulse_abandoned_step_is_none_without_behavioural_events() -> None:
    """✅ Шаг отвала пуст, пока слой событий конструктора молчит: ноль или
    выдуманный шаг здесь были бы неправдой (§1 п.1)."""
    MartDailyPulse.objects.create(day=_today(), abandoned_drafts=4)
    payload = selectors.pulse(days=1)
    assert payload["days"][-1]["abandoned_drafts"] == 4
    assert payload["days"][-1]["abandoned_step"] is None


def test_pulse_abandoned_step_uses_constructor_events() -> None:
    """✅ Когда события конструктора есть — отдаётся самый частый шаг ухода."""
    now = timezone.now()
    for _ in range(3):
        ConstructorStepEvent.objects.create(
            step_code="stages", action=ConstructorStepEvent.Action.LEFT, occurred_at=now
        )
    ConstructorStepEvent.objects.create(
        step_code="parties", action=ConstructorStepEvent.Action.LEFT, occurred_at=now
    )
    MartDailyPulse.objects.create(day=_today(), abandoned_drafts=1)
    assert selectors.pulse(days=1)["days"][-1]["abandoned_step"] == "stages"


def test_geography_live_country_requires_signed_contract() -> None:
    """✅ §4.2: регистрации без договоров живой страну не делают."""
    now = timezone.now()
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000001",
        cohort_week=_today(),
        registered_at=now,
        country="KZ",
        locale="ru",
        contour="GLOBAL",
        source="phone",
    )
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000002",
        cohort_week=_today(),
        registered_at=now,
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    MartContractLifecycle.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000a1",
        signed_at=now,
        customer_country="RU",
        contractor_country="RU",
        pair_key="a:b",
    )
    countries = {row["code"]: row for row in selectors.geography(window_days=30)["countries"]}
    assert countries["RU"]["is_live"] is True
    assert countries["KZ"]["is_live"] is False


def test_geography_counts_cross_country_share() -> None:
    """✅ Кросс-страновые договоры — метрика, ради которой блок и существует."""
    now = timezone.now()
    MartContractLifecycle.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000b1",
        signed_at=now,
        customer_country="RU",
        contractor_country="KZ",
        is_cross_country=True,
        pair_key="a:b",
    )
    MartContractLifecycle.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000b2",
        signed_at=now,
        customer_country="RU",
        contractor_country="RU",
        is_cross_country=False,
        pair_key="a:c",
    )
    cross = selectors.geography(window_days=30)["cross_country"]
    assert cross == {"signed_window": 2, "cross_window": 1, "share": 0.5}


def test_geography_dynamics_is_dense_per_country() -> None:
    """✅ Динамика — плотный ряд по каждой стране: разворот тренда виден
    только на ряду, а не на итоге (§5.1)."""
    day = _today()
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000003",
        cohort_week=day,
        registered_at=timezone.now(),
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    MartDailyPulseSlice.objects.create(
        day=day, country="RU", locale="ru", source="phone", registrations=1
    )
    series = selectors.geography(window_days=5)["country_dynamics"]["RU"]
    assert len(series) == 5
    assert series[-1] == {"day": day.isoformat(), "n": 1}
    assert series[0]["n"] == 0


def test_funnel_activation_conversion_and_auto_share() -> None:
    """✅ Активация — первый ПОДПИСАННЫЙ договор; доля автоприёмок — главный
    guardrail (§5.2, §6)."""
    now = timezone.now()
    for index, signed in enumerate([True, False, False, False]):
        MartUserCohort.objects.create(
            user_id=f"00000000-0000-0000-0000-00000000010{index}",
            cohort_week=_today(),
            registered_at=now,
            country="RU",
            locale="ru",
            contour="RU",
            source="phone",
            first_contract_signed_at=now if signed else None,
        )
    MartContractLifecycle.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000c1",
        drafted_at=now,
        signed_at=now,
        leaves=3,
        milestones_submitted=10,
        milestones_accepted_explicit=8,
        milestones_accepted_auto=2,
        pair_key="a:b",
    )
    payload = selectors.funnel(window_days=30)
    assert payload["activation"]["conversion"] == 0.25
    assert payload["acceptance"]["auto_share"] == 0.2
    assert payload["depth"]["leaves_per_contract_avg"] == 3.0


def test_funnel_abandonment_reports_missing_step_honestly() -> None:
    """✅ Число брошенных черновиков считается, шаг — нет, и ответ говорит
    почему (§5.2, §8.1)."""
    payload = selectors.funnel(window_days=30)
    assert payload["abandonment"]["abandoned_step"] is None
    assert "конструктора" in payload["abandonment"]["abandoned_step_reason"]


def test_acquisition_reports_invites_as_unavailable_not_zero() -> None:
    """✅ Ноль в K-факторе читался бы как «виральности нет»; верное
    утверждение — «сущности приглашения в домене нет» (§5.3). Причина ведёт
    к проработке, которая ждёт решения владельца."""
    invites = selectors.acquisition(window_days=30)["invites"]
    assert invites["available"] is False
    assert invites["k_factor"] is None
    assert "ContractInvite" in invites["reason"]


def test_acquisition_moving_averages() -> None:
    """✅ Расхождение 7- и 28-дневной кривых — ранний признак разворота (§5.1),
    поэтому обе считаются здесь, а не на глаз в отчёте."""
    day = _today()
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000201",
        cohort_week=day,
        registered_at=timezone.now(),
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    daily = selectors.acquisition(window_days=7)["daily"]
    assert daily[-1]["registrations"] == 1
    # Один человек в последний день окна: средняя за 7 дней — 1/7.
    assert daily[-1]["ma7"] == 0.14
    assert daily[-1]["cumulative_total"] == 1


def test_cohorts_counts_returning_pairs() -> None:
    """✅ Договор с ПРЕЖНИМ контрагентом — признак, что платформа стала
    местом, где оформляют, а не разовым инструментом (§5.4)."""
    now = timezone.now()
    for index, pair in enumerate(["a:b", "a:b", "a:c"]):
        MartContractLifecycle.objects.create(
            contract_id=f"00000000-0000-0000-0000-00000000030{index}",
            signed_at=now + dt.timedelta(minutes=index),
            pair_key=pair,
        )
    repeat = selectors.cohorts(weeks=4)["repeat_pairs"]
    assert repeat["signed_contracts"] == 3
    assert repeat["with_returning_pair"] == 1


def test_languages_priority_skips_reviewed_locales() -> None:
    """✅ Очередь на вычитку — только машинные пакеты: вычитывать надо те
    языки, на которых реально работают (§4.2, §4.3)."""
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000401",
        cohort_week=_today(),
        registered_at=timezone.now(),
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    payload = selectors.languages(window_days=30)
    locales = {row["locale"]: row for row in payload["interface_locales"]}
    assert locales["ru"]["quality"] == "reviewed"
    assert all(row["locale"] != "ru" for row in payload["proofreading_priority"])


@pytest.mark.parametrize(
    "call",
    [
        lambda: selectors.pulse(days=3),
        lambda: selectors.geography(window_days=3),
        lambda: selectors.acquisition(window_days=3),
        lambda: selectors.funnel(window_days=3),
        lambda: selectors.languages(window_days=3),
        lambda: selectors.cohorts(weeks=2),
        lambda: selectors.health(days=3),
    ],
)
def test_no_personal_data_in_any_response(call) -> None:  # type: ignore[no-untyped-def]
    """✅ §1 п.3: ни имени, ни телефона, ни адреса, ни геометки, ни текста
    договора. Это и делает аналитический контур совместимым с уничтожением
    ключа субъекта — удалять там нечего."""
    MartDailyPulse.objects.create(day=_today(), registrations=1)
    assert not (_keys(call()) & FORBIDDEN_KEYS)


def test_pulse_median_is_decimal_free_in_json() -> None:
    """✅ Decimal из витрины отдаётся числом, а не строкой Decimal(...)."""
    MartDailyPulse.objects.create(
        day=_today(), contracts_signed=1, median_leaves_in_signed=Decimal("3.00")
    )
    assert selectors.pulse(days=1)["days"][-1]["median_leaves_in_signed"] == 3.0


def test_geography_treats_language_as_first_class_dimension() -> None:
    """✅ §4: язык — такой же первоклассный разрез, как страна: тот же набор
    полей, та же динамика, то же правило «живой»."""
    now = timezone.now()
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000501",
        cohort_week=_today(),
        registered_at=now,
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    MartContractLifecycle.objects.create(
        contract_id="00000000-0000-0000-0000-0000000005a1",
        signed_at=now,
        customer_country="RU",
        contractor_country="KZ",
        customer_locale="ru",
        contractor_locale="kk",
        is_cross_country=True,
        is_cross_language=True,
        pair_key="a:b",
    )
    payload = selectors.geography(window_days=30)
    country_keys = set(payload["countries"][0])
    language_keys = set(payload["languages"][0])
    assert country_keys == language_keys, "разрезы должны быть симметричны"

    languages = {row["code"]: row for row in payload["languages"]}
    assert languages["ru"]["is_live"] is True
    assert languages["kk"]["is_live"] is True
    assert payload["cross_language"]["cross_window"] == 1
    assert payload["cross_language"]["share"] == 1.0
    assert set(payload["language_dynamics"]) == set(languages)


def test_geography_reports_unfilled_dimensions_separately() -> None:
    """✅ «Страна не выбрана» и «язык не задан» — не география, а онбординг:
    пока доля высока, выводы по разрезам считаются по меньшинству."""
    now = timezone.now()
    rows = [("RU", "chosen", "ru"), ("", "never_set", ""), ("", "never_set", "")]
    for index, (country, country_source, locale) in enumerate(rows):
        MartUserCohort.objects.create(
            user_id=f"00000000-0000-0000-0000-00000000060{index}",
            cohort_week=_today(),
            registered_at=now,
            country=country,
            country_source=country_source,
            locale=locale,
            contour="GLOBAL",
            source="phone",
        )
    payload = selectors.geography(window_days=30)
    assert payload["country_not_chosen"] == {
        "users": 2,
        "share": 0.6667,
        # Причина известна всегда: сюда попадают и «не выбрал вовсе», и
        # стартовый GLOBAL Google-входа — см. test_global_country_code_is_not_a_country.
        "by_reason": {"never_set": 2, "global_default": 0},
    }
    assert payload["locale_not_set"] == {"users": 2, "share": 0.6667}


def test_funnel_negotiation_is_built_from_contract_statuses() -> None:
    """✅ Базовая единица продукта — договор и его статус, поэтому воронка
    согласования строится по статусам, а не по приглашениям (§5.2).
    Конверсия приглашённой стороны в подпись — гипотеза §11 >= 0.5."""
    now = timezone.now()
    rows = [
        ("draft", False, False),
        ("under_review", True, False),
        ("rejected_by_counterparty", True, False),
        ("signed", True, True),
    ]
    for index, (status, sent, signed) in enumerate(rows):
        MartContractLifecycle.objects.create(
            contract_id=f"00000000-0000-0000-0000-00000000070{index}",
            negotiation_status=status,
            drafted_at=now - dt.timedelta(hours=5),
            sent_at=now - dt.timedelta(hours=4) if sent else None,
            frozen_at=now - dt.timedelta(hours=2) if signed else None,
            signed_at=now if signed else None,
            pair_key=f"a:{index}",
        )
    negotiation = selectors.funnel(window_days=30)["negotiation"]
    assert negotiation["contracts_created"] == 4
    assert negotiation["by_status"]["draft"] == 1
    assert negotiation["by_status"]["rejected_by_counterparty"] == 1
    response = negotiation["counterparty_response"]
    assert response["sent_for_review"] == 3
    assert response["signed"] == 1
    assert response["rejected"] == 1
    assert response["still_waiting"] == 1
    assert response["conversion"] == 0.3333
    # Где договор проводит время — вход для «резкое падение = сломан конструктор».
    assert negotiation["step_hours"]["draft_to_sent_p50"] == 1.0


def test_acquisition_arrival_counts_entry_into_someone_elses_deal() -> None:
    """✅ §5.1: основной сценарий входа — человек приходит оформить уже
    состоявшуюся договорённость. Считается по фактам: стал стороной
    договора, который создал НЕ он."""
    now = timezone.now()
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000801",
        cohort_week=_today(),
        registered_at=now - dt.timedelta(hours=3),
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
        first_foreign_party_at=now - dt.timedelta(hours=2),
    )
    MartUserCohort.objects.create(
        user_id="00000000-0000-0000-0000-000000000802",
        cohort_week=_today(),
        registered_at=now - dt.timedelta(hours=3),
        country="RU",
        locale="ru",
        contour="RU",
        source="phone",
    )
    arrival = selectors.acquisition(window_days=7)["arrival"]
    assert arrival["registrations"] == 2
    assert arrival["became_party_within_window"] == 1
    assert arrival["share_within_window"] == 0.5
    assert arrival["hours_to_first_deal_p50"] == 1.0


def test_global_country_code_is_not_a_country() -> None:
    """✅ `GLOBAL` в User.country_code — НЕ страна: apps.accounts проставляет
    его автоматически при входе через Google. Считать его страной значило бы
    рисовать на карте продукта фантом (на проде 31.08 — 5 аккаунтов из 9).
    Витрина кладёт таких в «страна не выбрана», но помнит причину."""
    now = timezone.now()
    for index, (country, source) in enumerate(
        [("RU", "chosen"), ("", "never_set"), ("", "global_default"), ("", "global_default")]
    ):
        MartUserCohort.objects.create(
            user_id=f"00000000-0000-0000-0000-00000000090{index}",
            cohort_week=_today(),
            registered_at=now,
            country=country,
            country_source=source,
            locale="ru",
            contour="GLOBAL",
            source="social",
        )
    payload = selectors.geography(window_days=30)
    codes = [row["code"] for row in payload["countries"]]
    assert "GLOBAL" not in codes, "GLOBAL не должен появляться как страна"
    assert payload["country_not_chosen"]["users"] == 3
    # Разбивка отвечает на вопрос, в какой ветке онбординга дыра.
    assert payload["country_not_chosen"]["by_reason"] == {
        "never_set": 1,
        "global_default": 2,
    }


# --------------------------------------------------------------------------
# Установки приложения и активные пользователи (ADR-171)
# --------------------------------------------------------------------------
def test_pulse_carries_install_and_active_user_numbers() -> None:
    """✅ Установки и активные пользователи едут в том же дневном ряду, что и
    остальной пульс: два источника для одного дня рано или поздно разойдутся."""
    MartDailyPulse.objects.create(
        day=_today(),
        install_prompt_shown=10,
        install_clicks=4,
        pwa_installs=3,
        play_clicks=2,
        standalone_opens=7,
        active_users_day=5,
        active_users_7d=11,
    )
    today_row = selectors.pulse(days=3)["days"][-1]
    assert today_row["install_prompt_shown"] == 10
    assert today_row["install_clicks"] == 4
    assert today_row["pwa_installs"] == 3
    assert today_row["play_clicks"] == 2
    assert today_row["standalone_opens"] == 7
    assert today_row["active_users_day"] == 5
    assert today_row["active_users_7d"] == 11


def test_installs_sums_the_window_and_keeps_the_funnel_shares() -> None:
    """✅ Воронка «показали -> нажали -> поставили» за окно, с долями."""
    MartDailyPulse.objects.create(
        day=_today(), install_prompt_shown=10, install_clicks=5, pwa_installs=2
    )
    payload = selectors.installs(window_days=7)
    assert payload["totals"]["prompt_shown"] == 10
    assert payload["prompt_to_click"] == 0.5
    assert payload["click_to_install"] == 0.4
    assert len(payload["daily"]) == 7


def test_installs_share_is_none_without_a_single_prompt() -> None:
    """✅ Ноль показов — None, а не 0%: «никому не предлагали» и «предложили,
    не поставили» — разные диагнозы."""
    payload = selectors.installs(window_days=3)
    assert payload["prompt_to_click"] is None
    assert payload["totals"]["pwa_installed"] == 0


def test_installs_break_down_by_platform_without_storing_user_agent() -> None:
    """✅ Разрез по платформам — грубые корзины из слоя событий."""
    InstallEvent.objects.create(kind="pwa_installed", platform="android", source="site")
    InstallEvent.objects.create(kind="install_click", platform="android", source="site")
    InstallEvent.objects.create(kind="pwa_installed", platform="ios", source="site")
    payload = selectors.installs(window_days=7)
    assert payload["by_platform"]["android"] == {"pwa_installed": 1, "install_click": 1}
    assert payload["by_source"]["site"] == 3


def test_installs_do_not_claim_play_store_numbers() -> None:
    """✅ Установки в Google Play видит только консоль — здесь честное
    «недоступно» с объяснением, а не ноль, который прочитали бы как факт."""
    payload = selectors.installs(window_days=7)
    assert payload["play_installs"]["available"] is False
    assert "play-console" in payload["play_installs"]["reason"]


def test_acquisition_includes_installs_as_a_channel() -> None:
    """✅ Установка — канал привлечения, поэтому блок едет в acquisition."""
    payload = selectors.acquisition(window_days=7)
    assert payload["installs"]["window_days"] == 7
    assert "totals" in payload["installs"]


def test_install_payloads_contain_no_personal_data() -> None:
    """✅ Тот же запрет, что для остальных метрик: ни UA, ни IP, ни телефона."""
    InstallEvent.objects.create(kind="pwa_installed", platform="android")
    assert not (_keys(selectors.installs(window_days=7)) & FORBIDDEN_KEYS)
