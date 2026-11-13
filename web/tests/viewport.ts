import { DESKTOP_MIN_WIDTH } from '@porukam/ui';

/**
 * Ширина окна в jsdom (DEV-19 §8). jsdom НЕ реализует `window.matchMedia`
 * вовсе, поэтому без этого хелпера `useDesktopLayout()` всегда возвращает
 * `false` — то есть весь набор тестов по умолчанию идёт по мобильной ветке
 * (это и правильно: старые приёмки описывают именно её). Десктопную ветку
 * включаем явно, тестом, который про неё и написан.
 *
 * Разбирает только `(min-width: Npx)` — единственная форма запроса, которую
 * используют примитивы раскладки.
 */
export function setViewportWidth(width: number): () => void {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const original = (window as { matchMedia?: typeof window.matchMedia }).matchMedia;

  (window as { matchMedia?: unknown }).matchMedia = (query: string) => {
    const min = Number(/\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query)?.[1] ?? NaN);
    const matches = Number.isNaN(min) ? false : width >= min;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  };

  return () => {
    if (original) (window as { matchMedia?: unknown }).matchMedia = original;
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}

/** Приёмочные ширины DEV-19 §8. */
export const WIDTH_PHONE = 360;
export const WIDTH_TABLET = 768;
/** Последняя «мобильная» ширина — граница обязана проходить ровно тут. */
export const WIDTH_MOBILE_MAX = DESKTOP_MIN_WIDTH - 1;
export const WIDTH_DESKTOP = DESKTOP_MIN_WIDTH;
export const WIDTH_WIDE = 1440;
