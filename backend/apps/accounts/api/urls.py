from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("auth/otp/request", views.OTPRequestView.as_view(), name="otp-request"),
    path("auth/otp/verify", views.OTPVerifyView.as_view(), name="otp-verify"),
    # Вход «e-mail + код» (ADR-168) — те же две ступени, что у телефона.
    path("auth/email/request", views.EmailOTPRequestView.as_view(), name="email-otp-request"),
    path("auth/email/verify", views.EmailOTPVerifyView.as_view(), name="email-otp-verify"),
    path(
        "auth/google/authorize-url",
        views.GoogleAuthorizeUrlView.as_view(),
        name="google-authorize-url",
    ),
    path("auth/google/callback", views.GoogleCallbackView.as_view(), name="google-callback"),
    path("auth/token/refresh", views.TokenRefreshView.as_view(), name="token-refresh"),
    path("auth/logout", views.LogoutView.as_view(), name="logout"),
    path("users/me", views.MeView.as_view(), name="user-me"),
    path("users/me/devices", views.DeviceListCreateView.as_view(), name="user-devices"),
    path(
        "users/me/devices/<int:device_id>/device-key",
        views.DeviceKeyCreateView.as_view(),
        name="user-device-key",
    ),
    path(
        "users/me/drive/connect/authorize-url",
        views.GoogleDriveConnectAuthorizeUrlView.as_view(),
        name="drive-connect-authorize-url",
    ),
    path(
        "users/me/drive/connect/callback",
        views.GoogleDriveConnectCallbackView.as_view(),
        name="drive-connect-callback",
    ),
    path(
        "users/me/drive/connect",
        views.GoogleDriveGrantStatusView.as_view(),
        name="drive-connect-status",
    ),
]
