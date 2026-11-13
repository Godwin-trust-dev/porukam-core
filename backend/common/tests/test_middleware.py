import uuid

import structlog
from django.http import HttpResponse
from django.test import RequestFactory

from common.logging import REQUEST_ID_HEADER
from common.middleware import RequestContextMiddleware


def _middleware(get_response=lambda request: HttpResponse("ok")):
    return RequestContextMiddleware(get_response=get_response)


def test_generates_request_id_when_header_absent():
    request = RequestFactory().get("/v1/health")
    response = _middleware()(request)

    assert request.request_id
    assert response[REQUEST_ID_HEADER] == request.request_id


def test_reuses_incoming_request_id_header():
    incoming = str(uuid.uuid4())
    request = RequestFactory().get("/v1/health", HTTP_X_REQUEST_ID=incoming)
    response = _middleware()(request)

    assert request.request_id == incoming
    assert response[REQUEST_ID_HEADER] == incoming


def test_binds_request_id_into_structlog_context_during_call():
    captured = {}

    def get_response(request):
        captured.update(structlog.contextvars.get_contextvars())
        return HttpResponse("ok")

    request = RequestFactory().get("/v1/health")
    _middleware(get_response)(request)

    assert captured["request_id"] == request.request_id
    assert captured["method"] == "GET"
    assert captured["path"] == "/v1/health"


def test_clears_context_after_response():
    request = RequestFactory().get("/v1/health")
    _middleware()(request)

    assert structlog.contextvars.get_contextvars() == {}


def test_binds_acting_profile_id_when_already_parsed():
    captured = {}

    def get_response(request):
        captured.update(structlog.contextvars.get_contextvars())
        return HttpResponse("ok")

    profile_id = uuid.uuid4()
    request = RequestFactory().get("/v1/health")
    request.acting_profile_id = profile_id

    _middleware(get_response)(request)

    assert captured["acting_profile_id"] == str(profile_id)
