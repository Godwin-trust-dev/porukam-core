import styles from './Toast.module.css';

export interface ToastProps {
  text: string;
}

/**
 * Тихий информационный тост — низ экрана, авто-исчезает (таймер — на вызывающей
 * стороне, см. `useDismissedLocaleToast`-подобные паттерны). Отличается от
 * `UpdateToast` отсутствием действия — только сообщение (напр. DEV-16a §4
 * «{Язык} временно недоступен · показываем английский»).
 */
export function Toast({ text }: ToastProps): JSX.Element {
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.text}>{text}</span>
    </div>
  );
}
