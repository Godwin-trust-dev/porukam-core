from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "contracts/<uuid:contract_id>/milestones",
        views.MilestoneListCreateView.as_view(),
        name="milestone-list-create",
    ),
    path(
        "contracts/<uuid:contract_id>/milestones/loan-schedule",
        views.MilestoneLoanScheduleView.as_view(),
        name="milestone-loan-schedule",
    ),
    path(
        "milestones/<uuid:milestone_id>",
        views.MilestoneDetailView.as_view(),
        name="milestone-detail",
    ),
    path(
        "milestones/<uuid:milestone_id>/checklist-items",
        views.ChecklistItemListCreateView.as_view(),
        name="milestone-checklist-items",
    ),
    path(
        "checklist-items/<uuid:item_id>",
        views.ChecklistItemDetailView.as_view(),
        name="checklist-item-detail",
    ),
    path(
        "milestones/<uuid:milestone_id>/checklist-recommendations",
        views.ChecklistRecommendationsView.as_view(),
        name="milestone-checklist-recommendations",
    ),
    path(
        "milestones/<uuid:milestone_id>/materials",
        views.ContractMaterialListCreateView.as_view(),
        name="milestone-materials",
    ),
    # --- Э4.6: гейт, сдача, приёмка (docs/tasks/etap-4.md) -------------------
    path(
        "milestones/<uuid:milestone_id>/gate",
        views.MilestoneGateStatusView.as_view(),
        name="milestone-gate-status",
    ),
    path(
        "milestones/<uuid:milestone_id>/start",
        views.MilestoneStartView.as_view(),
        name="milestone-start",
    ),
    path(
        "milestones/<uuid:milestone_id>/timeline",
        views.MilestoneTimelineView.as_view(),
        name="milestone-timeline",
    ),
    path(
        "milestones/<uuid:milestone_id>/acceptance",
        views.MilestoneAcceptanceStatusView.as_view(),
        name="milestone-acceptance-status",
    ),
    path(
        "milestones/<uuid:milestone_id>/submit",
        views.MilestoneSubmitView.as_view(),
        name="milestone-submit",
    ),
    path(
        "milestones/<uuid:milestone_id>/accept",
        views.MilestoneAcceptView.as_view(),
        name="milestone-accept",
    ),
    path(
        "milestones/<uuid:milestone_id>/reject",
        views.MilestoneRejectView.as_view(),
        name="milestone-reject",
    ),
    # ADR-130: `confirm-payment` ПЕРЕЕХАЛ в apps.payments.api.urls (тот же
    # URL, то же тело, тот же ответ) — за ним теперь стоит модель Payment.
    # Здесь его нет умышленно: apps.milestones не имеет права импортировать
    # apps.payments (транзитивный контракт import-linter через
    # apps.contracts). Парного `confirm-advance` больше нет вовсе — способ
    # `prepayment` упразднён (ADR-155).
    path(
        "materials/<uuid:material_id>/problem-notice",
        views.MaterialProblemNoticeView.as_view(),
        name="material-problem-notice",
    ),
    # ADR-155: двусторонняя передача материала — «передал» (сторона-
    # источник) и «получил» (другая сторона). Порядок между ними НЕ
    # обязателен: получение отмечается односторонне (владелец 03.09).
    path(
        "materials/<uuid:material_id>/handed-over",
        views.MaterialHandedOverView.as_view(),
        name="material-handed-over",
    ),
    path(
        "materials/<uuid:material_id>/received",
        views.MaterialReceivedView.as_view(),
        name="material-received",
    ),
    # ADR-155: пока договор редактируется — материалы тоже редактируются
    # (замечание владельца 03.09). Объявлен ПОСЛЕ вложенных путей: у `path()`
    # решает порядок в списке, и голый `materials/<uuid>` не должен
    # перехватывать `materials/<uuid>/received`.
    path(
        "materials/<uuid:material_id>",
        views.ContractMaterialDetailView.as_view(),
        name="material-detail",
    ),
]
