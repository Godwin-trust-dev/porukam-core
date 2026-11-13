import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealContract } from '@porukam/core';
import { Button, Callout, Modal, SearchSelect, TextField } from '@porukam/ui';
import { coerceRevisionValueForOption, revisionInputFromOption, useRevisionItemOptions } from './contractFields';
import { RevisionValueField } from './RevisionValueField';

export interface RevisionProposeSubmit {
  item_ref: string;
  new_value: unknown;
  comment?: string;
}

/**
 * «Предложить правку» (ADR-123). Раньше все три поля были свободным текстом:
 * «Что меняем» — строка (бэк складывал её в `item_ref` и потом не мог понять,
 * какое поле договора менять), «Было» — заполнялось руками и расходилось с
 * договором. Теперь «Что меняем» — КОМБОБОКС С ПОИСКОМ по пунктам договора
 * (`SearchSelect`, замечание владельца 03.09 про «огромный список с крупным
 * текстом»): секции «Оплаты», «Этапы», «Материалы», «Условия», серой второй
 * строкой — текущее значение пункта. «Было» подставляется из текущего значения
 * и только читается (бэк заполняет его сам — не отправляем), «Стало» — виджет
 * по типу поля, ПРЕДЗАПОЛНЕННЫЙ текущим значением: правка почти всегда сдвиг
 * от того, что уже в договоре (срок на неделю позже, сумма на пару тысяч
 * выше), а не набор с нуля. Пока «Стало» не отличается от предзаполненного,
 * кнопка выключена — правка «было X → стало X» ничего не согласовывает.
 *
 * «Другое» — произвольный текст: принятая правка уходит в `additional_terms`
 * договора и печатается в условиях перед подписанием.
 *
 * ADR-157: принятую правку бэк применяет по ВСЕМ пунктам списка — и по
 * оплате, и по этапам, и по материалам. Предупреждения «в текст договора
 * правку вносят стороны» здесь больше нет: оно было честным, пока адреса не
 * применялись, а теперь врало бы. Зато значение по такому адресу проверяется
 * ещё на предложении, и 422 приходит с кодом поля — показываем его у «Стало».
 */
export function RealProposeRevisionModal({
  open,
  contract,
  onClose,
  onSubmit,
  pending,
  valueError,
}: {
  open: boolean;
  contract: RealContract;
  onClose: () => void;
  onSubmit: (input: RevisionProposeSubmit) => void;
  pending: boolean;
  /** 422 `revision_value_invalid` / `revision_item_unknown` — у поля «Стало». */
  valueError?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const options = useRevisionItemOptions(contract);
  const [itemRef, setItemRef] = useState('');
  const [after, setAfter] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (open) {
      setItemRef('');
      setAfter('');
      setComment('');
    }
  }, [open]);

  const selected = options.find((o) => o.ref === itemRef);
  const isOther = itemRef === 'other';
  // Предзаполненное «Стало» = текущее значение: правка, которая ничего не
  // меняет, — не правка. Вторая сторона иначе получала бы в протокол
  // разногласий пункт «было X → стало X» и решала бы по нему.
  const prefilled = selected ? revisionInputFromOption(selected) : '';
  const canSubmit = !!selected && after.trim().length > 0 && after !== prefilled;

  return (
    <Modal
      open={open}
      title={t('contract.proposeRevision')}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="real-submit-revision"
            disabled={!canSubmit}
            loading={pending}
            onClick={() => {
              if (!selected) return;
              onSubmit({
                item_ref: selected.ref,
                // «Было» не отправляем: бэк подставляет текущее значение сам
                // (ADR-123 §2), иначе оно разъедется с договором.
                new_value: isOther ? after.trim() : coerceRevisionValueForOption(selected, after),
                comment: comment.trim() || undefined,
              });
            }}
          >
            {t('contract.proposeRevision')}
          </Button>
        </>
      }
    >
      {/* «Что меняем» — комбобокс с поиском и секциями договора вместо
          нативного списка с крупным системным шрифтом (замечание владельца
          03.09); серой второй строкой — текущее значение пункта. */}
      <SearchSelect
        label={t('contract.revisionItem')}
        help={t('hints.revision.item')}
        helpLabel={t('hints.helpButton')}
        value={itemRef}
        onChange={(ref) => {
          setItemRef(ref);
          // «Стало» стартует от текущего значения пункта (ADR-123: правка —
          // это сдвиг от того, что уже в договоре, а не набор с нуля).
          const next = options.find((o) => o.ref === ref);
          setAfter(next ? revisionInputFromOption(next) : '');
        }}
        options={options.map((o) => ({
          value: o.ref,
          label: o.label,
          hint: o.currentText || undefined,
          group: o.group,
        }))}
        placeholder={t('contract.revisionItemPlaceholder')}
        noMatchText={t('common.noMatches')}
        data-testid="real-revision-item"
      />

      {selected && !isOther ? (
        <TextField
          label={t('contract.revisionBefore')}
          help={t('hints.revision.before')}
          helpLabel={t('hints.helpButton')}
          value={selected.currentText}
          readOnly
          hint={selected.currentText ? undefined : t('contract.revisionBeforeEmpty')}
          data-testid="real-revision-before"
        />
      ) : null}

      {isOther ? <Callout tone="neutral">{t('contract.revisionOtherHint')}</Callout> : null}

      {selected ? (
        <RevisionValueField
          label={isOther ? t('contract.revisionOtherLabel') : t('contract.revisionAfter')}
          help={t('hints.revision.after')}
          helpLabel={t('hints.helpButton')}
          type={selected.type}
          choices={selected.choices}
          searchable={selected.searchable ?? false}
          value={after}
          onChange={setAfter}
          testId="real-revision-after"
          error={valueError}
        />
      ) : null}

      <TextField
        label={t('review.commentLabel')}
        help={t('hints.revision.comment')}
        helpLabel={t('hints.helpButton')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
    </Modal>
  );
}
