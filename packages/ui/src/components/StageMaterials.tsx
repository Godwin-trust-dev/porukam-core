import type { MaterialState } from '@porukam/core';
import { Badge, type BadgeTone } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './StageMaterials.module.css';

export interface StageMaterialItem {
  id: string;
  name: string;
  suppliedBy: string;
  due?: string;
  state: MaterialState;
}

export interface StageMaterialsProps {
  materials: StageMaterialItem[];
  stateLabels: Record<MaterialState, string>;
  /** Проблема с материалом → окно оспаривания (ADR-019). */
  onOpenProblem?: (id: string) => void;
  problemActionLabel?: string;
  problemNote?: string;
}

const STATE_TONE: Record<MaterialState, BadgeTone> = {
  received: 'green',
  expected: 'neutral',
  problem: 'red',
};

/** Материалы этапа (DEV-06 §3, внутри вкладки «Этапы»). */
export function StageMaterials({ materials, stateLabels, onOpenProblem, problemActionLabel, problemNote }: StageMaterialsProps): JSX.Element {
  const hasProblem = materials.some((m) => m.state === 'problem');
  return (
    <div className={styles.wrap} data-testid="stage-materials">
      {materials.map((m) => (
        <div className={styles.row} key={m.id}>
          <Icon name="wallet" size={20} className={styles.icon} />
          <div className={styles.main}>
            <p className={styles.name}>{m.name}</p>
            <p className={styles.meta}>
              {m.suppliedBy}
              {m.due ? ` · ${m.due}` : ''}
            </p>
          </div>
          <Badge tone={STATE_TONE[m.state]} dot>
            {stateLabels[m.state]}
          </Badge>
          {m.state === 'problem' && onOpenProblem ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenProblem(m.id)}>
              {problemActionLabel}
            </Button>
          ) : null}
        </div>
      ))}
      {hasProblem && problemNote ? <p className={styles.problemNote}>{problemNote}</p> : null}
    </div>
  );
}
