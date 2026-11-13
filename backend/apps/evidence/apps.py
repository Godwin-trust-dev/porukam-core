from django.apps import AppConfig
from django.conf import settings


class EvidenceConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.evidence"
    label = "evidence"
    verbose_name = "Доказательства"

    def ready(self) -> None:
        # ADR-136: режим WORM — инфраструктурное требование, из кода не
        # проверяемое (R2 Bucket Lock), поэтому хотя бы предупреждение в лог
        # при старте каждого процесса (core/celery). Только при реальном
        # S3-хранилище: с фейком (тесты/локалка) предупреждать не о чем.
        if settings.EVIDENCE_OBJECT_STORE == "s3":
            from common import worm

            from .storage import EVIDENCE_KEY_PREFIX

            worm.log_startup_notice(
                bucket=settings.EVIDENCE_BUCKET_NAME, prefixes=(EVIDENCE_KEY_PREFIX,)
            )
