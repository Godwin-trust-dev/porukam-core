from django.apps import AppConfig


class DeadlinesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.deadlines"
    label = "deadlines"
    verbose_name = "Доменные дедлайны"

    def ready(self) -> None:
        from . import metrics

        metrics.register()
