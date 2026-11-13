from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("contract-types", views.ContractTypeListView.as_view(), name="contract-types"),
    path("spheres", views.SphereListView.as_view(), name="spheres"),
    path("work-types", views.WorkTypeListView.as_view(), name="work-types"),
    path("material-catalog", views.MaterialCatalogListView.as_view(), name="material-catalog"),
    path("units", views.UnitListView.as_view(), name="units"),
    path(
        "checklist-recommendations",
        views.ChecklistRecommendationsView.as_view(),
        name="checklist-recommendations",
    ),
]
