"""JSON-логи без ПД со сквозным request_id (docs/tasks/fundament-2.md ЭФ.6,
CLAUDE.md: "структурные логи в JSON").

structlog оборачивает stdlib `logging` через `ProcessorFormatter`
(`configure_structlog()` + `build_logging_config()`) — это даёт JSON+редактирование
ПД не только вызовам `structlog.get_logger()`, но и ЛЮБОМУ существующему
`logging.getLogger(__name__)` во всех приложениях/Celery/самом Django (в т.ч.
автоматическое логирование необработанных исключений `django.request`),
без правки каждого места вызова.

`redact_pii` — обязательный процессор в обеих цепочках (structlog- и
stdlib-происхождения, `shared_processors`/`foreign_pre_chain`): вычищает
телефоны/email по regex и известные ПД-поля по имени ключа, рекурсивно по
dict/list-значениям event dict — прежде, чем событие дойдёт до JSON-рендера.
Это защита "по построению" (греп по логам не находит телефонов, ЭФ.6
приёмка), а не ручная зачистка каждого вызова логгера.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

REQUEST_ID_HEADER = "X-Request-Id"

REDACTED = "[REDACTED]"
REDACTED_PHONE = "[REDACTED_PHONE]"
REDACTED_EMAIL = "[REDACTED_EMAIL]"

# Российский мобильный/городской номер в любом из обычных написаний:
# +79261234567, 89261234567, +7 926 123-45-67, 8(926)123-45-67...
_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)"
)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}")

# Поля, вычищаемые целиком по имени ключа независимо от того, похоже ли
# значение на телефон/email (ФИО и другие ПД regex'ом не ловятся надёжно).
_PII_KEYS = {
    "phone",
    "email",
    "full_name",
    "first_name",
    "last_name",
    "middle_name",
    "passport_series",
    "passport_number",
    "snils",
    "inn",
    "address",
}


def _redact_string(value: str) -> str:
    value = _PHONE_RE.sub(REDACTED_PHONE, value)
    value = _EMAIL_RE.sub(REDACTED_EMAIL, value)
    return value


def _redact_value(key: str, value: Any) -> Any:
    if key.lower() in _PII_KEYS:
        return REDACTED
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, dict):
        return {k: _redact_value(k, v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_redact_value(key, item) for item in value]
    return value


def redact_pii(logger: Any, method_name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """Процессор structlog: рекурсивно вычищает ПД из event dict."""
    return {key: _redact_value(key, value) for key, value in event_dict.items()}


timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

# Общая цепочка процессоров — используется и для событий, рождённых
# structlog.get_logger() напрямую, и как foreign_pre_chain для записей,
# пришедших из stdlib logging (Django/Celery/сторонние библиотеки).
shared_processors: list[Any] = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_logger_name,
    structlog.stdlib.add_log_level,
    timestamper,
    structlog.processors.StackInfoRenderer(),
    structlog.processors.format_exc_info,
    redact_pii,
]


def configure_structlog() -> None:
    """Вызывается один раз при старте процесса (config/settings/base.py) —
    настраивает structlog поверх stdlib logging (LOGGING в build_logging_config())."""
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def build_logging_config(*, log_level: str) -> dict[str, Any]:
    """dict для settings.LOGGING — единый JSON-формат во всех процессах
    (core/celery worker/celery beat/audit_vault), CLAUDE.md/ЭФ.6 п.1."""
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "json": {
                "()": structlog.stdlib.ProcessorFormatter,
                "processors": [
                    structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                    structlog.processors.JSONRenderer(),
                ],
                "foreign_pre_chain": shared_processors,
            },
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "json",
            },
        },
        "root": {
            "handlers": ["console"],
            "level": log_level,
        },
        "loggers": {
            "django": {"handlers": ["console"], "level": log_level, "propagate": False},
            "django.server": {"handlers": ["console"], "level": log_level, "propagate": False},
            "celery": {"handlers": ["console"], "level": log_level, "propagate": False},
        },
    }
