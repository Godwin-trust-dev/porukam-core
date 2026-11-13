from __future__ import annotations

from django.urls import path

from . import views

# Продуктовые пути: ДВА ввода приложения и больше их не будет — шаг
# конструктора (§8.1) и воронка установки (ADR-171). Оба заведены по одной
# причине: измеряемого факта нет в домене и не должно там появиться.
urlpatterns = [
    path(
        "analytics/constructor-step",
        views.ConstructorStepView.as_view(),
        name="analytics-constructor-step",
    ),
    path(
        "analytics/install-event",
        views.InstallEventView.as_view(),
        name="analytics-install-event",
    ),
]
