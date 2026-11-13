from __future__ import annotations

from django.urls import path

from . import views

# Внутренние метрики (§9.1) — подключаются в config/urls.py под
# /internal/v1/metrics/. Отдельный модуль, а не список в urls.py: include()
# берёт из модуля именно `urlpatterns`, и общий файл выводил бы продуктовый
# путь конструктора ещё и под /internal/.
urlpatterns = [
    path("metrics/pulse", views.PulseView.as_view(), name="metrics-pulse"),
    path("metrics/geography", views.GeographyView.as_view(), name="metrics-geography"),
    path("metrics/acquisition", views.AcquisitionView.as_view(), name="metrics-acquisition"),
    path("metrics/funnel", views.FunnelView.as_view(), name="metrics-funnel"),
    path("metrics/installs", views.InstallsView.as_view(), name="metrics-installs"),
    path(
        "metrics/search-filters",
        views.SearchFiltersView.as_view(),
        name="metrics-search-filters",
    ),
    path("metrics/languages", views.LanguagesView.as_view(), name="metrics-languages"),
    path("metrics/cohorts", views.CohortsView.as_view(), name="metrics-cohorts"),
    path("metrics/health", views.HealthView.as_view(), name="metrics-health"),
]
