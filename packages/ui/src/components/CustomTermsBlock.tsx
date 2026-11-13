import { Badge } from './Badge';
import { Button } from './Button';
import styles from './CustomTermsBlock.module.css';

export interface CustomTermsBlockProps {
  title: string;
  tag: string;
  text: string;
  translateCta: string;
}

/**
 * Своя редакция (`custom_terms`, DEV-16b §3/§5) — оригинал автора как есть, метка
 * «текст стороны» + тег «не переводится платформой», место под будущую кнопку
 * «Перевести» (заглушка/disabled — сама кнопка появится позже, с пометкой «автоперевод,
 * не официальный текст»).
 */
export function CustomTermsBlock({ title, tag, text, translateCta }: CustomTermsBlockProps): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <Badge tone="neutral">{tag}</Badge>
      </div>
      <p className={styles.text}>{text}</p>
      <Button variant="ghost" size="sm" disabled title={translateCta}>
        {translateCta}
      </Button>
    </div>
  );
}
