from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path(
        "contracts/<uuid:contract_id>/payments",
        views.ContractPaymentsView.as_view(),
        name="contract-payments",
    ),
    path("payments/<uuid:payment_id>", views.PaymentDetailView.as_view(), name="payment-detail"),
    path(
        "payments/<uuid:payment_id>/confirm",
        views.PaymentConfirmView.as_view(),
        name="payment-confirm",
    ),
    path(
        "payments/<uuid:payment_id>/cancel",
        views.PaymentCancelView.as_view(),
        name="payment-cancel",
    ),
    path(
        "payments/webhooks/<str:provider>",
        views.PaymentWebhookView.as_view(),
        name="payment-webhook",
    ),
    # ADR-130: URL из Э4.6 сохранён дословно (фронт его использует), но
    # обслуживается платёжным контуром — см. докстринг views.py. Парного
    # `/confirm-advance` больше нет: способ `prepayment` и вид платежа
    # `advance` упразднены (ADR-155).
    path(
        "milestones/<uuid:milestone_id>/confirm-payment",
        views.MilestoneConfirmPaymentView.as_view(),
        name="milestone-confirm-payment",
    ),
]
