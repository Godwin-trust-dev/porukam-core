import json
import uuid

from django.test import RequestFactory

from apps.accounts.middleware import ActingProfileMiddleware


def _middleware():
    return ActingProfileMiddleware(get_response=lambda request: "ok")


def test_missing_header_leaves_acting_profile_id_none():
    request = RequestFactory().get("/v1/users/me")
    result = _middleware()(request)
    assert request.acting_profile_id is None
    assert result == "ok"


def test_valid_uuid_header_is_parsed():
    profile_id = uuid.uuid4()
    request = RequestFactory().get("/v1/users/me", HTTP_X_ACTING_PROFILE=str(profile_id))
    _middleware()(request)
    assert request.acting_profile_id == profile_id


def test_malformed_header_returns_400_problem_json():
    request = RequestFactory().get("/v1/users/me", HTTP_X_ACTING_PROFILE="not-a-uuid")
    response = _middleware()(request)
    assert response.status_code == 400
    assert response["Content-Type"] == "application/problem+json"
    assert json.loads(response.content)["code"] == "invalid_acting_profile_header"
