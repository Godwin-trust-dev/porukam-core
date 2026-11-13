import { useEffect, useState } from 'react';

const DESKTOP_QUERY = '(min-width: 640px)';

/**
 * Тот же брейкпоинт, что у `Sheet`/`ActionMenu` (640px) — JS, не CSS: используется там,
 * где mobile и desktop — структурно разные контейнеры (Sheet-модалка vs anchored dropdown
 * / инлайн-колонка), не один и тот же DOM с другими стилями. Вынесено из
 * `LanguageSwitcher.tsx` (DEV-16a) для повторного использования в `OfficialTextView`
 * (DEV-16b).
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(DESKTOP_QUERY).matches),
  );
  useEffect(() => {
    const mql = window.matchMedia?.(DESKTOP_QUERY);
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent): void => setIsDesktop(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return isDesktop;
}
