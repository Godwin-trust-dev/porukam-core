"""application/problem+json (RFC 9457) — tech-spec.md §7.5.

`code` — машиночитаемый, из закрытого реестра, никогда не локализуется.
Полный реестр кодов живёт в OpenAPI (drf-spectacular); здесь — только форма
тела ответа, общая для DomainAPIError (common/api/exceptions.py) и мидлварей,
которые не проходят через DRF exception handler (например,
apps.accounts.middleware.ActingProfileMiddleware).
"""

from __future__ import annotations

from typing import Any

PROBLEM_CONTENT_TYPE = "application/problem+json"

_ERRORS_BASE_URL = "https://api.trust.example/errors"


def problem_body(
    *,
    status: int,
    code: str,
    title: str,
    detail: str = "",
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "type": f"{_ERRORS_BASE_URL}/{code}",
        "title": title,
        "status": status,
        "code": code,
        "detail": detail,
        "context": context or {},
    }
