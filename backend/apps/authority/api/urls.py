from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "business-entities/<uuid:entity_id>/representatives",
        views.RepresentativeListCreateView.as_view(),
        name="representative-list",
    ),
    path(
        "business-entities/<uuid:entity_id>/representatives/<uuid:representative_id>",
        views.RepresentativeDetailView.as_view(),
        name="representative-detail",
    ),
    path(
        "business-entities/<uuid:entity_id>/signing-authorities",
        views.SigningAuthorityListCreateView.as_view(),
        name="signing-authority-list",
    ),
    path(
        "business-entities/<uuid:entity_id>/signing-authorities/<uuid:authority_id>",
        views.SigningAuthorityDetailView.as_view(),
        name="signing-authority-detail",
    ),
]
