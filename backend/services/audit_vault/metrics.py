"""Метрики Audit Vault (tech-spec.md §11: "разрыв цепочки Audit Vault";
docs/tasks/fundament-2.md ЭФ.6 п.2: "метрики Audit Vault (длина цепочки,
время последнего checkpoint)"). Коллектор — на своих моделях (AuditEntry/
AuditCheckpoint/ChainVerificationRun), поэтому живёт здесь, а не в
common/metrics.py: остальные приложения не имеют права трогать эти модели
напрямую (services/audit_vault/api.py — единственная точка входа,
docstring services/audit_vault/models.py), но сам audit_vault — можно."""

from __future__ import annotations

import logging

from django.db import Error as DjangoDBError
from django.utils import timezone
from prometheus_client import REGISTRY
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.registry import Collector

from .models import AuditCheckpoint, AuditEntry, ChainVerificationRun

logger = logging.getLogger(__name__)
_NAMESPACE = "porukam"


class AuditVaultCollector(Collector):
    def describe(self):  # type: ignore[no-untyped-def]
        return [
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_chain_length", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_checkpoint_age_seconds", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_chain_ok", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_chain_verification_age_seconds", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_checkpoint_attested", ""),
            GaugeMetricFamily(f"{_NAMESPACE}_audit_vault_checkpoint_timestamps", ""),
        ]

    def collect(self):  # type: ignore[no-untyped-def]
        now = timezone.now()

        try:
            chain_length = AuditEntry.objects.count()
            last_checkpoint = (
                AuditCheckpoint.objects.order_by("-seq_to")
                .values("created_at", "tsa_status", "timestamps")
                .first()
            )
            last_checkpoint_at = last_checkpoint["created_at"] if last_checkpoint else None
            last_run = ChainVerificationRun.objects.order_by("-verified_at").first()
        except DjangoDBError:
            logger.warning("metrics: сбой запроса состояния Audit Vault", exc_info=True)
            return

        length_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_audit_vault_chain_length",
            "Число записей в цепочке Audit Vault (AuditEntry.seq последней записи).",
        )
        length_metric.add_metric([], chain_length)
        yield length_metric

        checkpoint_age_metric = GaugeMetricFamily(
            f"{_NAMESPACE}_audit_vault_checkpoint_age_seconds",
            "Возраст последнего ежесуточного checkpoint'а, секунд (без данных — цепочка пуста).",
        )
        if last_checkpoint_at is not None:
            checkpoint_age_metric.add_metric([], (now - last_checkpoint_at).total_seconds())
            yield checkpoint_age_metric

        # ADR-135 п.4: недобор кворума TSA — алерт (fake-метки dev/test
        # метрику не отдают: там нет кворума, нечего заверять).
        if last_checkpoint is not None and last_checkpoint["tsa_status"] in (
            "attested",
            "unattested",
        ):
            attested_metric = GaugeMetricFamily(
                f"{_NAMESPACE}_audit_vault_checkpoint_attested",
                "1 — последний суточный checkpoint заверен кворумом TSA (ADR-135), 0 — недобор",
            )
            attested_metric.add_metric([], 1 if last_checkpoint["tsa_status"] == "attested" else 0)
            yield attested_metric
            layers_metric = GaugeMetricFamily(
                f"{_NAMESPACE}_audit_vault_checkpoint_timestamps",
                "Число успешных меток TSA на последнем суточном checkpoint'е.",
            )
            layers_metric.add_metric([], len(last_checkpoint["timestamps"] or []))
            yield layers_metric

        if last_run is not None:
            ok_metric = GaugeMetricFamily(
                f"{_NAMESPACE}_audit_vault_chain_ok",
                "1 — последняя периодическая verify_chain() прошла без разрывов, 0 — разрыв найден",
            )
            ok_metric.add_metric([], 1 if last_run.ok else 0)
            yield ok_metric

            run_age_metric = GaugeMetricFamily(
                f"{_NAMESPACE}_audit_vault_chain_verification_age_seconds",
                "Возраст последнего прогона verify_chain(), секунд.",
            )
            run_age_metric.add_metric([], (now - last_run.verified_at).total_seconds())
            yield run_age_metric


def register() -> None:
    REGISTRY.register(AuditVaultCollector())
