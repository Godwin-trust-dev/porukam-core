/**
 * Пути, на которых PWA service worker НЕ должен подменять ответ оболочкой SPA
 * (`navigateFallback: '/index.html'`, см. `web/vite.config.ts`).
 *
 * Зачем список вообще: workbox вешает `NavigationRoute` на ЛЮБУЮ навигацию в
 * пределах scope «/» и отдаёт `index.html` из precache. Для клиентского роутинга
 * это правильно (`/contracts/123` на диске нет), но для путей, которые nginx
 * проксирует в бэкенд, — фатально: запрос вообще НЕ УХОДИТ В СЕТЬ, человек
 * видит оболочку SPA, а сервер о попытке не узнаёт.
 *
 * Инцидент 03.09 (docs/backlog.md, «03.09 вечер»): долгоживущая ссылка на архив
 * сделки `https://porukam.app/a/<token>` (ADR-139 §7) при вставке в адресную
 * строку «ничего не делала». По логам прода за 48 часов до nginx не дошло НИ
 * ОДНОГО такого запроса — их съедал service worker у всех, кто хоть раз
 * открывал сайт в этом браузере. Кнопка «Скачать» работала, потому что
 * `<a download>` для SW не навигация.
 *
 * Список сверен по `конфиг nginx` и `backend/config/urls.py`
 * — по КОДУ, а не «на глаз»:
 *   `/v1/`          — REST API (все `path("v1/", include(...))` + health/schema);
 *   `/a/`           — ADR-139 §7, долгоживущая ссылка на архив в корне сайта;
 *   `/admin/`       — Django admin;
 *   `/ws/`          — WebSocket чата (ADR-113); навигацией не бывает, но
 *                     пусть путь бэкенда останется путём бэкенда;
 *   `/.well-known/` — assetlinks.json (ADR-150) и всё, что появится рядом:
 *                     верификатор TWA обязан получить JSON, а не HTML-оболочку;
 *   `/grafana/`, `/prometheus/`, `/alertmanager/` — мониторинг за basic auth.
 *
 * СОЗНАТЕЛЬНО не включены `/metrics` и `/internal/`: nginx их наружу не
 * проксирует и отдаёт ровно оболочку SPA (см. комментарии в locations.conf) —
 * поведение SW тут совпадает с поведением сервера, и денилист только сбил бы
 * читателя с толку.
 *
 * Модуль отдельный, а не литерал в `vite.config.ts`, чтобы список был покрыт
 * тестом (`web/tests/navigateFallbackDenylist.test.ts`) — в конфиге сборки
 * regex-опечатка молча не проверяется ничем.
 */
export const NAVIGATE_FALLBACK_DENYLIST: readonly RegExp[] = [
  /^\/v1\//,
  /^\/a\//,
  /^\/admin\//,
  /^\/ws\//,
  /^\/\.well-known\//,
  /^\/grafana\//,
  /^\/prometheus\//,
  /^\/alertmanager\//,
];

/**
 * Повторяет правило workbox (`workbox-routing/NavigationRoute._match`): денилист
 * проверяется по СКЛЕЙКЕ `url.pathname + url.search`, и совпадение означает
 * «навигационный fallback не применяется, запрос уходит в сеть».
 *
 * `true` — оболочка SPA (клиентский маршрут), `false` — запрос к серверу.
 */
export function usesNavigationFallback(pathnameAndSearch: string): boolean {
  return !NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(pathnameAndSearch));
}
