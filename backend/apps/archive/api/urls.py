from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "contracts/<uuid:contract_id>/archive",
        views.ContractArchiveView.as_view(),
        name="contract-archive",
    ),
    path(
        "contracts/<uuid:contract_id>/archive/export",
        views.ContractArchiveExportView.as_view(),
        name="contract-archive-export",
    ),
    path(
        "contracts/<uuid:contract_id>/archive/export/<uuid:export_id>",
        views.ContractArchiveExportDetailView.as_view(),
        name="contract-archive-export-detail",
    ),
    path(
        "archive/links/<uuid:link_id>/revoke",
        views.ArchiveLinkRevokeView.as_view(),
        name="archive-link-revoke",
    ),
]

# Ручка без авторизации — монтируется в корне (`/a/<token>`), не под /v1
# (config/urls.py), письмо ведёт именно на неё (ADR-137).
public_urlpatterns = [
    path("a/<str:token>", views.archive_link_view, name="archive-link"),
]
