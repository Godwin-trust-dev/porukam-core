/**
 * Что вставляют в поле «Вторая сторона»: `@хендл` или ссылку на карточку
 * (`porukam.app/@хендл`, с протоколом и без, с `?utm=…`/якорем). Бэк ищет по
 * префиксу и сам срезает «собачку» (`apps.social.selectors.search_handles`),
 * поэтому здесь достаточно вынуть хендл из ссылки и вернуть его в каноничном
 * виде «@хендл». Обычное имя («Мария») проходит насквозь: поиск по имени
 * никуда не делся.
 */
const CARD_LINK_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*porukam\.app\/@?([a-zA-Z0-9_.-]+)/i;

export function normalizeCounterpartyInput(raw: string): string {
  const value = raw.trim();
  const link = CARD_LINK_RE.exec(value);
  if (link?.[1]) return `@${link[1]}`;
  return value;
}

/** Хендл в каноничном виде для сравнения: без «собачки», в нижнем регистре. */
export function handleKey(handle: string | null | undefined): string {
  return (handle ?? '').trim().replace(/^@+/, '').toLowerCase();
}
