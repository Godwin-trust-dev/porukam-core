from django.apps import AppConfig


class AuthorityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.authority"
    label = "authority"
    verbose_name = "Полномочия"
