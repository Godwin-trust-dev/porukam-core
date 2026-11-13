from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "reputation/profiles/<uuid:profile_id>/card",
        views.ReputationCardView.as_view(),
        name="reputation-card",
    ),
    # ADR-163 §8: приватный разбор своей карточки — отдельный эндпоинт, а
    # не флаг на карточке (одна ошибка в правах не должна раскрывать всё).
    path(
        "reputation/profiles/<uuid:profile_id>/insights",
        views.ReputationInsightsView.as_view(),
        name="reputation-insights",
    ),
]
