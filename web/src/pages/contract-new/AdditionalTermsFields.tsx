import { useTranslation } from 'react-i18next';
import { Button, TextArea } from '@porukam/ui';
import {
  ADDITIONAL_TERM_MAX_LENGTH,
  ADDITIONAL_TERMS_MAX_ITEMS,
} from '../../features/contractNew/additionalTerms';
import styles from './AdditionalTermsFields.module.css';

export interface AdditionalTermsFieldsProps {
  items: string[];
  onChange: (next: string[]) => void;
}

/**
 * ADR-167 — «Дополнительные условия» в мастере: единственное свободное
 * текстовое поле договора. До него написать своё условие можно было только
 * правкой «Другое» в протоколе разногласий (ADR-123, уже ПОСЛЕ отправки
 * контрагенту) или допсоглашением (после подписания).
 *
 * Блок, а не отдельный шаг: мастер и так длинный (до семи шагов), а пункты
 * дописывают ровно то, чего не покрыла форма шага, — читаются на своём месте,
 * последним разделом условий. Пишется в тот же `Contract.additional_terms`,
 * что копит принятая правка «Другое», — на экране подписания и в карточке
 * договора список один (`contract.termsAdditionalTitle`, нумерованный).
 */
export function AdditionalTermsFields({ items, onChange }: AdditionalTermsFieldsProps): JSX.Element {
  const { t } = useTranslation();
  const atLimit = items.length >= ADDITIONAL_TERMS_MAX_ITEMS;

  function setAt(index: number, value: string): void {
    onChange(items.map((item, i) => (i === index ? value : item)));
  }

  return (
    <section className={styles.block} data-testid="additional-terms">
      <h3 className={styles.title}>{t('contractNew.additionalTerms.title')}</h3>
      <p className={styles.sub}>{t('contractNew.additionalTerms.sub')}</p>

      {items.map((item, index) => (
        // Индекс как ключ намеренно: пункты — позиционный список без своих id,
        // а текст меняется на каждый ввод (текстом ключевать нельзя).
        <div key={index} className={styles.item}>
          <TextArea
            label={t('contractNew.additionalTerms.itemLabel', { number: index + 1 })}
            placeholder={t('contractNew.additionalTerms.placeholder')}
            value={item}
            rows={3}
            maxLength={ADDITIONAL_TERM_MAX_LENGTH}
            onChange={(e) => setAt(index, e.target.value)}
            data-testid={`additional-term-${index}`}
          />
          <div className={styles.itemFoot}>
            <span
              className={`${styles.counter}${item.length >= ADDITIONAL_TERM_MAX_LENGTH ? ` ${styles.counterOver}` : ''}`}
              data-testid={`additional-term-counter-${index}`}
            >
              {t('contractNew.additionalTerms.counter', {
                used: item.length,
                max: ADDITIONAL_TERM_MAX_LENGTH,
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              data-testid={`additional-term-remove-${index}`}
            >
              {t('contractNew.additionalTerms.remove')}
            </Button>
          </div>
        </div>
      ))}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => onChange([...items, ''])}
        disabled={atLimit}
        data-testid="additional-term-add"
      >
        {t('contractNew.additionalTerms.add')}
      </Button>
      {atLimit ? (
        <p className={styles.note} data-testid="additional-terms-limit">
          {t('contractNew.additionalTerms.limitReached', { max: ADDITIONAL_TERMS_MAX_ITEMS })}
        </p>
      ) : null}

      <p className={styles.note}>{t('contractNew.additionalTerms.note')}</p>
    </section>
  );
}
