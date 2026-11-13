/**
 * Представление платежа `apps.payments` (ADR-130) для UI: бейдж статуса,
 * просрочка, доступные стороне действия. Держим ОТДЕЛЬНО от компонентов —
 * одни и те же правила нужны и вкладке «Оплаты» карточки договора, и
 * блоку оплаты на экране этапа, и тестам.
 */
import type { RealContract, RealPayment, RealPaymentKind, RealPaymentStatus } from '@porukam/core';
import type { BadgeTone } from '@porukam/ui';

/** Ключи i18n статусов. `contract.paymentsTab.*` — общий словарь обоих
 * мест (экран этапа берёт его же, как и наоборот `PlatformPaymentNotice`
 * во вкладке берёт `stage.*`). Статусы «провайдерской эры» (§5.2.6)
 * недостижимы в этой волне, но замаплены: неизвестный статус не должен
 * выводить на экран сырой код. */
const STATUS_KEY: Record<RealPaymentStatus, string> = {
  pending: 'contract.paymentsTab.unpaid',
  payer_confirmed: 'contract.paymentsTab.markedByPayer',
  payee_confirmed: 'contract.paymentsTab.confirmedByPayee',
  confirmed: 'contract.paymentsTab.paid',
  cancelled: 'contract.paymentsTab.cancelled',
  processing: 'contract.paymentsTab.statusOther',
  held: 'contract.paymentsTab.statusOther',
  captured: 'contract.paymentsTab.paid',
  voided: 'contract.paymentsTab.cancelled',
  refunded: 'contract.paymentsTab.statusOther',
  disputed: 'contract.paymentsTab.statusOther',
  failed: 'contract.paymentsTab.statusOther',
  observed: 'contract.paymentsTab.statusOther',
};

const STATUS_TONE: Record<RealPaymentStatus, BadgeTone> = {
  pending: 'neutral',
  payer_confirmed: 'amber',
  payee_confirmed: 'amber',
  confirmed: 'green',
  cancelled: 'neutral',
  processing: 'amber',
  held: 'amber',
  captured: 'green',
  voided: 'neutral',
  refunded: 'neutral',
  disputed: 'red',
  failed: 'red',
  observed: 'teal',
};

export function paymentStatusKey(payment: RealPayment): string {
  return STATUS_KEY[payment.status] ?? 'contract.paymentsTab.statusOther';
}

export function paymentStatusTone(payment: RealPayment): BadgeTone {
  return STATUS_TONE[payment.status] ?? 'neutral';
}

/** Доска B: статус — словом-цветом, а не чипом. Оттенок выводим из ТОГО ЖЕ
 * словаря тонов, что и бейдж: второй независимый список разъехался бы с
 * первым при первой же правке. */
export type PaymentStatusInk = 'paid' | 'progress' | 'pending' | 'off' | 'alert';

const TONE_INK: Record<BadgeTone, PaymentStatusInk> = {
  green: 'paid',
  teal: 'paid',
  amber: 'progress',
  red: 'alert',
  neutral: 'pending',
  ink: 'pending',
};

export function paymentStatusInk(payment: RealPayment): PaymentStatusInk {
  // Отменённый счёт обязательством не является — он приглушён, а не «ждёт».
  if (payment.status === 'cancelled' || payment.status === 'voided') return 'off';
  return TONE_INK[paymentStatusTone(payment)];
}

/** Вид платежа на лист ОДИН — «оплата этапа» (ADR-155 §2): КОГДА его платят,
 * решает `Contract.payment_order`, а не вид. Вид `advance` упразднён вместе
 * со способом `prepayment`; зарезервированные схемой `prepayment` (частичная)
 * и `refund` пока не создаются, но подпись у них своя — сырой код на экран
 * выводить нельзя. */
const KIND_KEY: Record<RealPaymentKind, string> = {
  postpayment: 'contract.paymentsTab.kindPostpayment',
  prepayment: 'contract.paymentsTab.kindPartialPrepayment',
  refund: 'contract.paymentsTab.kindRefund',
};

