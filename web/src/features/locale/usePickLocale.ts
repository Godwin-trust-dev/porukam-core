import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../auth/authStore';
import { useUpdateLocale } from '../profile/api';
import { useGuestLocaleStore } from './localeStore';
import { applyLocale } from './applyLocale';

/**
 * Выбор языка интерфейса (DEV-16a §3): гость → память/сессия, залогинен → PATCH
 * в профиль (едет на все устройства). Запоминание выбора — сразу и
 * оптимистично, независимо от результата сетевого запроса; сам интерфейс
 * переключается через `applyLocale` — после подгрузки языкового пакета, чтобы
 * между кликом и приходом чанка не мигнуть английским (§0/§A постановки
 * feat/l10n-launch-surfaces).
 */
export function usePickLocale(): (code: string) => void {
  const { i18n } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setGuestLocale = useGuestLocaleStore((s) => s.setLocale);
  const updateLocale = useUpdateLocale();

  return (code: string) => {
    void applyLocale(i18n, code);
    if (isAuthenticated) void updateLocale.mutateAsync(code).catch(() => undefined);
    else setGuestLocale(code);
  };
}
