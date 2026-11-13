"""Тестовый профиль (pytest-django). Реальный PostgreSQL — EXCLUDE/CHECK
констрейнты не проверяются на sqlite (CLAUDE.md)."""

from .base import *  # noqa: F403

DEBUG = False

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]

EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

# Тестам не нужен .env — фиксированные значения секретов-заглушек.
OTP_FIXED_CODE = "111111"
ENVELOPE_MASTER_KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="
PHONEBOOK_HASH_PEPPER = "test-phonebook-pepper-not-for-prod"

# ADR-113: в тестах channel layer — in-memory (без Redis; группы живут в
# процессе — ровно то, что нужно WebsocketCommunicator-тестам).
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
