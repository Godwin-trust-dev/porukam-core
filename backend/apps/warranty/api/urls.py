from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "contracts/<uuid:contract_id>/warranty-claims",
        views.ContractWarrantyClaimListCreateView.as_view(),
        name="contract-warranty-claims",
    ),
    path("warranty-claims", views.WarrantyClaimListView.as_view(), name="warranty-claim-list"),
    path(
        "warranty-claims/<uuid:claim_id>/decline",
        views.WarrantyClaimDeclineView.as_view(),
        name="warranty-claim-decline",
    ),
    path(
        "warranty-claims/<uuid:claim_id>/fix-submitted",
        views.WarrantyFixSubmittedView.as_view(),
        name="warranty-claim-fix-submitted",
    ),
    path(
        "warranty-claims/<uuid:claim_id>/satisfy",
        views.WarrantyClaimSatisfyView.as_view(),
        name="warranty-claim-satisfy",
    ),
    path(
        "warranty-claims/<uuid:claim_id>/contest",
        views.WarrantyClaimContestView.as_view(),
        name="warranty-claim-contest",
    ),
]
