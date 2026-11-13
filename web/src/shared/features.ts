/**
 * Фич-флаги разделов, которые В ПРОДУКТЕ ПОКА ВЫКЛЮЧЕНЫ (отсмотр 2026-08-22):
 * «поиск и группы пока не делаем — прячем», «объединения — их нет и пока не
 * будет, включим потом». Чат с ADR-112 РЕАЛЕН и включён. Маршруты остаются
 * (прямая ссылка ведёт в заглушку раздела), из навигации и кнопок-входов —
 * убираем. Включение — одной правкой здесь (или через VITE_FEATURES=chat,groups).
 */
const enabledFromEnv = new Set(
  (import.meta.env.VITE_FEATURES ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
);

export type FeatureKey = 'chat' | 'search' | 'groups' | 'organizations' | 'socialLinks';

const DEFAULTS: Record<FeatureKey, boolean> = {
  // ADR-112: переписка по договору реализована (apps.messaging) — включена.
  chat: true,
  // ADR-114 / отсмотр 2026-08-23: поиск и объединения реализованы — включены.
  search: true,
  groups: true,
  organizations: false,
  /** Иконки соцсетей (instagram, telegram, facebook, linkedin) — ссылки дадут позже. */
  socialLinks: false,
};

export function isFeatureEnabled(key: FeatureKey): boolean {
  return enabledFromEnv.has(key) || DEFAULTS[key];
}
