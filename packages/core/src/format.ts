/**
 * Форматтеры денег и дат (ТЗ §9.2, §14; локаль — DEV-16 §5).
 *
 * Хранение/передача — как в API (строковые суммы, UTC ISO 8601).
 * Отображение — по локали и TZ пользователя (по умолчанию Europe/Moscow).
 * Валюты по умолчанию нет — форматтер денег требует и сумму, и валюту.
 *
 * `locale` — единственная точка форматирования дат/чисел/сумм (DEV-16 §5 ⭐): вызывающий
 * код НЕ форматирует руками (`toLocaleDateString`, ручная сборка «5 000 ₽») — только через
 * эти хелперы. В React-коде передавайте текущий `i18n.language` — см. `useFormatters()`
 * (`web/src/shared/formatters.ts`). `DEFAULT_LOCALE` — фолбэк для не-React контекстов
 * (юнит-тесты, скрипты), не для реального рендера.
 *
 * **Латинские цифры для юрзначимых величин (DEV-16 §5, обновлено 10.08 — связано с
 * LTR-островками DEV-16c §2).** По умолчанию `Intl` в арабской/фарси-локали отдаёт
 * восточно-арабские цифры (٠١٢٣) — одна и та же сумма выглядела бы у двух сторон сделки
 * по-разному. Сумма договора/платежа, хеш и юрзначимая дата — не косметика локали, а
 * значение, которое должно совпадать у обеих сторон побайтово. Поэтому:
 * - `formatMoney`/`formatPolicyMoney` — ВСЕГДА `numberingSystem:'latn'` (валютный символ/
 *   порядок остаются по локали, цифры — нет).
 * - `formatDate`/`formatDateTime` — `numberingSystem:'latn'` только при `{ legal: true }`
 *   (срок договора, дата подписания/TSA, сроки приёмки/оплаты в договоре и архиве);
 *   обычные даты интерфейса (лента, служебные) — по локали, без опции.
 * Эти же значения — LTR-островки (`dir="ltr"`, `<LtrText>`) в RTL по DEV-16c §2: там они
 * не зеркалятся и одновременно остаются в latn.
 */
import type { MoneyLike } from './money';
import type { CurrencyPolicy } from './payment-policy';

/**
 * Изменяемый дефолт локали (ADR-142): компоненты `packages/ui` зовут форматтеры без
 * аргумента `locale` — раньше это молча давало ru-RU («27 авг.», русская группировка
 * разрядов) на любом языке интерфейса. Приложение синхронизирует дефолт с i18n
 * (`web/src/app/providers.tsx`: init + `languageChanged`) через `setDefaultFormatLocale`.
 * Стартовое значение ru-RU сохраняет поведение юнит-тестов и Storybook.
 */
let DEFAULT_LOCALE = 'ru-RU';

/**
 * Часовой пояс отображения. Раньше был жёстко `Europe/Moscow`: исполнитель в Джакарте
 * видел срок приёмки по московскому времени и молча ошибался на несколько часов.
 * Приложение выставляет пояс устройства (`web/src/app/providers.tsx`); стартовое
 * значение сохраняет поведение юнит-тестов и Storybook.
 *
 * Юрзначимые даты (`{ legal: true }`) печатаются С МЕТКОЙ ПОЯСА: у сторон сделки
 * пояса разные, и «12:00» без пояса — это два разных момента времени, тогда как
 * дата подписания и сроки должны читаться однозначно (та же логика, что и латинские
 * цифры для сумм и хешей выше).
 */
let DEFAULT_TZ = 'Europe/Moscow';

export function setDefaultFormatLocale(locale: string): void {
  DEFAULT_LOCALE = locale;
}

export function setDefaultFormatTimeZone(tz: string): void {
  DEFAULT_TZ = tz;
}

const CURRENCY_LABEL: Record<string, string> = {
  RUB: '₽',
  USD: '$',
  EUR: '€',
};

/** «15 000 ₽» — сумма+валюта, без потери точности исходной строки. Цифры — всегда latn (см. заголовок файла). */
export function formatMoney(m: MoneyLike, locale = DEFAULT_LOCALE): string {
  const n = Number(m.amount);
  const hasFraction = m.amount.includes('.') && !/\.0+$/.test(m.amount);
  const num = Number.isFinite(n)
    ? new Intl.NumberFormat(locale, {
        minimumFractionDigits: hasFraction ? 2 : 0,
        maximumFractionDigits: 2,
        numberingSystem: 'latn',
      }).format(n)
    : m.amount;
  const label = CURRENCY_LABEL[m.currency] ?? m.currency;
  return `${num} ${label}`;
}

/**
 * Деньги по денежной политике юрисдикции (DEV-05-PATCH, ADR-032): символ/decimals —
 * ДАННЫЕ из `paymentPolicy.currency`, не захардкоженный маппинг. Используется в
 * money-компонентах экрана подписания вместо `formatMoney`.
 */
