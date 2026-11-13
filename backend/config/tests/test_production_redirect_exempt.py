"""SECURE_REDIRECT_EXEMPT прод-настроек: пути, опрашиваемые по plain-HTTP в
обход nginx (healthcheck, Prometheus-скрейп, /internal/ метрики ADR-145), не
должны уводиться SSL-редиректом в несуществующий TLS на 8000 — иначе они
молча перестают работать (обнаружено вживую 02.09 на /internal/).

Полный импорт config.settings.production в тестах невозможен (обязательные
env без дефолтов), поэтому список достаётся из исходника через ast — тест
проверяет ровно те литералы, что уедут в прод.
"""

import ast
import re
from pathlib import Path

PRODUCTION_PY = Path(__file__).resolve().parents[1] / "settings" / "production.py"


def _redirect_exempt() -> list[str]:
    tree = ast.parse(PRODUCTION_PY.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "SECURE_REDIRECT_EXEMPT" for t in node.targets
        ):
            value = ast.literal_eval(node.value)
            assert isinstance(value, list)
            return value
    raise AssertionError("SECURE_REDIRECT_EXEMPT не найден в production.py")


def _is_exempt(path: str) -> bool:
    # Семантика SecurityMiddleware: pattern.search(request.path.lstrip("/")).
    patterns = [re.compile(raw) for raw in _redirect_exempt()]
    return any(pattern.search(path.lstrip("/")) for pattern in patterns)


def test_internal_metrics_exempt_from_ssl_redirect():
    for path in (
        "/internal/v1/metrics/pulse",
        "/internal/v1/metrics/geography",
        "/v1/health",
        "/metrics",
    ):
        assert _is_exempt(path), path


def test_regular_traffic_still_redirected():
    """Исключение не должно расползтись на обычные пути: для внешних клиентов
    редирект на https обязателен (HSTS-контур)."""
    for path in ("/v1/contracts", "/v1/health/extra", "/metricsplus", "/api/internal/"):
        assert not _is_exempt(path), path
