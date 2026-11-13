import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import styles from './LtrText.module.css';

export interface LtrTextProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** Тег обёртки — по умолчанию `span` (инлайн-контекст: внутри строки текста). */
  as?: ElementType;
}

/**
 * RTL-фундамент (DEV-16 §6): хеши, коды, номера договоров, @хендлы — всегда
 * `dir="ltr"`, даже в RTL-интерфейсе (это НЕ переводимый текст, а технический
 * идентификатор; в арабской/ивритской раскладке зеркалить его нельзя — иначе
 * hex-хеш или номер станет нечитаемым/перепутанным местами).
 * `unicode-bidi: isolate` — чтобы соседний RTL-текст не «перетягивал» цифры/латиницу.
 */
export function LtrText({ children, as: Tag = 'span', className, ...rest }: LtrTextProps): JSX.Element {
  return (
    <Tag dir="ltr" className={[styles.ltr, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </Tag>
  );
}
