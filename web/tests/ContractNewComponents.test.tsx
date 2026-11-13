import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaterialCatalogItem, MoneyLike, UnitOption } from '@porukam/core';
import { ru } from '@porukam/i18n';
import {
  ChecklistEditor,
  CurrencyField,
  MaterialsModal,
  PartyDetails,
  PaymentModal,
  StagesBuilder,
  UnitPicker,
  type ChecklistDraftItem,
  type ChecklistEditorLabels,
  type MaterialsModalDraftItem,
  type MaterialsModalLabels,
  type PartyDetailsMode,
  type PaymentModalLabels,
  type StagesBuilderLabels,
  type StagesBuilderValue,
} from '@porukam/ui';

const CATALOG: MaterialCatalogItem[] = [{ ref: 'other', title: 'Прочее' }];
const UNITS: UnitOption[] = [
  { code: 'pcs', label: 'шт', hint: 'напр. 4 шт' },
  { code: 'm2', label: 'м²', hint: 'напр. 12 м²' },
];

/** Тексты — из настоящего словаря (не выдуманные для теста), простая `{{key}}`-замена. */
const cn = ru.contractNew;
function fmt(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v)), template);
}

const checklistLabels: ChecklistEditorLabels = {
  addPlaceholder: cn.checklist.addPlaceholder,
  addLabel: cn.checklist.addLabel,
  requiredLabel: cn.checklist.requiredLabel,
  emptyWarning: cn.checklist.emptyWarning,
  deleteAria: cn.checklist.deleteAria,
};

const materialsLabels: MaterialsModalLabels = {
  title: cn.materials.title,
  cancel: cn.materials.cancel,
  done: cn.materials.done,
  nameLabel: cn.materials.nameLabel,
  otherOption: cn.materials.otherOption,
  customNameLabel: cn.materials.customNameLabel,
  customNamePlaceholder: cn.materials.customNamePlaceholder,
  customNameHint: cn.materials.customNameHint,
  searchNoMatch: cn.materials.searchNoMatch,
  quantityLabel: cn.materials.quantityLabel,
  quantityPlaceholder: cn.materials.quantityPlaceholder,
  unitLabel: cn.materials.unitLabel,
  unitChoose: cn.materials.unitChoose,
  nameRequired: cn.materials.nameRequired,
  deliveryLabel: cn.materials.deliveryLabel,
  deliveryPlaceholder: cn.materials.deliveryPlaceholder,
  deliveryBaseLabel: cn.materials.deliveryBaseLabel,
  deliveryBaseSigning: cn.materials.deliveryBaseSigning,
  deliveryBasePrepayment: cn.materials.deliveryBasePrepayment,
  deliveryBaseStageStart: cn.materials.deliveryBaseStageStart,
  suppliedByLabel: cn.materials.suppliedByLabel,
  suppliedByChoose: cn.materials.suppliedByChoose,
  suppliedByCustomer: cn.materials.suppliedByCustomer,
  suppliedByContractor: cn.materials.suppliedByContractor,
  suppliedByRequired: cn.materials.suppliedByRequired,
  priceLabel: cn.materials.priceLabel,
  pricePlaceholder: cn.materials.pricePlaceholder,
  priceRequired: cn.materials.priceRequired,
  addToList: cn.materials.addToList,
  saveItem: cn.materials.saveItem,
  cancelEdit: cn.materials.cancelEdit,
  editAria: cn.materials.editAria,
  deleteAria: cn.materials.deleteAria,
  formatDeliveryMeta: (days, base) => fmt(cn.materials.deliveryMeta, { days, base }),
  formatSuppliedByMeta: (name) => fmt(cn.materials.suppliedByMeta, { name }),
  unitPickerTitle: cn.unitPicker.title,
  closeLabel: ru.common.close,
};

const paymentModalLabels: PaymentModalLabels = {
  title: cn.paymentModal.title,
  cancel: cn.paymentModal.cancel,
  done: cn.paymentModal.done,
  amountRowLabel: cn.paymentModal.amountRowLabel,
  advanceLabel: cn.paymentModal.advanceLabel,
  advancePlaceholder: cn.paymentModal.advancePlaceholder,
  advancePercentLabel: cn.paymentModal.advancePercentLabel,
  advancePercentPlaceholder: cn.paymentModal.advancePercentPlaceholder,
  postLabel: cn.paymentModal.postLabel,
  disclaimer: cn.paymentModal.disclaimer,
  closeLabel: ru.common.close,
};

