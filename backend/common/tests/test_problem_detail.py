"""Человекочитаемый `detail` в problem+json для стандартных DRF-исключений.

Отсмотр 2026-08-23: на /contracts/new/parties пользователь видел
`{'non_field_errors': [ErrorDetail(string='…', code='invalid')]}` — Python-repr
`response.data` вместо текста. Хендлер обязан сворачивать структуру ошибок в
строки и отдавать исходную структуру в context.errors.
"""

from __future__ import annotations

from rest_framework.exceptions import NotFound, ValidationError

from common.api.exceptions import flatten_error_detail, problem_json_exception_handler


class TestFlattenErrorDetail:
    def test_non_field_errors_without_prefix(self) -> None:
        data = {"non_field_errors": ["нужен client_option или contract_type_code"]}
        assert flatten_error_detail(data) == ["нужен client_option или contract_type_code"]

    def test_field_errors_prefixed(self) -> None:
        data = {"title": ["Обязательное поле."], "jurisdiction": ["Слишком длинно."]}
        assert flatten_error_detail(data) == [
            "title: Обязательное поле.",
            "jurisdiction: Слишком длинно.",
        ]

    def test_nested_serializer_dotted_path_with_index(self) -> None:
        data = {"stages": [{"amount": ["Обязательное поле."]}]}
        assert flatten_error_detail(data) == ["stages.0.amount: Обязательное поле."]

    def test_multiple_messages_of_one_field_not_indexed(self) -> None:
        data = {"handle": ["Слишком короткий.", "Недопустимые символы."]}
        assert flatten_error_detail(data) == [
            "handle: Слишком короткий.",
            "handle: Недопустимые символы.",
        ]

    def test_detail_key_without_prefix(self) -> None:
        assert flatten_error_detail({"detail": "Страница не найдена."}) == ["Страница не найдена."]

    def test_plain_string(self) -> None:
        assert flatten_error_detail("просто текст") == ["просто текст"]


class TestProblemJSONHandler:
    def test_validation_error_detail_is_human_readable(self) -> None:
        exc = ValidationError("нужен client_option или contract_type_code")
        response = problem_json_exception_handler(exc, {})
        assert response is not None
        assert response.status_code == 400
        assert response.data["code"] == "invalid_request"
        assert response.data["detail"] == "нужен client_option или contract_type_code"
        assert "ErrorDetail" not in response.data["detail"]
        assert "{" not in response.data["detail"]

    def test_field_validation_error_lists_fields_and_keeps_structure(self) -> None:
        exc = ValidationError({"title": ["Обязательное поле."]})
        response = problem_json_exception_handler(exc, {})
        assert response is not None
        assert response.data["detail"] == "title: Обязательное поле."
        assert response.data["context"]["errors"] == {"title": ["Обязательное поле."]}

    def test_not_found_detail_readable(self) -> None:
        response = problem_json_exception_handler(NotFound(), {})
        assert response is not None
        assert response.status_code == 404
        assert "ErrorDetail" not in response.data["detail"]
        assert "{" not in response.data["detail"]