export function formatPolicyMoney(m: MoneyLike, currency: CurrencyPolicy, locale = DEFAULT_LOCALE): string {
  const n = Number(m.amount);
  const hasFraction = m.amount.includes('.') && !/\.0+$/.test(m.amount);
  const num = Number.isFinite(n)
    ? new Intl.NumberFormat(locale, {
        minimumFractionDigits: hasFraction ? currency.decimals : 0,
        maximumFractionDigits: currency.decimals,
        numberingSystem: 'latn',
      }).format(n)
    : m.amount;
  return `${num} ${currency.symbol}`;
}

/** Юрзначимость даты (DEV-16 §5) — срок договора/дата подписания/сроки приёмки-оплаты → latn-цифры. */
export interface DateFormatOptions {
  legal?: boolean;
}

export function formatDate(iso: string, locale = DEFAULT_LOCALE, tz = DEFAULT_TZ, opts?: DateFormatOptions): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: tz,
    ...(opts?.legal ? { numberingSystem: 'latn' as const } : {}),
  }).format(d);
}

/**
 * Короткая дата для СПИСКОВ (замечание владельца 03.09 по доске A: «7 августа 2026 г.»
 * в строке списка съедает место, нужен короткий формат): «3 сен» — если год тот же,
 * что сейчас, и «3 сен 2025» — если другой (год не теряется, когда он важен).
 *
 * Месяц берётся у `Intl` (`month: 'short'`), а не собирается вручную: в каждой локали
 * своя сокращённая форма и свой порядок «день/месяц» (ru «3 сент.», en «Sep 3»,
 * ja «9月3日»). Год сравнивается В ПОЯСЕ ОТОБРАЖЕНИЯ — иначе 31 декабря по местному
 * времени и 1 января по UTC давали бы разный ответ.
 *
 * НЕ для юрзначимых дат: срок договора, дата подписания/TSA, сроки приёмки-оплаты
 * печатаются полностью через `formatDate({ legal: true })` (DEV-16 §5).
 */
export function formatShortDate(iso: string, locale = DEFAULT_LOCALE, tz = DEFAULT_TZ, nowMs = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yearOf = (date: Date): string =>
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: tz, numberingSystem: 'latn' }).format(date);
  const sameYear = yearOf(d) === yearOf(new Date(nowMs));
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' as const }),
    timeZone: tz,
  }).format(d);
}

export function formatDateTime(iso: string, locale = DEFAULT_LOCALE, tz = DEFAULT_TZ, opts?: DateFormatOptions): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
    // Момент времени у сторон в разных поясах обязан читаться одинаково.
    ...(opts?.legal ? { numberingSystem: 'latn' as const, timeZoneName: 'short' as const } : {}),
  }).format(d);
}

/**
 * Относительное время («сейчас» / «5 мин назад» / «вчера») — лента уведомлений (DEV-14 §3, §9).
 * Точное время всегда дублируется рядом (title/tooltip) через `formatDateTime` — эта функция
 * только для краткой подписи в списке.
 */
export function formatRelativeTime(iso: string, nowMs: number, locale = DEFAULT_LOCALE): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((nowMs - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diffSec);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diffSec / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(-Math.round(diffSec / (86400 * 30)), 'month');
  return rtf.format(-Math.round(diffSec / (86400 * 365)), 'year');
}

/** Единицы Intl (ECMA-402 `style: 'unit'`) для файлов — Б/КБ/МБ/ГБ localised без ручных меток. */
const FILE_SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/** Размер файла (DEV-12 §3, `tabular-nums` в UI) — локализовано через Intl, 0/1 знак после запятой. */
export function formatFileSize(bytes: number, locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: FILE_SIZE_UNITS[unitIndex],
    unitDisplay: 'short',
    minimumFractionDigits: 0,
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value);
}

/** Обратный отсчёт для доменных таймеров (ТЗ §9.6) — локализовано через Intl (день/час/минута narrow). */
export function formatCountdown(deadlineIso: string, nowMs: number, locale = DEFAULT_LOCALE): string {
  const end = new Date(deadlineIso).getTime();
  if (Number.isNaN(end)) return '—';
  let sec = Math.max(0, Math.floor((end - nowMs) / 1000));
  const d = Math.floor(sec / 86400);
  sec -= d * 86400;
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const min = Math.floor(sec / 60);
  const unit = (n: number, u: 'day' | 'hour' | 'minute'): string =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n);
  if (d > 0) return `${unit(d, 'day')} ${unit(h, 'hour')}`;
  if (h > 0) return `${unit(h, 'hour')} ${unit(min, 'minute')}`;
  return unit(min, 'minute');
}
