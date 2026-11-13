import { useEffect } from 'react';

/**
 * `<title>` и `<meta name="description">` публичной страницы (ADR-195).
 *
 * У SPA одна оболочка на все маршруты, поэтому в браузере заголовок правится
 * эффектом. Для ПОИСКА и для превью ссылок в мессенджерах этого мало — краулер
 * Telegram/WhatsApp/VK не исполняет JS вовсе; им те же самые строки печатает
 * скрипт пререндера (`web/scripts/prerender.mjs`) прямо в статический HTML.
 * То есть источник текста один, а применяется он дважды: в рантайме и на сборке.
 *
 * Своей библиотеки под мету (react-helmet и аналоги) не заводим: на публичном
 * контуре нужны ровно два тега, остальное статика пререндера.
 */
export function usePublicMeta({ title, description }: { title: string; description: string }): void {
  useEffect(() => {
    const brand = 'Porukam';
    document.title = title === brand ? brand : `${title} · ${brand}`;
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'description');
      document.head.appendChild(tag);
    }
    tag.setAttribute('content', description);
  }, [title, description]);
}
