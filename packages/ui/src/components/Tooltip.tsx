import { useRef, useState, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  text: string;
  children: ReactNode;
}

const LONG_PRESS_MS = 500;

/**
 * Тултип по наведению/фокусу (десктоп) и лонг-тапу (тач) — DEV-16a §2/§4, напр.
 * beta-бейдж «переведено автоматически — может быть неточно». `children` — сам
 * триггер (обычно фокусируемый элемент), уже отвечающий за собственный клик.
 */
export function Tooltip({ text, children }: TooltipProps): JSX.Element {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const show = (): void => setVisible(true);
  const hide = (): void => setVisible(false);
  const onTouchStart = (): void => {
    timerRef.current = window.setTimeout(show, LONG_PRESS_MS);
  };
  const onTouchEnd = (): void => {
    window.clearTimeout(timerRef.current);
  };

  return (
    <span
      className={styles.wrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchEnd}
    >
      {children}
      {visible ? (
        <span role="tooltip" className={styles.bubble}>
          {text}
        </span>
      ) : null}
    </span>
  );
}