const stagesBuilderLabels: StagesBuilderLabels = {
  totalCostLabel: cn.stagesBuilder.totalCostLabel,
  totalCostHint: cn.stagesBuilder.totalCostHint,
  totalCostPlaceholder: cn.stagesBuilder.totalCostPlaceholder,
  addStage: cn.stagesBuilder.addStage,
  addSection: cn.stagesBuilder.addSection,
  newSectionTitle: cn.stagesBuilder.newSectionTitle,
  formatDeleteSectionConfirm: (count) => fmt(cn.stagesBuilder.deleteSectionConfirm, { count }),
  deleteStageConfirm: cn.stagesBuilder.deleteStageConfirm,
  deleteStageAria: cn.stagesBuilder.deleteStageAria,
  copyStageAria: cn.stagesBuilder.copyStageAria,
  saveStage: cn.stagesBuilder.saveStage,
  deleteSectionAria: cn.stagesBuilder.deleteSectionAria,
  autoLabel: cn.stagesBuilder.autoLabel,
  emptyAmountHint: cn.stagesBuilder.emptyAmountHint,
  totalRowLabel: cn.stagesBuilder.totalRowLabel,
  match: cn.stagesBuilder.match,
  formatMismatch: (diff, currency) => fmt(cn.stagesBuilder.mismatch, { diff, currency }),
  formatDurationNote: (days) => fmt(cn.stagesBuilder.durationNote, { days }),
  formatDuration: (days) => fmt(cn.stagesBuilder.durationSuffix, { days }),
  untitledStage: cn.stagesBuilder.newStageTitle,
  newStageTitle: cn.stagesBuilder.newStageTitle,
  stageSheetTitle: cn.stagesBuilder.genericStageName,
  closeLabel: ru.common.close,
  stageEditor: {
    titleLabel: cn.stageEditor.titleLabel,
    titlePlaceholder: cn.stageEditor.titlePlaceholder,
    amountLabel: cn.stageEditor.amountLabel,
    amountHint: cn.stageEditor.amountHint,
    amountPlaceholder: cn.stageEditor.amountPlaceholder,
    durationLabel: cn.stageEditor.durationLabel,
    durationPlaceholder: cn.stageEditor.durationPlaceholder,
    checklistSectionTitle: cn.stageEditor.checklistSectionTitle,
    materialsBtn: cn.stageEditor.materialsBtn,
    paymentBtn: cn.stageEditor.paymentBtn,
    formatAdvanceBtn: (amount) => fmt(cn.stageEditor.advanceBtn, { amount }),
    checklist: checklistLabels,
  },
  materialsModal: materialsLabels,
  paymentModal: paymentModalLabels,
};

// ── StagesBuilder (DEV-09 §4.2, §10) ──
function StagesBuilderHarness(): JSX.Element {
  const [value, setValue] = useState<StagesBuilderValue>({ sections: [], stages: [], totalCost: '' });
  return <StagesBuilder value={value} onChange={setValue} currency="RUB" catalog={CATALOG} units={UNITS} labels={stagesBuilderLabels} />;
}

