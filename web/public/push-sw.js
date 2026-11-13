/**
 * Web Push обработчики (ADR-110) — подключаются к сгенерированному workbox-SW
 * через `workbox.importScripts` (vite.config.ts): generateSW-режим остаётся,
 * свой полный SW не пишем.
 *
 * Полезная нагрузка минимальна (см. WebPushProvider, push_payload): {title,
 * body, url[, icon]} — без сумм и имён. Тексты приходят с бэка на языке
 * получателя; фолбэк — имя приложения. `title` — название договора (когда он
 * есть), `body` — короткая фраза действия («Этап принят»); `icon`, если он
 * есть, — абсолютный URL фото КОНТРАГЕНТА (имя контрагента текстом сюда не
 * идёт — решение владельца, ADR-180): владелец 11.09 — «текста много и 2
 * наших логотипа, надо 1 логотип, название договора + фото контрагента».
 * Фото нет — фолбэк на свою же цветную иконку `icon-192.png`.
 *
 * `badge` — МОНОХРОМНАЯ иконка: в статус-баре Android от неё берётся только
 * альфа-канал, цвет рисует система. Полноцветная `icon-192.png` в этой роли
 * непрозрачна целиком, и вместо знака получался белый прямоугольник (владелец
 * 10.09: «нет красивой иконки сверху мелкой… просто белый квадратик»). Поэтому
 * badge — свой файл `icons/badge-96.png`: силуэт знака на полностью прозрачном
 * фоне. `icon` остаётся цветным — там альфа ни при чём.
 *
 * Обработчика `fetch` здесь НЕТ и быть не должно: перехват запросов — целиком
 * зона workbox (vite.config.ts), и любой лишний `fetch`-слушатель обошёл бы
 * `navigateFallbackDenylist` — ровно ту грабку, из-за которой 03.09 ссылка на
 * архив `/a/<token>` не доходила до сервера (ADR-139 §7, «Примечание 03.09»).
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'По рукам';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/notifications' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
