from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("disputes", views.DisputeListView.as_view(), name="dispute-list"),
    path("disputes/<uuid:dispute_id>", views.DisputeDetailView.as_view(), name="dispute-detail"),
    path(
        "disputes/<uuid:dispute_id>/respond",
        views.DisputeRespondView.as_view(),
        name="dispute-respond",
    ),
    path(
        "disputes/<uuid:dispute_id>/fix-requests",
        views.FixRequestListCreateView.as_view(),
        name="dispute-fix-requests",
    ),
    path(
        "disputes/<uuid:dispute_id>/fix-requests/<uuid:fix_request_id>/resubmit",
        views.FixRequestResubmitView.as_view(),
        name="dispute-fix-request-resubmit",
    ),
    path(
        "disputes/<uuid:dispute_id>/discount-proposal",
        views.DiscountProposalView.as_view(),
        name="dispute-discount-proposal",
    ),
    path(
        "disputes/<uuid:dispute_id>/discount-proposals/<uuid:agreement_id>/decline",
        views.DiscountProposalDeclineView.as_view(),
        name="dispute-discount-proposal-decline",
    ),
    path(
        "disputes/<uuid:dispute_id>/resolve",
        views.DisputeResolveView.as_view(),
        name="dispute-resolve",
    ),
    path("dispute-windows", views.DisputeWindowListView.as_view(), name="dispute-window-list"),
    path(
        "dispute-windows/<uuid:window_id>/contest",
        views.DisputeWindowContestView.as_view(),
        name="dispute-window-contest",
    ),
]
