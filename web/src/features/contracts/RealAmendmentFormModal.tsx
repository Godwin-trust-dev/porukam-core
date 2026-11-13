import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealAmendment, RealAmendmentCreateInput, RealContract } from '@porukam/core';
import { Button, Callout, Modal, SearchSelect, TextArea, TextField } from '@porukam/ui';
import {
  amendmentChangeForOption,
  splitAmendmentChanges,
  useAmendmentChangeOptions,
  type AmendmentChangeRow,
} from './amendmentChanges';
import { RevisionValueField } from './RevisionValueField';
import { useFormatters } from '../../shared/formatters';

let rowSeq = 0;
const nextRowKey = (): string => `row-${(rowSeq += 1)}`;

/**
 * Форма допсоглашения (ADR-161): создание нового и правка ЧЕРНОВИКА — одна и
 * та же, потому что тело `PATCH` равно телу `POST` (`changes` заменяется
 * целиком). Отличается только заголовок и то, куда уходит результат.
 *
 * «Что меняем» — тот же комбобокс с секциями, что у «Предложить правку»
 * (`useAmendmentChangeOptions` — отфильтрованный словарь ADR-157), поэтому
 * человек ищет пункт договора одинаково до и после подписания. Значения
 * приводит к типам API `amendmentChangeForOption`: сумма — парой
 * `{amount, currency}` в валюте этапа (валюты по умолчанию нет), срок —
 * ISO-датой.
 *
 * Предпросмотр дельты — клиентский и ЧЕСТНО помечен как предварительный:
 * окончательные `amount_delta`/`days_delta` считает сервер от состояния
 * дерева на момент сохранения (`_create_amendment_change`), и они приезжают
 * в ответе. Здесь он нужен, чтобы «сумма этапа 45 000 → 40 000» читалась как
 * «−5 000», а не как два числа.
 *
 * Две кнопки сохранения — «Сохранить черновик» и «Отправить на согласование»
 * — потому что это два разных решения: заготовку видит только автор, а
 * отправленный допник уже нельзя править (ADR-161 §2).
 */
