"""`/a/<token>` — ручка без авторизации в корне сайта (config/urls.py)."""

from __future__ import annotations

from .urls import public_urlpatterns as urlpatterns

__all__ = ["urlpatterns"]