describe('StagesBuilder (DEV-09 §4.2)', () => {
  it('авто-разнос поровну + остаток в последний этап; итог сходится', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);

    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('add-stage'));
    await user.type(screen.getByTestId('total-cost'), '100');

    const rows = screen.getAllByTestId('stage-row');
    expect(rows).toHaveLength(3);
    // 100 / 3 = 33.33, 33.33, 33.34 (остаток — в последний)
    expect(within(rows[0]!).getByText(/33,33/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/33,33/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/33,34/)).toBeInTheDocument();
    expect(screen.getByTestId('stages-sum')).toHaveTextContent('100.00 RUB');
    expect(screen.getByTestId('sum-match-badge')).toHaveTextContent('Сходится');
  });

  it('ручная правка суммы снимает «поровну» с этого этапа и перераспределяет остальные', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);

    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('add-stage'));
    await user.type(screen.getByTestId('total-cost'), '100');

    // Открываем первый этап и правим сумму вручную.
    const rows = screen.getAllByTestId('stage-open');
    await user.click(rows[0]!);
    const amountInput = await screen.findByTestId('stage-amount');
    await user.clear(amountInput);
    await user.type(amountInput, '20');

    // Второй (авто) этап должен забрать остаток: 100 − 20 = 80.
    expect(screen.getByTestId('stages-sum')).toHaveTextContent('100.00 RUB');
    expect(screen.getByTestId('sum-match-badge')).toHaveTextContent('Сходится');
  });

  it('срок договора = сумма сроков этапов', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-duration'), '5');
    // Закрываем шторку и открываем следующий этап тем же харнессом было бы сложнее —
    // проверяем срок первого этапа напрямую через агрегат в сводке после закрытия.
    expect(screen.getByTestId('stages-duration')).toHaveTextContent('5 дней');
  });
});

/** Решение владельца 05.09: мастер больше не ставит «нужно доказательство»
 * каждому пункту чек-листа этапа — требование включается вручную. */
describe('StagesBuilder — требование доказательства по умолчанию выключено', () => {
  it('пункт чек-листа этапа создаётся без требования, переключатель его включает', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('checklist-add-input'), 'Плитка уложена без пустот{enter}');

    const toggle = screen.getByTestId(/^checklist-evidence-/);
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(screen.getByTestId(/^checklist-evidence-/)).toBeChecked();
  });
});

describe('StagesBuilder — отсмотр 2026-08-20', () => {
  it('«Сохранить» в окне этапа закрывает окно, правки остаются', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-amount'), '150');
    await user.click(screen.getByTestId('stage-save'));
    expect(screen.queryByTestId('stage-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('stages-sum')).toHaveTextContent('150.00 RUB');
  });

  it('копирование этапа: копия сразу под оригиналом с той же суммой и чек-листом', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-amount'), '40');
    await user.type(screen.getByTestId('checklist-add-input'), 'плитка без пустот{enter}');
    await user.click(screen.getByTestId('stage-save'));

    await user.click(screen.getByTestId('stage-copy'));
    const rows = screen.getAllByTestId('stage-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText(/40/)).toBeInTheDocument();
    expect(screen.getByTestId('stages-sum')).toHaveTextContent('80.00 RUB');
    // У копии — свой чек-лист (тот же текст, новые id): открываем вторую строку.
    await user.click(screen.getAllByTestId('stage-open')[1]!);
    expect(await screen.findByText('плитка без пустот')).toBeInTheDocument();
  });

  it('десятичная запятая и пробелы в сумме не ломают итог (NaN)', async () => {
    const user = userEvent.setup();
    render(<StagesBuilderHarness />);
    await user.click(screen.getByTestId('add-stage'));
    await user.click(screen.getByTestId('stage-open'));
    await user.type(await screen.findByTestId('stage-amount'), '1 200,50');
    expect(screen.getByTestId('stages-sum')).toHaveTextContent('1200.50 RUB');
    expect(screen.getByTestId('stages-sum')).not.toHaveTextContent('NaN');
  });
});

// ── ChecklistEditor (DEV-09 §10) ──
describe('ChecklistEditor', () => {
  function Harness(): JSX.Element {
    // Новый пункт — БЕЗ требования доказательства (решение владельца 05.09);
    // предзаполненный оставлен с `true` — с ним видно включённый переключатель.
    const [items, setItems] = useState<ChecklistDraftItem[]>([{ id: '1', text: 'Готово', requiredEvidence: true }]);
    return (
      <ChecklistEditor
        items={items}
        onAdd={(text) => setItems((it) => [...it, { id: '2', text, requiredEvidence: false }])}
        onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
        onToggleEvidence={(id, requiredEvidence) => setItems((it) => it.map((x) => (x.id === id ? { ...x, requiredEvidence } : x)))}
        labels={checklistLabels}
      />
    );
  }

  it('предзаполнение видно, × удаляет пункт', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('Готово')).toBeInTheDocument();
    await user.click(screen.getByTestId('checklist-remove-1'));
    expect(screen.queryByText('Готово')).not.toBeInTheDocument();
  });

  it('добавление нового пункта', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('checklist-add-input'), 'Новый критерий');
    await user.click(screen.getByTestId('checklist-add-submit'));
    expect(screen.getByText('Новый критерий')).toBeInTheDocument();
  });

  /** Решение владельца 05.09: требование доказательства больше НЕ ставится
   * каждому новому пункту (ADR-164 — это рекомендация, не гейт приёмки);
   * включить его можно переключателем на строке пункта. */
  it('новый пункт — без требования доказательства, переключатель его включает', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Предзаполненный пункт пришёл с включённым признаком — переключатель отмечен.
    expect(screen.getByTestId('checklist-evidence-1')).toBeChecked();

    await user.type(screen.getByTestId('checklist-add-input'), 'Новый критерий{enter}');
    const added = screen.getByTestId('checklist-evidence-2');
    expect(added).not.toBeChecked();

    await user.click(added);
    expect(screen.getByTestId('checklist-evidence-2')).toBeChecked();

    // И обратно — требование снимается.
    await user.click(screen.getByTestId('checklist-evidence-2'));
    expect(screen.getByTestId('checklist-evidence-2')).not.toBeChecked();
  });

  it('без onToggleEvidence признак остаётся бейджем только для чтения', () => {
    render(
      <ChecklistEditor
        items={[{ id: '1', text: 'Готово', requiredEvidence: true }]}
        onAdd={() => {}}
        onDelete={() => {}}
        labels={checklistLabels}
      />,
    );
    expect(screen.queryByTestId('checklist-evidence-1')).not.toBeInTheDocument();
    expect(screen.getByText(cn.checklist.requiredLabel)).toBeInTheDocument();
  });
});

