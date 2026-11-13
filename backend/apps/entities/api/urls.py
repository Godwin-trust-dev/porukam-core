from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "business-entities",
        views.BusinessEntityOnboardView.as_view(),
        name="business-entity-onboard",
    ),
    path(
        "business-entities/<uuid:entity_id>",
        views.BusinessEntityDetailView.as_view(),
        name="business-entity-detail",
    ),
    path(
        "business-entities/<uuid:entity_id>/claim-methods",
        views.ClaimMethodsView.as_view(),
        name="business-entity-claim-methods",
    ),
    path(
        "business-entities/<uuid:entity_id>/claim",
        views.ClaimView.as_view(),
        name="business-entity-claim",
    ),
    path(
        "business-entities/<uuid:entity_id>/claim/dispute",
        views.ClaimDisputeView.as_view(),
        name="business-entity-claim-dispute",
    ),
    path(
        "business-entities/<uuid:entity_id>/epochs",
        views.EpochListView.as_view(),
        name="business-entity-epochs",
    ),
]
