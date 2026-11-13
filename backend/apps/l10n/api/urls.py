from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("locales", views.LocaleListView.as_view(), name="locale-list"),
    path("legal/<slug:doc>", views.LegalDocumentView.as_view(), name="legal-document"),
]
