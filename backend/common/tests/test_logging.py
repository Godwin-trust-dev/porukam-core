"""docs/tasks/fundament-2.md ЭФ.6 п.1: "греп по логам не находит телефонов"
— здесь на уровне процессора structlog (юнит), сквозной сценарий через
реальный логгер — apps/accounts/tests/test_services.py::
test_otp_rate_limit_does_not_leak_phone_into_logs."""

from __future__ import annotations

from common.logging import REDACTED, REDACTED_EMAIL, REDACTED_PHONE, redact_pii

_RAW_PHONE_FORMATS = [
    "+79261234567",
    "89261234567",
    "+7 926 123-45-67",
    "8 (926) 123-45-67",
]


def test_redacts_phone_regardless_of_formatting():
    for raw in _RAW_PHONE_FORMATS:
        event = redact_pii(None, "info", {"event": f"otp.request phone={raw}"})
        assert raw not in event["event"]
        assert REDACTED_PHONE in event["event"]


def test_redacts_known_pii_keys_regardless_of_value_shape():
    event = redact_pii(None, "info", {"phone": "+79261234567", "email": "a@b.com", "count": 3})
    assert event["phone"] == REDACTED
    assert event["email"] == REDACTED
    assert event["count"] == 3


def test_redacts_email_pattern_in_free_text():
    event = redact_pii(None, "info", {"event": "contact ivan@example.com about it"})
    assert "ivan@example.com" not in event["event"]
    assert REDACTED_EMAIL in event["event"]


def test_redacts_recursively_in_nested_dicts_and_lists():
    event = redact_pii(
        None,
        "info",
        {
            "actor": {"phone": "+79261234567", "role": "user"},
            "subjects": [{"phone": "89261234567"}, {"id": "abc"}],
        },
    )
    assert event["actor"]["phone"] == REDACTED
    assert event["actor"]["role"] == "user"
    assert event["subjects"][0]["phone"] == REDACTED
    assert event["subjects"][1]["id"] == "abc"


def test_leaves_non_pii_fields_untouched():
    event = redact_pii(None, "info", {"request_id": "abc-123", "status": 200})
    assert event == {"request_id": "abc-123", "status": 200}
