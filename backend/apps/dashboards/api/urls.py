from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("dashboard", views.DashboardView.as_view(), name="dashboard"),
    path("dashboard/stages", views.StagesView.as_view(), name="dashboard-stages"),
    path("dashboard/payments", views.PaymentsView.as_view(), name="dashboard-payments"),
    path("dashboard/search", views.SearchView.as_view(), name="dashboard-search"),
]
