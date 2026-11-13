import { useEffect, useState } from 'react';

/**
 * Брейкпоинты рабочих экранов (DEV-19 §0, ADR-099).
 *
 * `<1024` — мобильная стопка, `≥1024` — десктоп (master-detail /
 * мультиколонка / паспорт-рейл). `≥1280` — «широкий»: списки, где нет
 * master-detail, доедают ширину таблицей (§6).
 *
 * ⚠️ Это ЕДИНСТВЕННЫЙ источник чисел для JS. В CSS подставить переменную
 * внутрь `@media` нельзя, поэтому те же литералы объявлены по одному разу в
 * CSS-модулях примитивов раскладки этой папки (`--pr-bp-desktop`/`--pr-bp-wide`
 * в `tokens.css` держат их справочно). Страницы медиа-запросы про раскладку
 * НЕ пишут — они собираются из примитивов.
 */
export const DESKTOP_MIN_WIDTH = 1024;
export const WIDE_MIN_WIDTH = 1280;

function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/**
 * `true` на десктопной раскладке (`≥1024`). Нужен там, где mobile и desktop —
 * структурно РАЗНЫЙ DOM, а не одни и те же узлы с другими стилями: на узком
 * экране колонка деталей не просто спрятана, её нет (тап по строке уводит на
 * страницу деталей — DEV-19 §2), и вешать на неё запросы данных незачем.
 * Чисто визуальные различия делаются в CSS, не через этот хук.
 */
export function useDesktopLayout(): boolean {
  return useMinWidth(DESKTOP_MIN_WIDTH);
}

/** `true` на широком десктопе (`≥1280`) — плотные таблицы вместо карточек (§6). */
export function useWideLayout(): boolean {
  return useMinWidth(WIDE_MIN_WIDTH);
}
