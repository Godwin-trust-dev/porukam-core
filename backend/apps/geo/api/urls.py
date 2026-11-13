from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("geo/countries", views.CountryListView.as_view(), name="geo-countries"),
    path("geo/regions", views.RegionListView.as_view(), name="geo-regions"),
    path("geo/cities", views.CityListView.as_view(), name="geo-cities"),
]
