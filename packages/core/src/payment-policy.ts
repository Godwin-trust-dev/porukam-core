/**
 * Денежная политика подписания (DEV-05-PATCH, ADR-032): ядро не знает «СБП/0%» —
 * только структура данных. Реальные значения приходят из JurisdictionConfig на
 * бэкенде (Ф6); сейчас — из мок-слоя (зеркало бэкенда), см. web/src/mocks/contractsDb.ts.
 *
 * labelKey/noteKey — i18n-ключи, НЕ готовый текст: копирайт живёт в packages/i18n.
 */
import type { MoneyLike } from './money';

export interface CurrencyPolicy {
  code: string;
  symbol: string;
  decimals: number;
}

export type ContractFeePayer = 'contractor_business' | 'customer';

/** Комиссия за ЗАКЛЮЧЕНИЕ договора (ADR-054). */
export interface ContractFeePolicy {
  applies: boolean;
  whoPays: ContractFeePayer | null;
  amount?: MoneyLike;
  percent?: number;
  nonRefundable: boolean;
  labelKey: string;
  noteKey: string;
}

export type OperatorTariff = 'payer' | 'payee' | 'none';

/** Комиссия за ПЛАТЁЖ/перевод (ADR-055 — в РФ 0%, в других юрисдикциях может отличаться). */
export interface TransferFeePolicy {
  platformTakesCommission: boolean;
  operatorTariff: OperatorTariff;
  labelKey: string;
  noteKey: string;
}

export type PaymentMethodKind = 'cash' | 'sbp';

/** Способ платежа, доступный по политике юрисдикции (DEV-07 §0/§2) — база `cash` всегда, `sbp`/онлайн только если провайдер подключён. */
export interface PaymentMethodOption {
  kind: PaymentMethodKind;
  labelKey: string;
}

export interface PaymentPolicy {
  currency: CurrencyPolicy;
  contractFee: ContractFeePolicy;
  transferFee: TransferFeePolicy;
  methods: PaymentMethodOption[];
}
