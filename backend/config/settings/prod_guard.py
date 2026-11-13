"""Guard прод-настроек (ADR-201): прод не должен молча стартовать на dev-дефолтах.

Контекст: почти все внешние провайдеры в base.py по умолчанию `fake`
(в памяти процесса / «принимает что угодно»), а вход через Google в режиме
`fake` пускает под ЛЮБЫМ адресом (код `sub|email`). Забытая переменная в
прод-.env превращалась в тихую дыру, health при этом оставался зелёным.

Функции здесь — чистые (над Mapping настроек), поэтому тестируются без
перезагрузки settings. Вызывается из production.py при импорте настроек, т.е.
на старте gunicorn/daphne, celery worker/beat и `manage.py migrate` в проде
(во всех прод-сервисах задан DJANGO_SETTINGS_MODULE=config.settings.production).

Два класса нарушений:
* ЖЁСТКИЕ — не обходятся ничем: fake Google-вход, любой OTP_FIXED_CODE,
  слабый/placeholder SECRET_KEY и PHONEBOOK_HASH_PEPPER, DEBUG=True,
  `*` в ALLOWED_HOSTS, опечатки в PROD_ALLOW_FAKE_PROVIDERS.
* МЯГКИЕ — fake-провайдеры остальных каналов. Допустимы, только если
  соответствующая функция выключена (SMS-фейк при PHONE_LOGIN_ENABLED=false)
  ИЛИ имя перечислено в PROD_ALLOW_FAKE_PROVIDERS (аварийный клапан владельца,
  чтобы выкатиться без простоя; после выкатки переменную убрать).
"""

from collections.abc import Mapping

from django.core.exceptions import ImproperlyConfigured

# Ключ клапана для фейкового SMS-шлюза (отдельной настройки у него нет:
# apps.accounts всегда использует FakeSMSGateway, реального шлюза в проекте нет).
SMS_GATEWAY_KEY = "SMS_GATEWAY"

# (имя настройки, допустимые «боевые» значения). Любое другое значение
# (в т.ч. "fake", пусто, опечатка) для прода считается фейком.
REAL_PROVIDER_VALUES: dict[str, frozenset[str]] = {
    "NOTIFICATIONS_EMAIL_PROVIDER": frozenset({"resend"}),
    "NOTIFICATIONS_PUSH_PROVIDER": frozenset({"webpush"}),
    "AUDIT_VAULT_TSA_PROVIDER": frozenset({"rfc3161"}),
    "PROFILE_AVATAR_STORE": frozenset({"s3"}),
    "EVIDENCE_OBJECT_STORE": frozenset({"s3"}),
    "ARCHIVE_OBJECT_STORE": frozenset({"s3"}),
    "EVIDENCE_DRIVE_PROVIDER": frozenset({"real"}),
}

# Допустимые имена в PROD_ALLOW_FAKE_PROVIDERS.
VALVE_KEYS: frozenset[str] = frozenset({*REAL_PROVIDER_VALUES, "GROUP_LOGO_STORE", SMS_GATEWAY_KEY})

MIN_SECRET_KEY_LENGTH = 32
_PLACEHOLDER_MARKERS = ("change-me", "insecure")


def _norm(value: object) -> str:
    return str(value if value is not None else "").strip().lower()


def _looks_placeholder(value: object) -> bool:
    text = _norm(value)
    return any(marker in text for marker in _PLACEHOLDER_MARKERS)


def _valve(cfg: Mapping[str, object]) -> set[str]:
    raw = cfg.get("PROD_ALLOW_FAKE_PROVIDERS") or []
    items = raw.split(",") if isinstance(raw, str) else list(raw)  # type: ignore[call-overload]
    return {str(item).strip().upper() for item in items if str(item).strip()}


