import type { ComponentType, ReactNode } from 'react';
import { LtrText } from './LtrText';
import styles from './SummaryCard.module.css';

/** Пропы ссылки-плитки. Совпадают с `Link` react-router — но зависимости на
    роутер у `@porukam/ui` нет и не заводится (маршруты знает страница). */
export interface SummaryStatLinkProps {
  to: string;
  className?: string;
  children?: ReactNode;
}

export interface SummaryStat {
  /** Готовое к показу число — компонент не считает и не форматирует. */
  value: string;
  label: string;
  /** Адрес, если плитка — вход в раздел (счётчики «Деньги» ведут на вкладки
      «Сделок», решение владельца 05.09). Без него плитка остаётся статикой. */
  to?: string;
}

export interface SummaryCardProps {
  /** Надзаголовок капслоком («ДЕНЬГИ В АКТИВНЫХ СДЕЛКАХ»). */
  eyebrow: string;
  /** Крупные значения — по одному на валюту (Money не складывает разные валюты). */
  values?: ReactNode[];
  note?: string;
  stats?: SummaryStat[];
  /** Компонент ссылки для плиток с `to` — страница даёт обёртку над `Link`
      роутера. SPA-переход обязателен: токены живут в памяти, перезагрузка
      их теряет. */
  statLinkAs?: ComponentType<SummaryStatLinkProps>;
  children?: ReactNode;
}

/**
 * Карточка сводки правого рейла (DEV-19 §3): надзаголовок, крупное значение,
 * плитки-счётчики. Числа — `tabular-nums`, как во всех юр-значимых местах
 * (Промт web-v2 §0).
 */
export function SummaryCard({ eyebrow, values, note, stats, statLinkAs: StatLink, children }: SummaryCardProps): JSX.Element {
  return (
    <section className={styles.card}>
      <h3 className={styles.eyebrow}>{eyebrow}</h3>
      {values && values.length > 0 ? (
        <div className={styles.values}>
          {values.map((v, i) => (
            <LtrText as="span" className={styles.value} key={i}>
              {v}
            </LtrText>
          ))}
        </div>
      ) : null}
      {note ? <span className={styles.note}>{note}</span> : null}
      {stats && stats.length > 0 ? (
        <dl className={styles.stats}>
          {stats.map((s) => (
            // Плитка со ссылкой остаётся той же `<div>`-группой списка
            // определений: `<dl>` по спецификации принимает только группы
            // `dt`/`dd` (в обёртке `div`), ссылку вокруг них класть нельзя.
            // Поэтому ссылка живёт в подписи, а кликабельна вся плитка —
            // растянутый `::after` (`.statLink` в CSS). Вид числа и подписи
            // не меняется: ссылочность видна по наведению и фокусу.
            <div className={`${styles.stat} ${s.to && StatLink ? styles.statLinked : ''}`} key={s.label}>
              <dt className={styles.statLabel}>
                {s.to && StatLink ? (
                  <StatLink to={s.to} className={styles.statLink}>
                    {s.label}
                  </StatLink>
                ) : (
                  s.label
                )}
              </dt>
              <dd className={styles.statValue}>{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </section>
  );
}
