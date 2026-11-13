from django.apps import AppConfig


class L10nConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.l10n"
    label = "l10n"
    verbose_name = "Локализация"
