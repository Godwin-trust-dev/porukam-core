from __future__ import annotations

from datetime import timedelta

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.accounts.models import User
from apps.notifications.metrics import UndeliveredLegalNotificationsCollector
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-notif-metrics-{suffix}", phone=f"+7999092{suffix}")


def _notification(recipient: User, *, legal_significance: bool, placed: bool, age_minutes: int):
    notification = Notification.objects.create(
        recipient=recipient,
        template="milestone_acceptance_reminder",
        legal_significance=legal_significance,
        placed_in_cabinet_at=timezone.now() if placed else None,
    )
    Notification.objects.filter(pk=notification.pk).update(
        created_at=timezone.now() - timedelta(minutes=age_minutes)
    )
    return notification


def _overdue_count() -> float:
    for family in UndeliveredLegalNotificationsCollector().collect():
        return family.samples[0].value
    return 0.0


@override_settings(NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES=60)
def test_reports_zero_when_nothing_overdue():
    assert _overdue_count() == 0


@override_settings(NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES=60)
def test_counts_legal_notification_not_placed_past_threshold():
    recipient = _user("01")
    _notification(recipient, legal_significance=True, placed=False, age_minutes=90)

    assert _overdue_count() == 1


@override_settings(NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES=60)
def test_ignores_notification_still_within_threshold():
    recipient = _user("02")
    _notification(recipient, legal_significance=True, placed=False, age_minutes=10)

    assert _overdue_count() == 0


@override_settings(NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES=60)
def test_ignores_placed_notification_regardless_of_age():
    recipient = _user("03")
    _notification(recipient, legal_significance=True, placed=True, age_minutes=90)

    assert _overdue_count() == 0


@override_settings(NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES=60)
def test_ignores_non_legally_significant_notification():
    recipient = _user("04")
    _notification(recipient, legal_significance=False, placed=False, age_minutes=90)

    assert _overdue_count() == 0
