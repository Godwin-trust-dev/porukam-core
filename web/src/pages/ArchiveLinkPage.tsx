import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@porukam/ui';
import styles from './ArchiveLinkPage.module.css';

/**
 * СТРАХОВКА для долгоживущей ссылки на архив `/a/<token>` (ADR-139 §7).
 *
 * В норме этот компонент не должен отрисоваться никогда: nginx проксирует
 * `/a/` в core (`конфиг nginx`), и браузер получает zip,
 * а не оболочку SPA. Но у человека может жить СТАРЫЙ service worker: до правки
 * от 03.09 его `navigateFallbackDenylist` знал только `/^\/v1\//`, поэтому
 * любая навигация на `/a/<token>` подменялась `index.html` из precache и до
 * сети не доходила вовсе (инцидент 03.09, docs/backlog.md). Обновляется SW
 * только с согласия пользователя (`registerType: 'prompt'`), то есть старая
 * копия живёт у него ровно до того, как он нажмёт «Обновить».
 *
 * Поэтому: если оболочка всё-таки открылась по адресу `/a/…` — снимаем
 * регистрацию service worker'а (следующая навигация после `unregister()` уже
 * не контролируется им) и повторяем переход по тому же адресу. Заодно это
 * лечит человека насовсем: при следующем заходе в приложение зарегистрируется
 * УЖЕ ИСПРАВЛЕННЫЙ worker.
 *
 * `?swbypass=1` — метка «попытка уже была»: без неё пара «оболочка → переход →
 * снова оболочка» крутилась бы вечно там, где `/a/` не проксируется вовсе
 * (dev-сервер, `vite preview`, сломанный конфиг nginx). С меткой второй заход
 * рисует честный экран с обычной ссылкой `<a download>` — она у SW не
 * навигация и работает даже со старым worker'ом.
 */

/**
 * Единственная точка настоящей (не роутерной) навигации — вынесена ради теста:
 * jsdom не даёт подменить `window.location.replace` напрямую.
 */
export const archiveLinkNavigation = {
  replace(url: string): void {
    window.location.replace(url);
  },
};

const BYPASS_PARAM = 'swbypass';

export function ArchiveLinkPage(): JSX.Element {
  const { t } = useTranslation();
  const [bypassFailed, setBypassFailed] = useState(false);
  // Полный адрес архива — берём из адресной строки, а не из роутера: уходить
  // отсюда надо на сервер, `Link`/`navigate` остались бы внутри SPA.
  const [href] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(BYPASS_PARAM) !== null) {
      setBypassFailed(true);
      return;
    }
    url.searchParams.set(BYPASS_PARAM, '1');

    void (async () => {
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
        await Promise.all(regs.map((reg) => reg.unregister()));
      } catch {
        // Нет service worker'а или браузер не дал его снять — переход всё равно
        // пробуем: хуже, чем сейчас, уже не будет.
      }
      archiveLinkNavigation.replace(url.toString());
    })();
  }, []);

  return (
    <main className={styles.page} data-testid="archive-link-page">
      {bypassFailed ? (
        <>
          <p className={styles.text}>{t('archive.linkOpenFallback')}</p>
          <a className={styles.action} href={href} download data-testid="archive-link-download">
            {t('archive.linkOpenAction')}
          </a>
        </>
      ) : (
        <>
          <p className={styles.text}>{t('archive.linkOpening')}</p>
          <Skeleton width="60%" height={14} />
        </>
      )}
    </main>
  );
}
