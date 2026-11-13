"""ASGI-вход (ADR-113): HTTP — прежний Django (sync-вьюхи крутятся в
threadpool asgiref, поведение API не меняется), WebSocket — чат
apps.messaging. Прод переходит с `config.wsgi` на этот модуль
(gunicorn -k uvicorn.workers.UvicornWorker, docker-compose.prod.yml)."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.production")

# Django инициализируется ДО импорта consumers (внутри — модели).
django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402

from apps.messaging.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": URLRouter(websocket_urlpatterns),
    }
)
