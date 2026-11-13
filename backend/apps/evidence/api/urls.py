from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "milestones/<uuid:milestone_id>/evidence",
        views.MilestoneEvidenceListCreateView.as_view(),
        name="milestone-evidence",
    ),
    path(
        "disputes/<uuid:dispute_id>/evidence",
        views.DisputeEvidenceListCreateView.as_view(),
        name="dispute-evidence",
    ),
    path(
        "evidence/retention-policy",
        views.RetentionPolicyView.as_view(),
        name="evidence-retention-policy",
    ),
    path("evidence/<uuid:evidence_id>", views.EvidenceDetailView.as_view(), name="evidence-detail"),
    path(
        "evidence/<uuid:evidence_id>/thumbnail",
        views.EvidenceThumbnailView.as_view(),
        name="evidence-thumbnail",
    ),
    path(
        "evidence/<uuid:evidence_id>/download",
        views.EvidenceDownloadView.as_view(),
        name="evidence-download",
    ),
    path(
        "evidence/<uuid:evidence_id>/verify",
        views.EvidenceVerifyView.as_view(),
        name="evidence-verify",
    ),
    path(
        "evidence/<uuid:evidence_id>/backup",
        views.EvidenceBackupView.as_view(),
        name="evidence-backup",
    ),
]