export function paymentKindKey(payment: RealPayment): string {
  return KIND_KEY[payment.kind] ?? 'contract.paymentsTab.kindPostpayment';
}

/** Заголовок строки счёта на экране этапа: при предоплате вид платежа
 * («Оплата этапа») человеку ничего не добавляет, а вот СРОК — добавляет:
 * «К оплате до старта этапа» / «Оплачено, этап можно начать». */
export function paymentTitleKey(payment: RealPayment, paymentOrder: RealContract['payment_order']): string {
  if (paymentOrder !== 'before_start' || payment.kind !== 'postpayment') return paymentKindKey(payment);
  return payment.status === 'confirmed' ? 'contract.paymentsTab.paidCanStart' : 'contract.paymentsTab.dueBeforeStart';
}

/** Просрочка — НЕ статус (ADR-130 §3): платёж остаётся `pending` и
 * подлежит оплате, вышел лишь срок. Поэтому бейдж показываем РЯДОМ со
 * статусом и только пока платёж жив (у отменённого и оплаченного
 * «просрочено» — уже неправда).
 *
 * `null` — просрочки нет. Дни округляем ВВЕРХ и не показываем «0 дн.»:
 * `overdue_at` ставит свип в тот же день, когда срок вышел. */
export function overdueDays(payment: RealPayment, now: Date = new Date()): number | null {
  if (!payment.overdue_at) return null;
  if (payment.status === 'confirmed' || payment.status === 'cancelled') return null;
  const days = Math.floor((now.getTime() - new Date(payment.overdue_at).getTime()) / 86_400_000);
  return days > 0 ? days : 1;
}

/** Может ли зритель ПОДТВЕРДИТЬ платёж. Правило целиком приезжает с бэка:
 * `my_side` (сторона в деньгах) и `confirmed_by_me` — фронт не повторяет
 * «плательщик — заказчик». Терминальные статусы (`confirmed`/`cancelled`)
 * и «провайдерские» действий не принимают. */
export function canConfirm(payment: RealPayment): boolean {
  if (payment.my_side === null || payment.confirmed_by_me) return false;
  return payment.status === 'pending' || payment.status === 'payer_confirmed' || payment.status === 'payee_confirmed';
}

/** Ключ CTA: плательщику — «Я оплатил», получателю — «Подтвердить
 * получение» (платформа денег не проводит: один отмечает факт платежа,
 * второй — факт получения). */
export function paymentCtaKey(payment: RealPayment): string {
  return payment.my_side === 'payer' ? 'contract.paymentsTab.pay' : 'contract.paymentsTab.confirm';
}

/** «Ждём подтверждения второй стороны» — я отметился, счёт ещё не закрыт. */
export function isWaitingCounterparty(payment: RealPayment): boolean {
  return !!payment.confirmed_by_me && payment.status !== 'confirmed' && payment.status !== 'cancelled';
}

/** Отмена — ТОЛЬКО из `pending` (`PAYMENT_FSM`) и любой СТОРОНОЙ договора:
 * счёт — техническая запись «к оплате», и заказчик вправе снять её так же,
 * как исполнитель. Не сторона (`my_side === null`) не отменяет ничего.
 *
 * ПРЕДОПЛАТНЫЙ счёт не отменяется вовсе (бэк: 409 `payment_not_cancellable`,
 * ADR-132/155): он — условие гейта §6.3, выставить его заново нельзя
 * (`UNIQUE (milestone, kind)` — отменённая строка занимает пару навсегда),
 * и старт этапа остался бы запертым навсегда. Кнопки, ведущей в необратимое
 * «этап больше не запустить», на экране быть не должно. */
export function canCancel(payment: RealPayment, paymentOrder: RealContract['payment_order']): boolean {
  return payment.status === 'pending' && payment.my_side !== null && paymentOrder !== 'before_start';
}
