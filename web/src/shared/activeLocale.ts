/**
 * Активный язык интерфейса как plain-модуль (не React-стор) — читается синхронно
 * `ApiClient.getLocale()` на каждый запрос (Accept-Language, DEV-16b: рендер языка
 * договора на подписании зависит от реального Accept-Language, не от статичного 'ru').
 *
 * Отдельный модуль без импортов из `app/providers`/`app/i18n`, чтобы не создавать цикл
 * (providers.tsx → …хуки… → shared/api.ts → (было бы) app/providers.tsx). `app/providers.tsx`
 * зовёт `setActiveLocale` при инициализации и на каждый `i18n.on('languageChanged', …)`.
 */
let current = 'ru';

export function getActiveLocale(): string {
  return current;
}

export function setActiveLocale(locale: string): void {
  current = locale;
}