// ── MaterialsModal (DEV-09 §4.3, §10) ──
describe('MaterialsModal', () => {
  function Harness(): JSX.Element {
    const [items, setItems] = useState<MaterialsModalDraftItem[]>([]);
    const onDone = vi.fn();
    return (
      <MaterialsModal
        open
        onClose={() => {}}
        catalog={CATALOG}
        units={UNITS}
        currency="RUB"
        items={items}
        onAdd={(m) => setItems((it) => [...it, { ...m, id: String(it.length + 1) }])}
        onUpdate={(id, m) => setItems((it) => it.map((x) => (x.id === id ? { ...m, id } : x)))}
        onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
        onDone={onDone}
        labels={materialsLabels}
      />
    );
  }

  it('«+ Добавить в список» добавляет позицию, не закрывая окно', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // catalog содержит только «Прочее» → показывается поле произвольного названия
    await user.type(screen.getByLabelText(/Название материала/), 'Уголок');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.click(screen.getByTestId('material-add'));
    expect(screen.getByTestId('materials-list')).toBeInTheDocument();
    expect(screen.getByText('Уголок')).toBeInTheDocument();
    // Окно не закрылось — форма всё ещё на месте.
    expect(screen.getByTestId('material-add')).toBeInTheDocument();
  });

  it('× удаляет добавленную позицию', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText(/Название материала/), 'Уголок');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.click(screen.getByTestId('material-add'));
    const removeBtn = screen.getAllByLabelText('Удалить материал')[0]!;
    await user.click(removeBtn);
    expect(screen.queryByText('Уголок')).not.toBeInTheDocument();
  });
});

// ── UnitPicker ──
describe('UnitPicker', () => {
  it('выбор единицы вызывает onPick и закрывает окно', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<UnitPicker open onClose={onClose} units={UNITS} onPick={onPick} title={cn.unitPicker.title} closeLabel={ru.common.close} />);
    expect(screen.getByText('напр. 12 м²')).toBeInTheDocument();
    await user.click(screen.getByTestId('unit-m2'));
    expect(onPick).toHaveBeenCalledWith(UNITS[1]);
    expect(onClose).toHaveBeenCalled();
  });
});

