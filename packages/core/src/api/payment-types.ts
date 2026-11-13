/**
 * Платёж по этапу (DEV-07) — отдельный ресурс от ContractDetail: онлайн (СБП, статус от
 * провайдера) и наличные (двустороннее подтверждение). Отметки необратимы — расхождение
 * решается спором (ADR-019/020), не откатом.
 */
import type { MoneyLike } from '../money';
import type { PaymentMethodKind } from '../payment-policy';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'awaiting_confirmation' | 'confirmed' | 'disputed';

export interface PaymentPartyState {
  name: string;
  confirmed: boolean;
  /** ISO-время подтверждения — только когда confirmed. */
  at?: string;
}

export interface Payment {
  id: string;
  contract_id: string;
  stage_id: string;
  amount: MoneyLike;
  method: PaymentMethodKind;
  status: PaymentStatus;
  payer: PaymentPartyState;
  payee: PaymentPartyState;
  /** Только для method: 'sbp' — список банков для QR-экрана. */
  banks?: string[];
  created_at: string;
}
