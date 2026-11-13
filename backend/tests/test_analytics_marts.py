"""Сквозная проверка витрин аналитики: от реального договора до цифры
в /internal/v1/metrics (docs/tasks/marketing-metrics.md §8.3, §9.1).

Тест лежит ВНЕ apps/ намеренно: apps.analytics ничего не импортирует из
apps.* (контракт import-linter, ADR-145), и его собственные тесты — тоже.
Здесь же нужны настоящие доменные объекты, поэтому файл живёт в общем
backend/tests/, вне графа контрактов.

Главное, что проверяется, — цифры аналитики совпадают с тем, что произошло
в домене: они считаются из того же outbox, из которого строятся хроника
объекта и журнал аудита (§1 п.4).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.analytics import selectors, services
from apps.analytics.models import MartContractLifecycle, MartDailyPulse, MartUserCohort
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import (
    make_signed_contract_with_leaf,
    make_user,
)
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

TOKEN = "s3cr3t-metrics-token"


@pytest.fixture
def customer():
    return make_user("a001")


@pytest.fixture
def contractor():
    return make_user("a002")


@pytest.fixture
def signed(customer, contractor):
    """Подписанный договор с одним листом — стартовая точка всех проверок:
    аналитика считает по фактам жизненного цикла, а не по намерениям."""
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


def test_lifecycle_mart_mirrors_the_contract_path(signed) -> None:
    """✅ Витрина повторяет путь договора: черновик -> согласование ->
    заморозка -> подпись, с числом листьев и сторонами."""
    contract, _ = signed
    services.refresh_marts()

    row = MartContractLifecycle.objects.get(contract_id=contract.id)
    assert row.drafted_at is not None
    assert row.sent_at is not None
    assert row.frozen_at is not None
    assert row.signed_at is not None
    assert row.leaves >= 1
    assert row.pair_key != ""
    assert row.negotiation_status == "signed"


def test_user_cohort_mart_records_activation(signed, customer) -> None:
    """✅ Активация — первый ПОДПИСАННЫЙ договор, не регистрация (§5.2)."""
    services.refresh_marts()

    row = MartUserCohort.objects.get(user_id=customer.id)
    assert row.first_contract_signed_at is not None
    assert row.contracts_signed == 1
    assert row.cohort_week <= timezone.now().date()


def test_pulse_mart_counts_signed_contract_today(signed) -> None:
    """✅ Дневная витрина считается поверх жизненного цикла: подписанный
    сегодня договор виден в сегодняшней строке пульса."""
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    row = MartDailyPulse.objects.get(day=today)
    assert row.contracts_signed == 1
    assert row.activations >= 1


def test_explicit_acceptance_counts_to_north_star_and_auto_does_not(
    signed, customer, contractor
) -> None:
    """✅ §2: в северную звезду входит только ЯВНАЯ приёмка. Автоприёмка —
    фиксация пассивности, она guardrail (§6), и в NSM не идёт."""
    contract, leaf = signed
    milestones_services.start_milestone(leaf, user=customer)
    milestones_services.submit_milestone(leaf, user=contractor)
    leaf.refresh_from_db()
    milestones_services.accept_milestone(leaf, user=customer)
    services.refresh_marts()

    row = MartContractLifecycle.objects.get(contract_id=contract.id)
    assert row.milestones_accepted_explicit == 1
    assert row.milestones_accepted_auto == 0

    today = timezone.now().astimezone(dt.UTC).date()
    pulse_row = MartDailyPulse.objects.get(day=today)
    assert pulse_row.milestones_accepted_explicit == 1
    # Вторая ось северной звезды: ширина сети (§2).
    assert pulse_row.active_pairs == 1


def test_metrics_endpoint_returns_the_same_numbers_as_the_mart(signed) -> None:
    """✅ Эндпоинт — тонкая обёртка над витриной: цифра в ответе та же, что
    в таблице, а значит и та же, что видит пользователь в хронике."""
    services.refresh_marts()

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    with override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["*"]):
        response = client.get("/internal/v1/metrics/pulse?days=1")
    assert response.status_code == 200, response.content

    today = timezone.now().astimezone(dt.UTC).date()
    expected = MartDailyPulse.objects.get(day=today)
    assert response.data["days"][-1]["contracts_signed"] == expected.contracts_signed
    assert response.data["days"][-1]["activations"] == expected.activations


def test_health_reports_mart_freshness() -> None:
    """✅ Витрина, которая молча перестала пересчитываться, хуже
    отсутствующей — возраст последнего успешного прогона отдаётся наружу."""
    services.refresh_marts()
    marts = selectors.health(days=1)["marts"]
    assert set(marts) == set(services.MART_ORDER)
    assert marts["mart_daily_pulse"]["last_ok_at"] is not None


def test_geography_sees_both_party_countries(signed) -> None:
    """✅ География строится по явному выбору страны обеими сторонами (§4.1),
    а не по геодетекции — её в контуре нет вовсе."""
    services.refresh_marts()
    payload = selectors.geography(window_days=30)
    assert payload["ip_vs_selected"]["available"] is False
    assert any(row["is_live"] for row in payload["countries"])


def test_active_month_flags_are_independent(customer) -> None:
    """✅ §5.4: активен в M1 и вернулся в M3 — засчитывается в ОБА месяца.
    По «последней активности» этот вопрос не восстановить, поэтому признаки
    считаются при пересчёте витрины, а не на чтении."""
    User.objects.filter(pk=customer.pk).update(created_at=timezone.now() - dt.timedelta(days=200))
    customer.refresh_from_db()
    for offset_days in (45, 100):
        OutboxEvent.objects.create(
            topic="milestone.submitted",
            occurred_at=customer.created_at + dt.timedelta(days=offset_days),
            actor={"user_id": str(customer.id)},
            subject={"type": "milestone", "id": str(customer.id)},
        )
    # Логин активностью не считается — событие account.* не должно ничего дать.
    OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=customer.created_at + dt.timedelta(days=190),
        actor={"user_id": str(customer.id)},
        subject={"type": "user", "id": str(customer.id)},
    )
    services.refresh_mart("mart_user_cohorts")

    row = MartUserCohort.objects.get(user_id=customer.id)
    assert (row.active_m1, row.active_m3, row.active_m6) == (True, True, False)


# --------------------------------------------------------------------------
# Активные пользователи и установки приложения (ADR-171)
# --------------------------------------------------------------------------
def test_active_users_count_people_not_actions(customer) -> None:
    """✅ DAU — уникальные ЛЮДИ: два действия одного человека за день дают
    единицу, а не двойку. Именно на этот вопрос («сколько реальных людей»)
    отвечает строка, и сложение действий на него не отвечает."""
    for topic in ("milestone.submitted", "milestone.accepted"):
        OutboxEvent.objects.create(
            topic=topic,
            occurred_at=timezone.now(),
            actor={"user_id": str(customer.id)},
            subject={"type": "milestone", "id": str(customer.id)},
        )
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    row = MartDailyPulse.objects.get(day=today)
    assert row.active_users_day == 1
    assert row.active_users_7d == 1


def test_login_alone_is_not_activity(customer) -> None:
    """🚫 §5.4: вход в аккаунт активностью НЕ считается. Иначе метрика
    отвечала бы на вопрос «сколько сессий», а спрошено было про людей,
    которые продуктом пользуются."""
    OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=timezone.now(),
        actor={"user_id": str(customer.id)},
        subject={"type": "user", "id": str(customer.id)},
    )
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    assert MartDailyPulse.objects.get(day=today).active_users_day == 0


def test_weekly_active_users_catch_yesterday_but_daily_do_not(customer, contractor) -> None:
    """✅ WAU — скользящее окно 7 дней ВКЛЮЧАЯ этот день, и это уникальные
    люди, а не сумма семи DAU: вчерашний человек попадает в недельное окно
    сегодня, но не в сегодняшний DAU."""
    OutboxEvent.objects.create(
        topic="milestone.submitted",
        occurred_at=timezone.now() - dt.timedelta(days=1),
        actor={"user_id": str(contractor.id)},
        subject={"type": "milestone", "id": str(contractor.id)},
    )
    OutboxEvent.objects.create(
        topic="milestone.submitted",
        occurred_at=timezone.now(),
        actor={"user_id": str(customer.id)},
        subject={"type": "milestone", "id": str(customer.id)},
    )
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    row = MartDailyPulse.objects.get(day=today)
    assert row.active_users_day == 1
    assert row.active_users_7d == 2


def test_guest_install_does_not_inflate_active_users(customer) -> None:
    """✅ Установка авторизованным человеком — действие и считается.
    🚫 Установка гостя не считается: у него нет user_id, а приписывать ему
    устройство означало бы снимать отпечаток, которого мы не снимаем."""
    services.record_install_event(kind="pwa_installed", user_id=customer.id)
    services.record_install_event(kind="pwa_installed")
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    row = MartDailyPulse.objects.get(day=today)
    assert row.active_users_day == 1
    # Обе установки при этом посчитаны как установки — гость ставит приложение
    # ровно так же, и в воронку установки он входит.
    assert row.pwa_installs == 2


def test_install_funnel_lands_in_the_daily_mart() -> None:
    """✅ Дневные агрегаты установки считаются в том же прогоне, что и
    остальной пульс, — иначе они жили бы отдельной правдой."""
    for kind in ("install_prompt_shown", "install_click", "play_click", "standalone_open"):
        services.record_install_event(kind=kind, platform="android")
    services.refresh_marts()

    today = timezone.now().astimezone(dt.UTC).date()
    row = MartDailyPulse.objects.get(day=today)
    assert (row.install_prompt_shown, row.install_clicks) == (1, 1)
    assert (row.play_clicks, row.standalone_opens) == (1, 1)

    payload = selectors.installs(window_days=7)
    assert payload["totals"]["prompt_shown"] == 1
    assert payload["by_platform"]["android"]["install_click"] == 1
