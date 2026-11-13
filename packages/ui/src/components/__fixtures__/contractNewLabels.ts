/**
 * Витрины Storybook для DEV-09 читают тексты из настоящего словаря `@porukam/i18n`
 * (не дублируют строки) — так витрина не расходится с приложением. Только для
 * `*.stories.tsx`; рантайм-код компонентов сюда не заглядывает (тексты — через props).
 */
import { ru } from '@porukam/i18n';
import type { ChecklistEditorLabels } from '../ChecklistEditor';
import type { MaterialsModalLabels } from '../MaterialsModal';
import type { PaymentModalLabels } from '../PaymentModal';
import type { StageEditorLabels } from '../StageEditor';
import type { StagesBuilderLabels } from '../StagesBuilder';
import type { TypeFormLabels } from '../TypeForm';
import type { PartyDetailsFieldLabels } from '../PartyDetails';

const cn = ru.contractNew;

/** Простая замена `{{key}}` — эквивалент i18next-интерполяции для витрин. */
function fmt(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v)), template);
}

export const checklistEditorLabels: ChecklistEditorLabels = {
  addPlaceholder: cn.checklist.addPlaceholder,
  addLabel: cn.checklist.addLabel,
  requiredLabel: cn.checklist.requiredLabel,
  emptyWarning: cn.checklist.emptyWarning,
  deleteAria: cn.checklist.deleteAria,
  suggestionsTitle: cn.checklist.suggestionsTitle,
  suggestionAddAria: cn.checklist.suggestionAddAria,
  formatShowAll: (count) => fmt(cn.checklist.showAll, { count }),
  showLess: cn.checklist.showLess,
  noMatchHint: cn.checklist.noMatchHint,
};

export const unitPickerFixtureLabels = { title: cn.unitPicker.title, closeLabel: ru.common.close };

export const materialsModalLabels: MaterialsModalLabels = {
  title: cn.materials.title,
  cancel: cn.materials.cancel,
  done: cn.materials.done,
  nameLabel: cn.materials.nameLabel,
  otherOption: cn.materials.otherOption,
  customNameLabel: cn.materials.customNameLabel,
  customNamePlaceholder: cn.materials.customNamePlaceholder,
  customNameHint: cn.materials.customNameHint,
  quantityLabel: cn.materials.quantityLabel,
  quantityPlaceholder: cn.materials.quantityPlaceholder,
  unitLabel: cn.materials.unitLabel,
  unitChoose: cn.materials.unitChoose,
  nameRequired: cn.materials.nameRequired,
  searchNoMatch: fmt(cn.materials.searchNoMatch, { other: cn.materials.otherOption }),
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

export const paymentModalLabels: PaymentModalLabels = {
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

export const stageEditorLabels: StageEditorLabels = {
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
  checklist: checklistEditorLabels,
};

export const stagesBuilderLabels: StagesBuilderLabels = {
  totalCostLabel: cn.stagesBuilder.totalCostLabel,
  totalCostHint: cn.stagesBuilder.totalCostHint,
  totalCostPlaceholder: cn.stagesBuilder.totalCostPlaceholder,
  addStage: cn.stagesBuilder.addStage,
  addSection: cn.stagesBuilder.addSection,
  newSectionTitle: cn.stagesBuilder.newSectionTitle,
  formatDeleteSectionConfirm: (count) => fmt(cn.stagesBuilder.deleteSectionConfirm, { count }),
  deleteStageConfirm: cn.stagesBuilder.deleteStageConfirm,
  deleteStageAria: cn.stagesBuilder.deleteStageAria,
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
  stageEditor: stageEditorLabels,
  materialsModal: materialsModalLabels,
  paymentModal: paymentModalLabels,
};

export const typeFormLabels: TypeFormLabels = {
  service: cn.typeForm.service,
  sale: {
    ...cn.typeForm.sale,
    formatCategoryNote: (category) => fmt(cn.typeForm.sale.categoryNote, { category }),
  },
  rent: cn.typeForm.rent,
  loan: {
    ...cn.typeForm.loan,
    formatRatePerYear: (rate) => fmt(cn.typeForm.loan.ratePerYear, { rate }),
  },
};

export const partyFieldLabels: PartyDetailsFieldLabels = cn.partyFields;

export const identityCardFixtureLabels = {
  providerLabel: cn.identityProvider,
  verifiedLabel: cn.identityVerified,
  accountHint: cn.identityAccountHint,
  escalationHint: cn.identityEscalationHint,
};

export const spherePickerFixtureLabels = {
  searchLabel: cn.sphereSearchLabel,
  searchPlaceholder: cn.sphereSearchPlaceholder,
  popularLabel: cn.spherePopular,
  browseAllLabel: cn.sphereBrowseAll,
  emptyHint: cn.sphereEmptyHint,
};

export const typePickerFixtureLabels = { notYetSupportedLabel: cn.notYetSupported, ariaLabel: cn.typeAriaLabel };

export const partiesStepFixtureLabels = {
  roleLabel: cn.roleLabel,
  roleCustomerLabel: cn.roleCustomer,
  roleContractorLabel: cn.roleContractor,
  counterpartyLabel: cn.counterpartyLabel,
  counterpartySearchPlaceholder: cn.counterpartySearch,
  inviteLabel: cn.inviteCta,
  inviteHint: cn.inviteHint,
  businessLabel: cn.businessLabel,
  personLabel: cn.personLabel,
};

export const partyDetailsFixtureLabels = {
  title: cn.partyDetailsTitle,
  addLabel: cn.partyDetailsAdd,
  collapseLabel: cn.partyDetailsCollapse,
  personalLabel: cn.partyDetailsPersonal,
  businessLabel: cn.partyDetailsBusiness,
  hint: cn.partyDetailsHint,
  fieldLabels: partyFieldLabels,
};

export const previewStepFixtureLabels = {
  sendLabel: cn.send,
  untitledLabel: cn.untitled,
  stagesSectionTitle: cn.stagesSectionTitle,
  sumLabel: cn.sumLabel,
  durationLabel: cn.durationLabel,
  formatDuration: (days: number) => fmt(cn.formatDurationDays, { days }),
  beforeSendTitle: cn.beforeSendTitle,
};

export const closeLabel = ru.common.close;
export const currencyFieldLabel = cn.currencyLabel;