// ── PaymentModal (DEV-09 §4.4, §10) ──
// onClose нарочно инлайновый (новая identity на каждый ре-рендер Harness, который
// перерендеривается на каждый кейстрок через onChange) — так тест ловит регресс
// «фокус теряется посреди печати» (Sheet.tsx: фокус зависит только от `open`, не от `onClose`).
describe('PaymentModal — авто-пересчёт аванса', () => {
  function Harness(): JSX.Element {
    const [advance, setAdvance] = useState<MoneyLike | null>(null);
    const [percent, setPercent] = useState<number | null>(null);
    return (
      <PaymentModal
        open
        onClose={() => {}}
        amount={{ amount: '20000.00', currency: 'RUB' }}
        advance={advance}
        advancePercent={percent}
        onChange={(a, p) => {
          setAdvance(a);
          setPercent(p);
        }}
        onDone={() => {}}
        labels={paymentModalLabels}
      />
    );
  }

  it('ввод процента → сумма аванса и «после приёмки» пересчитываются', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('advance-percent'), '30');
    expect(screen.getByTestId('advance-amount')).toHaveValue('6000.00');
    expect(screen.getByTestId('post-amount')).toHaveTextContent('14');
  });

  it('ввод суммы → процент пересчитывается', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('advance-amount'), '5000');
    expect(screen.getByTestId('advance-percent')).toHaveValue('25');
  });
});

// ── PartyDetails (DEV-09 §5, §10) — опционально, без валидации, данные только в props ──
describe('PartyDetails', () => {
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<PartyDetailsMode>('personal');
    const [fields, setFields] = useState<Record<string, string>>({});
    return (
      <PartyDetails
        open={open}
        onToggleOpen={setOpen}
        mode={mode}
        onModeChange={setMode}
        fields={fields}
        onFieldChange={(k, v) => setFields((f) => ({ ...f, [k]: v }))}
        title={cn.partyDetailsTitle}
        addLabel={cn.partyDetailsAdd}
        collapseLabel={cn.partyDetailsCollapse}
        personalLabel={cn.partyDetailsPersonal}
        businessLabel={cn.partyDetailsBusiness}
        hint={cn.partyDetailsHint}
        fieldLabels={cn.partyFields}
      />
    );
  }

  it('свёрнуто по умолчанию, открывается по клику, поля принимают произвольный текст без валидации', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId('party-details')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('party-details-open'));
    expect(screen.getByTestId('party-details')).toBeInTheDocument();
    const nameField = screen.getByLabelText('Полное имя');
    await user.type(nameField, '###не формат@@@');
    expect(nameField).toHaveValue('###не формат@@@');
  });
});

// ── CurrencyField ──
describe('CurrencyField', () => {
  it('выбор валюты из списка вызывает onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CurrencyField value="RUB" options={['RUB', 'USD', 'EUR']} onChange={onChange} label={cn.currencyLabel} />);
    await user.selectOptions(screen.getByLabelText('Валюта договора'), 'USD');
    expect(onChange).toHaveBeenCalledWith('USD');
  });
});

// ── ChecklistEditor: число пунктов не ограничено (отсмотр 2026-08-25) ──
describe('ChecklistEditor — без лимита на число пунктов', () => {
  function UnlimitedHarness(): JSX.Element {
    const [items, setItems] = useState<ChecklistDraftItem[]>([]);
    return (
      <ChecklistEditor
        items={items}
        onAdd={(text) => setItems((it) => [...it, { id: `cl-${it.length + 1}`, text, requiredEvidence: false }])}
        onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
        labels={checklistLabels}
      />
    );
  }

  it('подряд добавляются несколько пунктов, все остаются в списке', async () => {
    const user = userEvent.setup();
    render(<UnlimitedHarness />);
    const texts = ['Критерий 1', 'Критерий 2', 'Критерий 3', 'Критерий 4', 'Критерий 5'];
    for (const text of texts) {
      await user.type(screen.getByTestId('checklist-add-input'), `${text}{enter}`);
    }
    for (const text of texts) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^checklist-remove-/)).toHaveLength(5);
    expect(screen.getByTestId('checklist-add-input')).toHaveValue('');
  });
});
