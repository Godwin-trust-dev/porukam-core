import type { ReactNode } from 'react';
import styles from './ScreenHeader.module.css';

export interface ScreenHeaderProps {
  title: ReactNode;
  /** Кнопка/ссылка «назад» слева (детальные экраны). */
  back?: ReactNode;
  /** Правый край: «+ Создать», «Прочитать все», чип актёра. */
  actions?: ReactNode;
  /** Вторая строка — редкая подпись (снимок архива, этап договора). */
  subtitle?: ReactNode;
  /** Заголовок экрана — `h1`; вложенный раздел — `h2`. */
  level?: 1 | 2;
  /**
   * На узком экране заголовок и действия несёт шапка оболочки (финал доска A:
   * «Уведомления · Прочитать все», «Чат · +») — свою шапку экран прячет,
   * чтобы название не стояло дважды. На десктопе рисуется как обычно.
   */
  inShell?: boolean;
  className?: string;
}

/**
 * Компактная шапка экрана (DEV-20 §4): заголовок 16–18 без большого
 * амбер-пилла, действия — справа компактным рядом. Один язык шапки у
 * мобильного и десктопа.
 */
export function ScreenHeader({ title, back, actions, subtitle, level = 1, inShell, className }: ScreenHeaderProps): JSX.Element {
  const Title = level === 1 ? 'h1' : 'h2';
  return (
    <div className={`${styles.head} ${inShell ? styles.inShell : ''} ${className ?? ''}`}>
      <div className={styles.line}>
        {back ? <span className={styles.back}>{back}</span> : null}
        <Title className={styles.title}>{title}</Title>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
    </div>
  );
}
