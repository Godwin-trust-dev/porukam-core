"""Недоставленные юрзначимые уведомления (tech-spec.md §11: "недоставку
юридически значимых уведомлений (не размещено в ЛК)"; docs/tasks/
fundament-2.md ЭФ.6 п.3). Юрканал — placed_in_cabinet_at (ADR-057); если
уведомление с legal_significance=True не размещено в ЛК дольше
settings.NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES — это уже операционная
проблема (сбой очереди/воркера place_notification), а не штатная
задержка."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db import Error as DjangoDBError
from django.utils import timezone
from prometheus_client import REGISTRY
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.registry import Collector

from .models import Notification

logger = logging.getLogger(__name__)
_NAMESPACE = "porukam"
_DEFAULT_THRESHOLD_MINUTES = 60


class UndeliveredLegalNotificationsCollector(Collector):
    def describe(self):  # type: ignore[no-untyped-def]
        return [GaugeMetricFamily(f"{_NAMESPACE}_notifications_undelivered_legal_overdue", "")]

    def collect(self):  # type: ignore[no-untyped-def]
        threshold_minutes = getattr(
            settings, "NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES", _DEFAULT_THRESHOLD_MINUTES
        )
        cutoff = timezone.now() - timedelta(minutes=threshold_minutes)
        try:
            overdue = Notification.objects.filter(
                legal_significance=True,
                placed_in_cabinet_at__isnull=True,
                created_at__lt=cutoff,
            ).count()
        except DjangoDBError:
            logger.warning("metrics: сбой запроса недоставленных уведомлений", exc_info=True)
            return

        metric = GaugeMetricFamily(
            f"{_NAMESPACE}_notifications_undelivered_legal_overdue",
            (
                "Юрзначимые уведомления, не размещённые в ЛК дольше "
                f"{threshold_minutes} мин (NOTIFICATIONS_UNDELIVERED_ALERT_MINUTES)."
            ),
        )
        metric.add_metric([], overdue)
        yield metric


def register() -> None:
    REGISTRY.register(UndeliveredLegalNotificationsCollector())
