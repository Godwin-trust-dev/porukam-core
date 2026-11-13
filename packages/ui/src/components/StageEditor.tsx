import { formatMoney } from '@porukam/core';
import { Button } from './Button';
import { ChecklistEditor, type ChecklistDraftItem, type ChecklistEditorLabels } from './ChecklistEditor';
import { FieldHelp } from './FieldHelp';
import { Icon } from './Icon';
import { TextField } from './Field';
import type { MaterialsModalDraftItem } from './MaterialsModal';
import styles from './StageEditor.module.css';

export interface StageEditorValue {
  title: string;
  amount: string;
  durationDays: string;
  checklist: ChecklistDraftItem[];
  materials: MaterialsModalDraftItem[];
  advance: { amount: string; currency: string } | null;
  advancePercent: number | null;
}

export interface StageEditorLabels {
  titleLabel: string;
  titlePlaceholder: string;
  amountLabel: string;
  amountHint: string;
  amountPlaceholder: string;
  durationLabel: string;
  durationPlaceholder: string;
  checklistSectionTitle: string;
  /** Подсказки «?» у полей этапа (отсмотр 22.08) — необязательные. */
  titleHelp?: string;
  amountHelp?: string;
  durationHelp?: string;
  checklistHelp?: string;
  /** Доступное имя кнопки «?». */
  helpLabel?: string;
  materialsBtn: string;
  paymentBtn: string;
  /** Шаблон с `{{amount}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatAdvanceBtn: (amount: string) => string;
  checklist: ChecklistEditorLabels;
}

export interface StageEditorProps {
  stage: StageEditorValue;
  currency: string;
  onTitleChange: (title: string) => void;
  onAmountChange: (amount: string) => void;
  onDurationChange: (days: string) => void;
  onAddChecklist: (text: string) => void;
  onDeleteChecklist: (id: string) => void;
  /** Переключить «нужно доказательство» у пункта чек-листа (решение владельца
   * 05.09: новый пункт — без требования). Не передан — признак только читается. */
  onToggleChecklistEvidence?: (id: string, requiredEvidence: boolean) => void;
  onOpenMaterials: () => void;
  onOpenPayment: () => void;
  labels: StageEditorLabels;
  /** ADR-088 Фаза 2: у реального Milestone нет длительности/материалов/аванса —
   * мастер на реальном API скрывает эти элементы («не показываем то, чего нет»). */
  showDuration?: boolean;
  showMaterials?: boolean;
  showPayment?: boolean;
  /** false — чек-лист этапа в мастере не правится (этап уже создан на сервере,
   * PATCH/DELETE пунктов нет — ADR-088 Фаза 2; пункты видны на странице этапа). */
  showChecklist?: boolean;
  /** Рекомендации критериев по типу работ — кликабельный список в ChecklistEditor. */
  checklistSuggestions?: string[];
}

/** Редактор этапа (DEV-09 §4.2): сумма-подсказка, срок в днях, чек-лист, кнопки окон. */
export function StageEditor({
  stage,
  currency,
  onTitleChange,
  onAmountChange,
  onDurationChange,
  onAddChecklist,
  onDeleteChecklist,
  onToggleChecklistEvidence,
  onOpenMaterials,
  onOpenPayment,
  labels: l,
  showDuration = true,
  showMaterials = true,
  showPayment = true,
  showChecklist = true,
  checklistSuggestions,
}: StageEditorProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="stage-editor">
      <TextField
        label={l.titleLabel}
        help={l.titleHelp}
        helpLabel={l.helpLabel}
        placeholder={l.titlePlaceholder}
        value={stage.title}
        onChange={(e) => onTitleChange(e.target.value)}
      />
      <div className={styles.row2}>
        <TextField
          label={l.amountLabel}
          hint={l.amountHint}
          help={l.amountHelp}
          helpLabel={l.helpLabel}
          placeholder={l.amountPlaceholder}
          inputMode="decimal"
          value={stage.amount}
          onChange={(e) => onAmountChange(e.target.value)}
          data-testid="stage-amount"
        />
        {showDuration ? (
          <TextField
            label={l.durationLabel}
            help={l.durationHelp}
            helpLabel={l.helpLabel}
            placeholder={l.durationPlaceholder}
            inputMode="numeric"
            value={stage.durationDays}
            onChange={(e) => onDurationChange(e.target.value)}
            data-testid="stage-duration"
          />
        ) : null}
      </div>

      {showChecklist ? (
        <div className={styles.section}>
          <p className={styles.sectionTitle}>
            {l.checklistSectionTitle}
            {/* Подписи у поля ввода критерия нет (комбобокс с плейсхолдером) —
                его подсказка про доказательства идёт вторым абзацем ЗДЕСЬ, в
                строке подписи раздела, а не отдельным «?» над полем. */}
            {l.checklistHelp || l.checklist.addHelp ? (
              <FieldHelp label={l.helpLabel}>
                {l.checklistHelp}
                {l.checklist.addHelp ? <span className={styles.helpPara}>{l.checklist.addHelp}</span> : null}
              </FieldHelp>
            ) : null}
          </p>
          <ChecklistEditor
            items={stage.checklist}
            onAdd={onAddChecklist}
            onDelete={onDeleteChecklist}
            {...(onToggleChecklistEvidence ? { onToggleEvidence: onToggleChecklistEvidence } : {})}
            labels={l.checklist}
            suggestions={checklistSuggestions}
          />
        </div>
      ) : null}

      {showMaterials || showPayment ? (
        <div className={styles.buttons}>
          {showMaterials ? (
            <Button variant="secondary" onClick={onOpenMaterials} data-testid="open-materials">
              <Icon name="wallet" size={16} /> {l.materialsBtn}{stage.materials.length ? ` (${stage.materials.length})` : ''}
            </Button>
          ) : null}
          {showPayment ? (
            <Button variant="secondary" onClick={onOpenPayment} data-testid="open-payment">
              <Icon name="receipt" size={16} />{' '}
              {stage.advance ? l.formatAdvanceBtn(formatMoney({ amount: stage.advance.amount, currency })) : l.paymentBtn}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
