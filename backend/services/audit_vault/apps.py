from django.apps import AppConfig


class AuditVaultConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "services.audit_vault"
    label = "audit_vault"
    verbose_name = "Audit Vault"

    def ready(self) -> None:
        from django.conf import settings

        from common import worm

        from . import metrics
        from .storage import CHECKPOINT_KEY_PREFIX

        metrics.register()
        # ADR-136: режим WORM (R2 Bucket Lock) из кода не проверяется —
        # предупреждение в лог при старте, если S3 вообще настроен.
        if settings.AWS_S3_ENDPOINT_URL:
            worm.log_startup_notice(
                bucket=settings.AUDIT_VAULT_BUCKET_NAME, prefixes=(CHECKPOINT_KEY_PREFIX,)
            )
