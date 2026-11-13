import { useTranslation } from 'react-i18next';
import type { RealContract } from '@porukam/core';
import { Callout } from '@porukam/ui';

/**
 * Пояснение вместо кнопки оплаты для способов, где деньги шли бы через платформу
 * (`direct_platform`/`hold`): модуль платежей (Э5) ещё не запущен, поэтому CTA нет.
 * Без плашки экран выглядел «сломанным» — кнопки нет и непонятно почему
 * (отсмотр 2026-08-25).
 *
 * Один компонент и один ключ на оба места: вкладка «Оплаты» карточки договора
 * (`RealPaymentsPanel`) и экран этапа (`StagePage`).
 */
export interface PlatformPaymentNoticeProps {
  paymentMethod: RealContract['payment_method'];
}

export function PlatformPaymentNotice({ paymentMethod }: PlatformPaymentNoticeProps): JSX.Element | null {
  const { t } = useTranslation();
  if (paymentMethod !== 'direct_platform' && paymentMethod !== 'hold') return null;
  return (
    <div data-testid="platform-payment-notice">
      <Callout tone="neutral" title={t('stage.realPayPlatformTitle')}>
        {t('stage.realPayPlatformText')}
      </Callout>
    </div>
  );
}
