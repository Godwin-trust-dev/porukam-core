import { Badge, type BadgeTone } from './Badge';
import { Button } from './Button';
import { LtrText } from './LtrText';
import { EmptyState } from './States';
import styles from './AmendmentsBlock.module.css';

export interface AmendmentItem {
  id: string;
  title: string;
  statusLabel: string;
  statusTone: BadgeTone;
  amountDeltaLabel?: string;
  createdAtLabel: string;
}

export interface AmendmentsBlockProps {
  amendments: AmendmentItem[];
  onOpen?: (id: string) => void;
  emptyTitle: string;
  emptyText: string;
  /** Создание допника — необязательно: реальный контур (ADR-088) пока
   * даёт только просмотр и подписание, формы создания во фронте нет —
   * без `createLabel`/`onCreate` кнопки не рендерятся. */
  createLabel?: string;
  onCreate?: () => void;
}

/** Допники (DEV-06 §3/§5, история договора) — пусто → пояснение + «Создать допник». */
export function AmendmentsBlock({ amendments, onOpen, emptyTitle, emptyText, createLabel, onCreate }: AmendmentsBlockProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="amendments-block">
      {amendments.length === 0 ? (
        <EmptyState icon="contract" title={emptyTitle} text={emptyText} actionLabel={createLabel} onAction={onCreate} />
      ) : (
        <>
          <div className={styles.list}>
            {amendments.map((a) => {
              const body = (
                <>
                  <div className={styles.main}>
                    <p className={styles.title}>{a.title}</p>
                    <p className={styles.meta}>
                      {a.createdAtLabel}
                      {a.amountDeltaLabel ? (
                        <>
                          {' · '}
                          <LtrText as="span">{a.amountDeltaLabel}</LtrText>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Badge tone={a.statusTone}>{a.statusLabel}</Badge>
                </>
              );
              return onOpen ? (
                <button type="button" className={styles.row} key={a.id} onClick={() => onOpen(a.id)}>
                  {body}
                </button>
              ) : (
                <div className={styles.row} key={a.id}>
                  {body}
                </div>
              );
            })}
          </div>
          {createLabel && onCreate ? (
            <Button variant="ghost" onClick={onCreate}>
              {createLabel}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
