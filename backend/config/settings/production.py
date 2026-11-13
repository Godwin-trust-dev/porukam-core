"""Прод-профиль (dev-setup.md §2, §4.1; docs/tasks/fundament-2.md ЭФ.7).

Провайдеро-независим: настройки не завязаны на конкретное облако (см.
docs/tasks/fundament-2-delta-global.md; фактический прод — hoster.kz +
Cloudflare-прокси, не РФ-облако). SECURE_PROXY_SSL_HEADER ниже совместим с обоими
режимами TLS из ЭФ.7 (прямой certbot и за Cloudflare) — в обоих случаях
TLS терминируется на nginx перед core, который получает обычный HTTP
с X-Forwarded-Proto.
"""

from .base import *  # noqa: F403
from .base import env
from .prod_guard import enforce_production_settings

DEBUG = False
PRODUCTION_PROFILE = True
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS")

# №8 отсмотра 2026-08-18 (холодный каталог до 16 с): без CONN_MAX_AGE Django
# открывает НОВОЕ соединение с Postgres на каждый запрос — TCP+TLS+auth на
# каждый справочник. Персистентные соединения на время воркера (gthread,
# --threads 4 → до 4-х на БД) + health-check перед переиспользованием, чтобы
# идловый разрыв (файрвол/рестарт БД) не дал 500 на первом запросе после
# паузы. Только прод: тестам pytest-django нужны короткоживущие соединения.
for _db in DATABASES.values():  # noqa: F405 — default + audit
    _db["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
    _db["CONN_HEALTH_CHECKS"] = True

SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# /v1/health и /metrics опрашиваются НАПРЯМУЮ по внутренней docker-сети в
# обход nginx (Docker HEALTHCHECK самого core, Prometheus-скрейп —
# прод-конфиг/prometheus.yml, target core:8000) — у этого
# трафика нет X-Forwarded-Proto (nginx его не видел), поэтому без
# исключения SECURE_SSL_REDIRECT увёл бы каждый такой запрос в 301 на
# https:// того же порта 8000, где TLS не поднят — обнаружено вживую при
# локальной проверке ЭФ.7: healthcheck/RED-метрики молча переставали
# работать. Внешний edge (nginx) уже сам делает http->https редирект на
# 80 — второй редирект здесь для обычного трафика избыточен для внешних
# клиентов, но обязателен как есть для них.
# /internal/ — та же природа трафика (ADR-145): эндпоинты метрик наружу
# nginx не проксирует, к ним ходят только изнутри docker-сети / с самой ВМ
# по plain-HTTP; без исключения 301 уводил в несуществующий TLS на 8000 —
# обнаружено 02.09 при первой настоящей проверке ANALYTICS_METRICS_TOKEN
# на проде. Защита /internal/ — токен + список IP (InternalMetricsPermission),
# не транспортный редирект.
SECURE_REDIRECT_EXEMPT = [r"^v1/health$", r"^metrics$", r"^internal/"]

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = env.str("EMAIL_HOST")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_USE_TLS = True
EMAIL_HOST_USER = env.str("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env.str("EMAIL_HOST_PASSWORD", default="")

# ADR-201: guard в самом конце — видит итоговые значения. Срабатывает при
# импорте настроек во всех прод-процессах (web, celery, manage.py migrate).
enforce_production_settings(
    {
        name: globals().get(name)
        for name in (
            "SECRET_KEY",
            "DEBUG",
            "ALLOWED_HOSTS",
            "OTP_FIXED_CODE",
            "PHONEBOOK_HASH_PEPPER",
            "GOOGLE_LOGIN_PROVIDER",
            "PHONE_LOGIN_ENABLED",
            "PROD_ALLOW_FAKE_PROVIDERS",
            "NOTIFICATIONS_PUSH_PROVIDER",
            "NOTIFICATIONS_NATIVE_PUSH_PROVIDERS",
            "NOTIFICATIONS_EMAIL_PROVIDER",
            "AUDIT_VAULT_TSA_PROVIDER",
            "PROFILE_AVATAR_STORE",
            "GROUP_LOGO_STORE",
            "EVIDENCE_OBJECT_STORE",
            "ARCHIVE_OBJECT_STORE",
            "EVIDENCE_DRIVE_PROVIDER",
        )
    }
)