def collect_production_violations(cfg: Mapping[str, object]) -> list[str]:
    """Возвращает ВСЕ нарушения разом (пустой список — настройки допустимы)."""
    violations: list[str] = []
    valve = _valve(cfg)

    # --- Жёсткие: клапаном не обходятся ---
    if _norm(cfg.get("GOOGLE_LOGIN_PROVIDER")) != "real":
        violations.append(
            "GOOGLE_LOGIN_PROVIDER должен быть 'real' (сейчас "
            f"{cfg.get('GOOGLE_LOGIN_PROVIDER')!r}): fake-вход пускает под любым адресом. "
            "Клапан PROD_ALLOW_FAKE_PROVIDERS на это не действует."
        )
    if cfg.get("OTP_FIXED_CODE"):
        violations.append(
            "OTP_FIXED_CODE задан: фиксированный код входа в production запрещён "
            "(уберите переменную из прод-.env). Клапан не действует."
        )
    secret = str(cfg.get("SECRET_KEY") or "")
    if len(secret) < MIN_SECRET_KEY_LENGTH or _looks_placeholder(secret):
        violations.append(
            f"DJANGO_SECRET_KEY пуст, короче {MIN_SECRET_KEY_LENGTH} символов или содержит "
            "placeholder (change-me/insecure): задайте случайный ключ."
        )
    if _looks_placeholder(cfg.get("PHONEBOOK_HASH_PEPPER")):
        violations.append(
            "PHONEBOOK_HASH_PEPPER содержит placeholder (change-me): задайте случайное значение."
        )
    if cfg.get("DEBUG"):
        violations.append("DEBUG=True в production запрещён.")
    hosts = cfg.get("ALLOWED_HOSTS") or []
    if any(str(h).strip() == "*" for h in hosts):  # type: ignore[attr-defined]
        violations.append("DJANGO_ALLOWED_HOSTS содержит '*': перечислите конкретные хосты.")
    for unknown in sorted(valve - VALVE_KEYS):
        violations.append(
            f"PROD_ALLOW_FAKE_PROVIDERS: неизвестное имя {unknown!r} "
            f"(допустимы: {', '.join(sorted(VALVE_KEYS))})."
        )

    # --- Мягкие: fake-провайдеры (клапан PROD_ALLOW_FAKE_PROVIDERS) ---
    native_push = _norm(cfg.get("NOTIFICATIONS_NATIVE_PUSH_PROVIDERS"))
    for name, real_values in REAL_PROVIDER_VALUES.items():
        if _norm(cfg.get(name)) in real_values or name in valve:
            continue
        if name == "NOTIFICATIONS_PUSH_PROVIDER" and native_push:
            continue  # только нативные каналы (rustore/fcm/hms): Web Push не обязателен
        violations.append(
            f"{name}={cfg.get(name)!r}: fake/неизвестный провайдер в production "
            f"(ожидается {'|'.join(sorted(real_values))}). Аварийно можно перечислить "
            f"{name} в PROD_ALLOW_FAKE_PROVIDERS."
        )
    group_logo = cfg.get("GROUP_LOGO_STORE")
    if group_logo and _norm(group_logo) != "s3" and "GROUP_LOGO_STORE" not in valve:
        violations.append(
            f"GROUP_LOGO_STORE={group_logo!r}: ожидается s3 (или пусто — тогда берётся "
            "PROFILE_AVATAR_STORE). Клапан: GROUP_LOGO_STORE."
        )
    if cfg.get("PHONE_LOGIN_ENABLED") and SMS_GATEWAY_KEY not in valve:
        violations.append(
            "PHONE_LOGIN_ENABLED=true, но реального SMS-шлюза нет (FakeSMSGateway): "
            "задайте PHONE_LOGIN_ENABLED=false. Аварийно: SMS_GATEWAY в PROD_ALLOW_FAKE_PROVIDERS."
        )
    return violations


def enforce_production_settings(cfg: Mapping[str, object]) -> None:
    """Бросает ImproperlyConfigured со списком ВСЕХ нарушений."""
    violations = collect_production_violations(cfg)
    if violations:
        lines = "\n".join(f"  {i}. {v}" for i, v in enumerate(violations, 1))
        raise ImproperlyConfigured("Небезопасные настройки для production (ADR-201):\n" + lines)
