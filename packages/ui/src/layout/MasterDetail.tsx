import type { ReactNode } from 'react';
import { useDesktopLayout } from './breakpoints';
import styles from './MasterDetail.module.css';

export interface MasterDetailProps {
  /** Колонка списка — единственное, что видно на узком экране. */
  list: ReactNode;
  /**
   * Колонка деталей. Функция, а не узел: на `<1024` она НЕ вызывается —
   * детали там отдельная страница, и монтировать их запросы незачем.
   */
  detail: () => ReactNode;
  /** Доступное имя области деталей (aria-label у `<aside>`). */
  detailLabel: string;
}

/**
 * Master-detail (DEV-19 §2, эталон №4 блок 2) для «Моих договоров»,
 * уведомлений и споров: `≥1024` — список слева + детали справа в одном
 * экране; `<1024` — полноэкранный список.
 *
 * Компонент отвечает ТОЛЬКО за раскладку. Выбор строки, его отражение в URL
 * и переход на узком экране — забота страницы (она же решает по
 * `useDesktopLayout()`, что делает клик).
 */
export function MasterDetail({ list, detail, detailLabel }: MasterDetailProps): JSX.Element {
  const isDesktop = useDesktopLayout();
  return (
    <div className={styles.wrap} data-layout={isDesktop ? 'master-detail' : 'stack'}>
      <div className={styles.list}>{list}</div>
      {isDesktop ? (
        <aside className={styles.detail} aria-label={detailLabel} data-testid="master-detail-pane">
          {detail()}
        </aside>
      ) : null}
    </div>
  );
}
