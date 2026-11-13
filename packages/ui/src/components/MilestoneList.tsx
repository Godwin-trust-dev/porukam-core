import { Badge } from './Badge';
import { LtrText } from './LtrText';
import styles from './MilestoneList.module.css';

export interface MilestoneListItem {
  id: string;
  title: string;
  /** Уже переведённый статус этапа — компонент ничего не локализует. */
  statusLabel?: string;
  /** Этап принят/оплачен — teal-галочка (канон степпера: done = teal ✓). */
  done?: boolean;
  /** Этап, который «сейчас»: в работе, сдан, на приёмке. */
  current?: boolean;
  /** Готовая сумма листа (formatMoney на стороне страницы). */
  amountLabel?: string;
  onOpen?: () => void;
}

export interface MilestoneListProps {
  title: string;
  items: MilestoneListItem[];
  /** «3 / 5» — счётчик принятых листьев. */
  countLabel?: string;
  /** Заполнение полосы прогресса, 0…100. */
  progressPct?: number;
  /** Подпись чипа у текущего этапа («сейчас»). */
  nowLabel?: string;
  /** Текст, когда листьев ещё нет (черновик без этапов). */
  emptyText?: string;
}

/**
 * Список этапов «только чтение» (DEV-19 §2/§4, эталон №4 блоки 2 и 3):
 * в облегчённой карточке master-detail и в теле карточки договора это ОДИН
 * компонент — не две похожие вёрстки. Редактирование дерева этапов живёт
 * отдельно (мастер создания / панель этапов), сюда не приезжает.
 */
export function MilestoneList({
  title,
  items,
  countLabel,
  progressPct,
  nowLabel,
  emptyText,
}: MilestoneListProps): JSX.Element {
  return (
    <section className={styles.wrap} data-testid="milestone-list">
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        {countLabel ? <LtrText as="span" className={styles.count}>{countLabel}</LtrText> : null}
      </div>

      {typeof progressPct === 'number' ? (
        <div
          className={styles.track}
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={title}
        >
          <div className={styles.fill} style={{ inlineSize: `${progressPct}%` }} />
        </div>
      ) : null}

      {items.length === 0 ? (
        emptyText ? <p className={styles.empty}>{emptyText}</p> : null
      ) : (
        <ul className={styles.items}>
          {items.map((m) => {
            const inner = (
              <>
                <span className={`${styles.mark} ${m.done ? styles.markDone : ''}`} aria-hidden="true">
                  {m.done ? (
                    /* Тот же глиф галочки, что у Checkbox — в наборе иконок
                       отдельного `check` нет, дублировать набор незачем. */
                    <svg viewBox="0 0 16 16" width={12} height={12}>
                      <path
                        d="M3 8.5 6.2 11.5 13 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className={styles.body}>
                  <span className={styles.name}>{m.title}</span>
                  {m.statusLabel ? <span className={styles.status}>{m.statusLabel}</span> : null}
                </span>
                {m.current && nowLabel ? <Badge tone="amber">{nowLabel}</Badge> : null}
                {m.amountLabel ? (
                  <LtrText as="span" className={styles.amount}>
                    {m.amountLabel}
                  </LtrText>
                ) : null}
              </>
            );
            return (
              <li className={styles.item} key={m.id} data-testid="milestone-list-item">
                {m.onOpen ? (
                  <button type="button" className={styles.itemButton} onClick={m.onOpen}>
                    {inner}
                  </button>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
