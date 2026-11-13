from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("handles", views.HandleSearchView.as_view(), name="handle-search"),
    path("handles/<str:handle>", views.HandlePublicView.as_view(), name="handle-public"),
    path("users/me/handle", views.MyHandleView.as_view(), name="user-handle"),
    path("users/me/phonebook", views.PhonebookView.as_view(), name="user-phonebook"),
    path("users/me/contacts", views.ContactListCreateView.as_view(), name="user-contacts"),
    path(
        "users/me/contacts/<uuid:contact_id>",
        views.ContactDetailView.as_view(),
        name="user-contact-detail",
    ),
    path(
        "users/me/reputation-link", views.ReputationLinkView.as_view(), name="user-reputation-link"
    ),
    path(
        "users/me/privacy-consents",
        views.PrivacyConsentsView.as_view(),
        name="user-privacy-consents",
    ),
    path("users/me/consents", views.ConsentListCreateView.as_view(), name="user-consents"),
    path(
        "users/me/privacy-consents-global",
        views.GlobalPrivacyConsentsView.as_view(),
        name="user-privacy-consents-global",
    ),
    path("groups", views.GroupListCreateView.as_view(), name="group-list"),
    path("groups/<uuid:group_id>/join", views.GroupJoinView.as_view(), name="group-join"),
    path("groups/<uuid:group_id>/leave", views.GroupLeaveView.as_view(), name="group-leave"),
    path(
        "groups/<uuid:group_id>/handle",
        views.GroupHandleView.as_view(),
        name="group-handle",
    ),
    path("groups/<uuid:group_id>/logo", views.GroupLogoView.as_view(), name="group-logo"),
    # Портфолио объединения (ADR-128): проект и фото ВСЕГДА скоупятся
    # объединением из URL — чужой id даёт 404, а не 403.
    path(
        "groups/<uuid:group_id>/portfolio/projects",
        views.GroupPortfolioProjectListCreateView.as_view(),
        name="group-portfolio-projects",
    ),
    path(
        "groups/<uuid:group_id>/portfolio/projects/<uuid:project_id>",
        views.GroupPortfolioProjectDetailView.as_view(),
        name="group-portfolio-project-detail",
    ),
    path(
        "groups/<uuid:group_id>/portfolio/projects/<uuid:project_id>/photos",
        views.GroupPortfolioPhotosView.as_view(),
        name="group-portfolio-photos",
    ),
    path(
        "groups/<uuid:group_id>/portfolio/projects/<uuid:project_id>/photos/<uuid:photo_id>",
        views.GroupPortfolioPhotoItemView.as_view(),
        name="group-portfolio-photo-item",
    ),
    path(
        "groups/<uuid:group_id>/portfolio/projects/<uuid:project_id>"
        "/photos/<uuid:photo_id>/primary",
        views.GroupPortfolioPhotoPrimaryView.as_view(),
        name="group-portfolio-photo-primary",
    ),
    path(
        "groups/<uuid:group_id>/requests/<int:membership_id>/<str:decision>",
        views.GroupJoinRequestDecisionView.as_view(),
        name="group-request-decision",
    ),
    path("groups/<uuid:group_id>", views.GroupDetailView.as_view(), name="group-detail"),
    path(
        "groups/<uuid:group_id>/members",
        views.GroupMemberListCreateView.as_view(),
        name="group-members",
    ),
    path(
        "groups/<uuid:group_id>/members/<uuid:member_id>",
        views.GroupMemberDetailView.as_view(),
        name="group-member-detail",
    ),
]
