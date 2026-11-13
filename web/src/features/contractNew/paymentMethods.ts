import type { RealContract } from '@porukam/core';

export type PaymentMethodCode = NonNullable<RealContract['payment_method']>;

/**
 * Способы оплаты, предлагаемые мастером на запуске, — честный набор
 * (Задача_feat_web-wizard-payment-method.md): расчёты вне платформы.
 * Платформенные `direct_platform`/`hold` — post-launch (apps.payments);
 * для person-исполнителя они блокируют заморозку на реквизитах
 * (`RequisitesMissingError`) — предлагать их сейчас = тупик. Сеам: включить
 * позже = добавить код сюда + ключ в PAYMENT_METHOD_LABEL_KEY + переводы.
 */
export const WIZARD_PAYMENT_METHODS: readonly PaymentMethodCode[] = ['cash', 'external'];

/** Ключи подписей ТОЛЬКО предлагаемых способов (тот же приём Record-мапы,
 * что ATTENTION_*_KEY на дашборде); неизвестный код на превью честно
 * показывается сырым кодом, не падает. */
export const PAYMENT_METHOD_LABEL_KEY: Partial<Record<PaymentMethodCode, string>> = {
  cash: 'contractNew.paymentMethod_cash',
  external: 'contractNew.paymentMethod_external',
};