export function RealAmendmentFormModal({
  open,
  contract,
  initial,
  onClose,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  contract: RealContract;
  /** Черновик для правки; `undefined` — создание нового допника. */
  initial?: RealAmendment;
  onClose: () => void;
  /** `andSend` — «Отправить на согласование»: сохранить и сразу `/send`. */
  onSubmit: (input: RealAmendmentCreateInput, andSend: boolean) => void;
  pending: boolean;
  /** Ошибка бэка целиком (403/409/422) — над кнопками. */
  error?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const options = useAmendmentChangeOptions(contract);

  const [reason, setReason] = useState('');
  const [customTerms, setCustomTerms] = useState('');
  const [rows, setRows] = useState<AmendmentChangeRow[]>([]);

  // Изменения, которые форма не показывает (скидка по спору, add_milestone),
  // уходят обратно как есть — PATCH заменяет список целиком.
  const passthrough = useMemo(
    () => (initial ? splitAmendmentChanges(initial.changes).passthrough : []),
    [initial],
  );

  useEffect(() => {
    if (!open) return;
    setReason(initial?.reason ?? '');
    setCustomTerms(initial?.custom_terms ?? '');
    setRows(initial ? splitAmendmentChanges(initial.changes).rows : []);
  }, [open, initial]);

  const optionOf = (ref: string) => options.find((o) => o.ref === ref);

  const filled = rows
    .map((row) => {
      const option = optionOf(row.ref);
      return option ? amendmentChangeForOption(option, row.value) : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  /** Предварительная денежная дельта по строкам «сумма этапа»: новое минус
   * текущее. Смешанные валюты не складываем — бэк на них ответит 422
   * `currency_mismatch`, врать суммой раньше него незачем. */
  const preview = (() => {
    let total = 0;
    let currency = '';
    let mixed = false;
    for (const row of rows) {
      const option = optionOf(row.ref);
      if (!option || !option.ref.endsWith('.amount') || row.value.trim() === '') continue;
      const before = option.current as { amount: string; currency: string } | null;
      const next = Number(row.value.replace(',', '.'));
      if (!Number.isFinite(next)) continue;
      const cur = option.currency ?? before?.currency ?? '';
      if (!cur) continue;
      if (currency && currency !== cur) mixed = true;
      currency = cur;
      total += next - Number(before?.amount ?? 0);
    }
    if (mixed || !currency || total === 0) return null;
    return formatMoney({ amount: total.toFixed(2), currency });
  })();

  const canSubmit = reason.trim().length > 0 && !pending;
  const body = (): RealAmendmentCreateInput => ({
    reason: reason.trim(),
    custom_terms: customTerms.trim(),
    changes: [...filled, ...passthrough],
  });

  return (
    <Modal
      open={open}
      title={t(initial ? 'contract.amendment.formEditTitle' : 'contract.amendment.formCreateTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid="amendment-save-draft"
            disabled={!canSubmit}
            loading={pending}
            onClick={() => onSubmit(body(), false)}
          >
            {t('contract.amendment.saveDraftCta')}
          </Button>
          <Button
            variant="primary"
            data-testid="amendment-save-and-send"
            disabled={!canSubmit}
            loading={pending}
            onClick={() => onSubmit(body(), true)}
          >
            {t('contract.amendment.sendCta')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('contract.amendment.reasonLabel')}
        hint={t('contract.amendment.reasonHint')}
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="amendment-form-reason"
      />

      <h4>{t('contract.amendment.changesTitle')}</h4>
      {rows.length === 0 ? <Callout tone="neutral">{t('contract.amendment.changesEmpty')}</Callout> : null}

      {rows.map((row, index) => {
        const option = optionOf(row.ref);
        return (
          <div key={row.key} data-testid="amendment-change-row">
            <SearchSelect
              label={t('contract.revisionItem')}
              value={row.ref}
              onChange={(ref) =>
                setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ref, value: '' } : r)))
              }
              options={options.map((o) => ({ value: o.ref, label: o.label, hint: o.currentText || undefined, group: o.group }))}
              placeholder={t('contract.revisionItemPlaceholder')}
              noMatchText={t('common.noMatches')}
              data-testid={`amendment-change-item-${index}`}
            />
            {option ? (
              <>
                <TextField
                  label={t('contract.revisionBefore')}
                  value={option.currentText}
                  readOnly
                  hint={option.currentText ? undefined : t('contract.revisionBeforeEmpty')}
                />
                <RevisionValueField
                  label={t('contract.revisionAfter')}
                  type={option.type}
                  choices={option.choices}
                  searchable={option.searchable ?? false}
                  value={row.value}
                  onChange={(v) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: v } : r)))}
                  testId={`amendment-change-value-${index}`}
                />
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              data-testid={`amendment-change-remove-${index}`}
            >
              {t('contract.amendment.removeChangeCta')}
            </Button>
          </div>
        );
      })}

      <Button
        variant="secondary"
        size="sm"
        disabled={options.length === 0}
        onClick={() => setRows((prev) => [...prev, { key: nextRowKey(), ref: '', value: '' }])}
        data-testid="amendment-add-change"
      >
        {t('contract.amendment.addChangeCta')}
      </Button>

      {preview ? (
        <div data-testid="amendment-delta-preview">
          <Callout tone="info" title={t('contract.amendment.previewTitle')}>
            <p>{t('contract.amendment.previewAmount', { delta: preview })}</p>
          </Callout>
        </div>
      ) : null}

      <TextArea
        label={t('contract.amendment.customTermsLabel')}
        hint={t('contract.amendment.customTermsHint')}
        rows={3}
        value={customTerms}
        onChange={(e) => setCustomTerms(e.target.value)}
        data-testid="amendment-custom-terms"
      />

      {error ? (
        <div data-testid="amendment-form-error">
          <Callout tone="warn">{error}</Callout>
        </div>
      ) : null}
    </Modal>
  );
}
