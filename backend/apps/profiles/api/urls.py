from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("profiles", views.ProfileCreateView.as_view(), name="profile-create"),
    path("profiles/<uuid:profile_id>", views.ProfileDetailView.as_view(), name="profile-detail"),
    path(
        "profiles/<uuid:profile_id>/avatar",
        views.ProfileAvatarView.as_view(),
        name="profile-avatar",
    ),
    path(
        "profiles/<uuid:profile_id>/work-areas",
        views.ProfileWorkAreasView.as_view(),
        name="profile-work-areas",
    ),
    path(
        "profiles/<uuid:profile_id>/portfolio/projects",
        views.PortfolioProjectListCreateView.as_view(),
        name="portfolio-project-list",
    ),
    path(
        "portfolio/projects/<uuid:project_id>",
        views.PortfolioProjectDetailView.as_view(),
        name="portfolio-project-detail",
    ),
    path(
        "portfolio/projects/<uuid:project_id>/photo",
        views.PortfolioProjectPhotoView.as_view(),
        name="portfolio-project-photo",
    ),
    path(
        "portfolio/projects/<uuid:project_id>/photos",
        views.PortfolioProjectPhotosView.as_view(),
        name="portfolio-project-photos",
    ),
    path(
        "portfolio/projects/<uuid:project_id>/photos/<uuid:photo_id>",
        views.PortfolioProjectPhotoItemView.as_view(),
        name="portfolio-project-photo-item",
    ),
    path(
        "portfolio/projects/<uuid:project_id>/photos/<uuid:photo_id>/primary",
        views.PortfolioProjectPhotoPrimaryView.as_view(),
        name="portfolio-project-photo-primary",
    ),
    path(
        "portfolio/projects/<uuid:project_id>/publish",
        views.PortfolioProjectPublishView.as_view(),
        name="portfolio-project-publish",
    ),
]
