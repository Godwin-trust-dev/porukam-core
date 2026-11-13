from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "auth/esia/authorize-url",
        views.EsiaAuthorizeUrlView.as_view(),
        name="esia-authorize-url",
    ),
    path("auth/esia/callback", views.EsiaCallbackView.as_view(), name="esia-callback"),
    path(
        "identity/verification-gate-demo",
        views.VerificationGateDemoView.as_view(),
        name="identity-verification-gate-demo",
    ),
]
