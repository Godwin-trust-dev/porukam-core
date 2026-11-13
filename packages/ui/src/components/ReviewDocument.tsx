import { Button } from './Button';
import { Card } from './Card';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './ReviewDocument.module.css';

export interface ReviewDocumentParty {
  id: string;
  name: string;
  roleLabel: string;
  handle: string;
}

export interface ReviewDocumentStageRow {
  id: string;
  itemRef: string;
  label: string;
  amountLabel: string;
  proposable: boolean;
}

export interface ReviewDocumentTermRow {
  itemRef: string;
  label: string;
  value: string;
  proposable: boolean;
}

export interface ReviewDocumentSectionTitles {
  parties: string;
  essence: string;
  stages: string;
  terms: string;
  requisites: string;
}

export interface ReviewDocumentProps {
  sectionTitles: ReviewDocumentSectionTitles;
  parties: ReviewDocumentParty[];
  essenceText: string;
  stages: ReviewDocumentStageRow[];
  stagesSumLabel: string;
  stagesSum: string;
  terms: ReviewDocumentTermRow[];
  /** Пусто/undefined — секция «Реквизиты» не рендерится (не заполнены). */
  requisitesText?: string;
  proposeLabel: string;
  onPropose: (itemRef: string, itemLabel: string, beforeValue: string) => void;
}

/**
 * Документ по секциям (DEV-10 §3/§9, мобайл — одной колонкой, сворачиваемо): Стороны/
 * Суть/Этапы/Условия/Реквизиты; у проверяемых пунктов — inline «Предложить правку».
 */
export function ReviewDocument({
  sectionTitles,
  parties,
  essenceText,
  stages,
  stagesSumLabel,
  stagesSum,
  terms,
  requisitesText,
  proposeLabel,
  onPropose,
}: ReviewDocumentProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="review-document">
      <Card>
        <h3 className={styles.sectionTitle}>{sectionTitles.parties}</h3>
        {parties.map((p) => (
          <div className={styles.partyRow} key={p.id}>
            <span className={styles.partyName}>{p.name}</span>
            <span className={styles.partyMeta}>
              {p.roleLabel} · {p.handle}
            </span>
          </div>
        ))}
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>{sectionTitles.essence}</h3>
        <p className={styles.essence}>{essenceText}</p>
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>{sectionTitles.stages}</h3>
        <ul className={styles.rows}>
          {stages.map((s) => (
            <li className={styles.row} key={s.id}>
              <span className={styles.rowLabel}>{s.label}</span>
              <LtrText as="span" className={styles.rowValue}>{s.amountLabel}</LtrText>
              {s.proposable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Icon name="edit" size={16} />}
                  onClick={() => onPropose(s.itemRef, s.label, s.amountLabel)}
                  data-testid={`propose-${s.itemRef}`}
                >
                  {proposeLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className={styles.sumRow}>
          <span>{stagesSumLabel}</span>
          <strong className={styles.sum}>{stagesSum}</strong>
        </div>
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>{sectionTitles.terms}</h3>
        <ul className={styles.rows}>
          {terms.map((t) => (
            <li className={styles.row} key={t.itemRef}>
              <span className={styles.rowLabel}>{t.label}</span>
              <span className={styles.rowValue}>{t.value}</span>
              {t.proposable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Icon name="edit" size={16} />}
                  onClick={() => onPropose(t.itemRef, t.label, t.value)}
                  data-testid={`propose-${t.itemRef}`}
                >
                  {proposeLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {requisitesText ? (
        <Card>
          <h3 className={styles.sectionTitle}>{sectionTitles.requisites}</h3>
          <p className={styles.essence}>{requisitesText}</p>
        </Card>
      ) : null}
    </div>
  );
}
