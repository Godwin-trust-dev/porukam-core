from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from config.health import health

urlpatterns = [
    path("admin/", admin.site.urls),
    # ЭФ.6 п.2 — RED-метрики + кастомные коллекторы (common/metrics.py,
    # apps/deadlines/metrics.py, ...), формат Prometheus text exposition.
    path("", include("django_prometheus.urls")),
    path("v1/health", health, name="health"),
    path("v1/schema/", SpectacularAPIView.as_view(), name="schema"),
    path(
        "v1/schema/swagger-ui/",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="swagger-ui",
    ),
    path("v1/", include("apps.l10n.api.urls")),
    # ADR-179: справочник страна/регион/город для фильтра поиска.
    path("v1/", include("apps.geo.api.urls")),
    path("v1/", include("apps.catalog.api.urls")),
    path("v1/", include("apps.accounts.api.urls")),
    path("v1/", include("apps.identity.api.urls")),
    path("v1/", include("apps.social.api.urls")),
    path("v1/", include("apps.entities.api.urls")),
    path("v1/", include("apps.authority.api.urls")),
    path("v1/", include("apps.profiles.api.urls")),
    path("v1/", include("apps.notifications.api.urls")),
    path("v1/", include("apps.contracts.api.urls")),
    path("v1/", include("apps.milestones.api.urls")),
    # ADR-130: apps.payments владеет и собственными /payments/*, и
    # унаследованным /milestones/{id}/confirm-payment — порядок include не
    # важен, пути не пересекаются.
    path("v1/", include("apps.payments.api.urls")),
    path("v1/", include("apps.documents.api.urls")),
    path("v1/", include("apps.disputes.api.urls")),
    path("v1/", include("apps.warranty.api.urls")),
    path("v1/", include("apps.evidence.api.urls")),
    path("v1/", include("apps.archive.api.urls")),
    # ADR-139: долгоживущая ссылка на архив без авторизации — в корне, не
    # под /v1 (письмо ведёт на `/a/<token>`; nginx проксирует /a/ в core).
    path("", include("apps.archive.api.public_urls")),
    path("v1/", include("apps.reputation.api.urls")),
    path("v1/", include("apps.dashboards.api.urls")),
    path("v1/", include("apps.messaging.api.urls")),
    # ADR-145: единственный ВВОД аналитики — событие шага конструктора (§8.1).
    path("v1/", include("apps.analytics.api.urls")),
    # ADR-145: внутренние метрики (§9.1) — за статическим токеном и списком
    # адресов, наружу не выводятся (nginx не проксирует /internal/), тот же
    # принцип, что у /metrics Prometheus.
    path(
        "internal/v1/",
        include("apps.analytics.api.internal_urls"),
    ),
]
