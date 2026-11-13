"""Dev-профиль: DEBUG, MinIO, Mailhog (dev-setup.md §2)."""

from .base import *  # noqa: F403
from .base import env

DEBUG = True
ALLOWED_HOSTS = ["*"]

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = env.str("MAILHOG_HOST", default="localhost")
EMAIL_PORT = env.int("MAILHOG_PORT", default=1025)
EMAIL_USE_TLS = False
