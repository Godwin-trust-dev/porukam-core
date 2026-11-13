import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './EvidenceList.module.css';

export type StageEvidenceKind = 'image' | 'doc';

export interface StageEvidenceItemView {
  id: string;
  filename: string;
  kind: StageEvidenceKind;
  thumbUrl?: string;
  /** `draft` — файл ещё НА УСТРОЙСТВЕ, на сервер не уходил (ADR-160). */
  status: 'uploading' | 'stored' | 'draft';
  /** «загружено {время}» — undefined, пока status === 'uploading'. */
  uploadedLabel?: string;
  /** «черновик — ещё не отправлено» (только при status === 'draft'). */
  draftLabel?: string;
  /** «загружено с задержкой N дней» — отдельная метка (ADR-036), не влияет на цвет. */
  lateLabel?: string;
  /** «🔒 хеш зафиксирован» — только когда integrity === 'hashed'. */
  hashedLabel?: string;
  bindLabel: string;
  /** Пояснение автора, данное при загрузке («что тут снято»); у черновика —
   *  то, что уйдёт вместе с файлом. Пусто — описания не давали. */
  description?: string;
  errorLabel?: string;
  /** Явный запрет удаления конкретной строки: серверное доказательство
   *  неизменяемо (DELETE у бэка нет), черновик — удаляется одним касанием.
   *  По умолчанию строка удаляется, если у списка вообще есть `onDelete`. */
  deletable?: boolean;
}

export interface EvidenceListProps {
  items: StageEvidenceItemView[];
  emptyText: string;
  onView: (item: StageEvidenceItemView) => void;
  /** Undefined → кнопка удаления скрыта (доступно только до сдачи, §4). */
  onDelete?: (id: string) => void;
  deleteLabel: string;
  retryLabel?: string;
  onRetry?: (id: string) => void;
}

/**
 * Реестр доказательств (DEV-11 §3): метки раздельно и нейтрально (ADR-036) — загрузка,
 * задержка и целостность НЕ схлопываются в один цветной ярлык.
 */
export function EvidenceList({ items, emptyText, onView, onDelete, deleteLabel, retryLabel, onRetry }: EvidenceListProps): JSX.Element {
  if (items.length === 0) {
    return (
      <p className={styles.empty} data-testid="evidence-list-empty">
        {emptyText}
      </p>
    );
  }

  return (
    <ul className={styles.list} data-testid="evidence-list">
      {items.map((it) => (
        <li key={it.id} className={styles.row} data-testid="evidence-item" data-draft={it.status === 'draft' || undefined}>
          <button type="button" className={styles.thumb} onClick={() => onView(it)} aria-label={it.filename} disabled={it.status === 'uploading'}>
            {it.kind === 'image' && it.thumbUrl ? (
              <img src={it.thumbUrl} alt="" className={styles.thumbImg} />
            ) : (
              <Icon name={it.kind === 'image' ? 'camera' : 'attach'} size={20} />
            )}
          </button>
          <div className={styles.main}>
            <p className={styles.name}>{it.filename}</p>
            {it.description ? (
              <p className={styles.description} data-testid="evidence-description">
                {it.description}
              </p>
            ) : null}
            <div className={styles.labels}>
              {it.errorLabel ? (
                <span className={styles.errorLabel} role="alert">
                  {it.errorLabel}
                </span>
              ) : (
                <>
                  {it.draftLabel ? (
                    <span className={styles.draftLabel} data-testid="evidence-draft-label">
                      {it.draftLabel}
                    </span>
                  ) : null}
                  {it.uploadedLabel ? <span className={styles.label}>{it.uploadedLabel}</span> : null}
                  {it.lateLabel ? <span className={styles.lateLabel}>{it.lateLabel}</span> : null}
                  {it.hashedLabel ? <span className={styles.hashedLabel}>{it.hashedLabel}</span> : null}
                </>
              )}
            </div>
          </div>
          <Badge tone="neutral" className={styles.bind}>{it.bindLabel}</Badge>
          {it.errorLabel && onRetry && retryLabel ? (
            <Button variant="ghost" size="sm" onClick={() => onRetry(it.id)}>
              {retryLabel}
            </Button>
          ) : null}
          {onDelete && it.deletable !== false ? (
            <Button variant="ghost" size="sm" onClick={() => onDelete(it.id)} aria-label={`${deleteLabel} · ${it.filename}`}>
              <Icon name="trash" size={16} />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
