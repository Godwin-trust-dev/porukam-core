import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Callout } from '@porukam/ui';
import {
  dismissDefaultBrowserHint,
  openDefaultAppsSettings,
  shouldShowDefaultBrowserHint,
} from './defaultBrowserHint';
import styles from './DefaultBrowserHint.module.css';

/**
 * «Сделайте Chrome браузером по умолчанию» — плашка внутри приложения, открытого
 * не в Chrome (условия — в `defaultBrowserHint.ts`).
 *
 * Почему словами, а не кодом: обёртка открывает страницу в браузере по
 * умолчанию, и выбрать его за человека нельзя — это системная настройка
 * (проверено 10.09). Поэтому здесь ровно то, что человеку нужно: одна фраза
 * «почему», путь по системным настройкам и кнопка, которая туда ведёт.
 *
 * Кнопка — не единственный путь и не обязана срабатывать: `intent://` понимает
 * не всякий браузер, и неудача перехода ничего не ломает — текстовая инструкция
 * стоит рядом всегда, а не вместо неё.
 */
export interface DefaultBrowserHintProps {
  /** Снаружи плашку иногда прячут в свою обёртку (лента) — общий класс отдаём наружу. */
  className?: string;
}

export function DefaultBrowserHint({ className }: DefaultBrowserHintProps): JSX.Element | null {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(() => !shouldShowDefaultBrowserHint());
  if (hidden) return null;

  function onOpenSettings(): void {
    // Ответ намеренно игнорируем: не сработало — человек идёт по инструкции ниже.
    openDefaultAppsSettings();
  }

  function onDismiss(): void {
    dismissDefaultBrowserHint();
    setHidden(true);
  }

  return (
    <div className={className} data-testid="default-browser-hint">
      <Callout tone="warn" title={t('pwa.defaultBrowserTitle')}>
        <div className={styles.wrap}>
          <p className={styles.text}>{t('pwa.defaultBrowserWhy')}</p>
          <p className={styles.steps}>{t('pwa.defaultBrowserSteps')}</p>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={onOpenSettings} data-testid="default-browser-open">
              {t('pwa.defaultBrowserOpenSettings')}
            </Button>
            <Button variant="link" size="sm" onClick={onDismiss} data-testid="default-browser-dismiss">
              {t('pwa.defaultBrowserDismiss')}
            </Button>
          </div>
        </div>
      </Callout>
    </div>
  );
}
