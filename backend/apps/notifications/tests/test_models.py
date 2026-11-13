"""БД-инварианты apps.notifications — на живом PostgreSQL (CLAUDE.md: CHECK/
EXCLUDE не проверяются на sqlite)."""

from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.notifications.models import NotificationSettings

pytestmark = pytest.mark.django_db


def test_in_app_enabled_false_violates_check_constraint():
    """CLAUDE.md/domain-model.md §17: ЛК-канал отключить нельзя — гарантия
    на уровне БД, не только сервисного слоя."""
    user = User.objects.create(trust_id="trust-notif-settings-1", phone="+79990900101")
    with pytest.raises(IntegrityError), transaction.atomic():
        NotificationSettings.objects.create(user=user, in_app_enabled=False)
