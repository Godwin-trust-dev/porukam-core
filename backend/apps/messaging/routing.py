"""WebSocket-маршруты apps.messaging (ADR-113) — подключаются в config/asgi.py."""

from __future__ import annotations

from django.urls import path

from .consumers import ChatConsumer

websocket_urlpatterns = [
    path("ws/chat", ChatConsumer.as_asgi()),
]
