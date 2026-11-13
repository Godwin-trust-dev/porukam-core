import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * GLOBAL У1 — EN-first (§0 DEV-auth-onboarding). Приложение сейчас
 * одноязычное в рантайме (`createI18n('ru')`, `providers.tsx`) — полноценный
 * переключатель языка вне скоупа этой задачи. Экраны входа/онбординга
 * переключают ЕДИНЫЙ на всё приложение инстанс i18n на `en` — сознательно
 * БЕЗ отката на unmount: RU (OTP) и GLOBAL (Google) — разные пользователи,
 * которые не переходят между `/login` и `/welcome` в рамках одной сессии,
 * так что «откатывать назад» после ухода с экрана некому. Остальной каталог,
 * ещё не переведённый, продолжает работать через `fallbackLng: 'ru'`
 * (`packages/i18n/src/index.ts`) — гибридный экран лучше, чем крах.
 */
export function useForceLocale(lng: 'en' | 'ru'): void {
  const { i18n } = useTranslation();
  useEffect(() => {
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lng]);
}
