from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("notifications", views.NotificationListView.as_view(), name="notification-list"),
    path(
        "notifications/read-all",
        views.NotificationReadAllView.as_view(),
        name="notification-read-all",
    ),
    path(
        "notifications/<uuid:notification_id>/read",
        views.NotificationReadView.as_view(),
        name="notification-read",
    ),
    path(
        "notification-settings",
        views.NotificationSettingsView.as_view(),
        name="notification-settings",
    ),
    path("push/config", views.PushConfigView.as_view(), name="push-config"),
    path(
        "push-subscriptions",
        views.PushSubscriptionView.as_view(),
        name="push-subscriptions",
    ),
    path(
        "push-subscriptions/unsubscribe",
        views.PushUnsubscribeView.as_view(),
        name="push-unsubscribe",
    ),
    # ADR-176: нативный канал обёртки поверх Web Push.
    path("device-tokens", views.DeviceTokenView.as_view(), name="device-tokens"),
    path(
        "device-tokens/unregister",
        views.DeviceTokenUnregisterView.as_view(),
        name="device-token-unregister",
    ),
]
