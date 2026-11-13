from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "contracts/<uuid:contract_id>/messages",
        views.ContractMessagesView.as_view(),
        name="contract-messages",
    ),
    path(
        "contracts/<uuid:contract_id>/messages/read",
        views.ContractMessagesReadView.as_view(),
        name="contract-messages-read",
    ),
    path("messages/threads", views.ThreadsView.as_view(), name="message-threads"),
]
