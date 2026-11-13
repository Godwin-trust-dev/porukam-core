import './styles/tokens.css';
import './styles/fonts.css';

export { Button } from './components/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './components/Button';
export { Icon } from './components/Icon';
export type { IconProps, IconSize } from './components/Icon';
export { ICON_NAMES } from './icons/paths';
export type { IconName } from './icons/paths';
export { TextField, TextArea, SelectField, OtpField, MoneyField } from './components/Field';
export { FieldHelp } from './components/FieldHelp';
export type { FieldHelpProps } from './components/FieldHelp';
export type {
  TextFieldProps,
  TextAreaProps,
  SelectFieldProps,
  OtpFieldProps,
  MoneyFieldProps,
} from './components/Field';
export { Card, ContractCard } from './components/Card';
export type { CardProps, ContractCardProps } from './components/Card';
export { Badge } from './components/Badge';
export type { BadgeProps, BadgeTone } from './components/Badge';
export {
  Skeleton,
  ContractCardSkeleton,
  EmptyState,
  ErrorState,
} from './components/States';
export type { SkeletonProps, EmptyStateProps, ErrorStateProps } from './components/States';
export { Spark } from './components/Spark';
export type { SparkProps } from './components/Spark';
export { Logo } from './components/Logo';
export type { LogoProps } from './components/Logo';
export { Modal } from './components/Modal';
export type { ModalProps } from './components/Modal';
export { Callout } from './components/Callout';
export { LtrText } from './components/LtrText';
export type { LtrTextProps } from './components/LtrText';
export { Tooltip } from './components/Tooltip';
export type { TooltipProps } from './components/Tooltip';
export { LocaleRow } from './components/LocaleRow';
export type { LocaleRowProps } from './components/LocaleRow';
export { LocaleList } from './components/LocaleList';
export type { LocaleListProps } from './components/LocaleList';
export { LanguageSwitcher } from './components/LanguageSwitcher';
export type { LanguageSwitcherProps, LanguageSwitcherVariant } from './components/LanguageSwitcher';
export type { CalloutProps, CalloutTone } from './components/Callout';
export { MoneyBreakdown } from './components/MoneyBreakdown';
export type { MoneyBreakdownProps, BreakdownRow } from './components/MoneyBreakdown';
export { Stepper } from './components/Stepper';
export type { StepperProps } from './components/Stepper';
export { PassportHeader } from './components/PassportHeader';
export type { PassportHeaderProps, PassportSurface, PassportVerification } from './components/PassportHeader';
export { RoleSwitch } from './components/RoleSwitch';
export type { RoleSwitchProps, ReputationRoleValue } from './components/RoleSwitch';
export { TrustNumber } from './components/TrustNumber';
export type { TrustNumberProps } from './components/TrustNumber';
export { SphereRow } from './components/SphereRow';
export type { SphereRowProps } from './components/SphereRow';
// ADR-163: правило цветовых зон (0–33 / 33–66 / 66–100) живёт в ОДНОМ
// месте — сервер зон не считает и не отдаёт.
export { ZoneBar, zoneOf, percentOf, AMBER_FROM, GREEN_FROM } from './components/ZoneBar';
export type { ZoneBarProps, Zone, CountRatioProp } from './components/ZoneBar';
export { PortfolioTile } from './components/PortfolioTile';
export type { PortfolioTileProps, PortfolioTileStatus } from './components/PortfolioTile';
export { CommunityPill } from './components/CommunityPill';
export type { CommunityPillProps } from './components/CommunityPill';
export { PhotoViewer } from './components/PhotoViewer';
export type { PhotoViewerProps } from './components/PhotoViewer';
export { ActorSwitcher } from './components/ActorSwitcher';
export type { ActorSwitcherProps, ActorSwitcherPersonal, ActorSwitcherOrg } from './components/ActorSwitcher';
export { VerificationLevel } from './components/VerificationLevel';
export type { VerificationLevelProps } from './components/VerificationLevel';
export { NextStepSlot } from './components/NextStepSlot';
export type { NextStepSlotProps, NextStepSlotVariant } from './components/NextStepSlot';
export { StatTile } from './components/StatTile';
export type { StatTileProps } from './components/StatTile';
export { NotificationItem } from './components/NotificationItem';
export type { NotificationItemProps } from './components/NotificationItem';
export { PushPromo } from './components/PushPromo';
export type { PushPromoProps } from './components/PushPromo';
export { SettingsNav } from './components/SettingsNav';
export type { SettingsNavProps, SettingsNavItem } from './components/SettingsNav';
export { SettingRow } from './components/SettingRow';
export type { SettingRowProps, SettingRowControl, SettingRowOption } from './components/SettingRow';
export { Toggle } from './components/Toggle';
export type { ToggleProps } from './components/Toggle';
export { AttentionCard } from './components/AttentionCard';
export type {
  AttentionCardProps,
  AttentionSide,
  AttentionUrgency,
  AttentionUrgencyKind,
  AttentionAction,
  AttentionInfo,
} from './components/AttentionCard';
export { ContractRow } from './components/ContractRow';
export type { ContractRowProps, ContractRowPayment, ContractRowProgress } from './components/ContractRow';
export { PeriodFilter } from './components/PeriodFilter';
export type { PeriodFilterProps, PeriodFilterValue } from './components/PeriodFilter';
export { MoneyPanel } from './components/MoneyPanel';
export type { MoneyPanelProps, MoneyPanelRole } from './components/MoneyPanel';
export { ActivityFeed } from './components/ActivityFeed';
export type { ActivityFeedProps, ActivityFeedItem } from './components/ActivityFeed';
export { EvidenceStorageCard } from './components/EvidenceStorageCard';
export type { EvidenceStorageCardProps } from './components/EvidenceStorageCard';
export { AcceptanceTimer } from './components/AcceptanceTimer';
export type { AcceptanceTimerProps } from './components/AcceptanceTimer';
export { EvidenceFiles } from './components/EvidenceFiles';
export type { EvidenceFilesProps, EvidenceFile, EvidenceFileKind } from './components/EvidenceFiles';
export { ChecklistAcceptItem } from './components/ChecklistAcceptItem';
export type { ChecklistAcceptItemProps, ChecklistDecision } from './components/ChecklistAcceptItem';
export { Ceremony } from './components/Ceremony';
export type { CeremonyProps, CeremonyFact } from './components/Ceremony';
export { WaitingSubmission } from './components/WaitingSubmission';
export type { WaitingSubmissionProps } from './components/WaitingSubmission';
export { AiSummaryCard } from './components/AiSummaryCard';
export type { AiSummaryCardProps, AiSummaryCardItem } from './components/AiSummaryCard';
export { FrozenVersion } from './components/FrozenVersion';
export type { FrozenVersionProps, FrozenVersionLinks } from './components/FrozenVersion';
export { AutoTranslateBadge } from './components/AutoTranslateBadge';
export type { AutoTranslateBadgeProps } from './components/AutoTranslateBadge';
// ── feat/l10n-launch-surfaces · юр-документы платформы на языке пользователя ──
export { MarkdownDocument } from './components/MarkdownDocument';
export type { MarkdownDocumentProps } from './components/MarkdownDocument';
export { MachineTranslationMark } from './components/MachineTranslationMark';
export type { MachineTranslationMarkProps } from './components/MachineTranslationMark';
export { LegalDocumentSheet } from './components/LegalDocumentSheet';
export type { LegalDocumentSheetProps } from './components/LegalDocumentSheet';
export { OfficialTextLine } from './components/OfficialTextLine';
export type { OfficialTextLineProps } from './components/OfficialTextLine';
export { CompareColumns } from './components/CompareColumns';
export type { CompareColumnsProps } from './components/CompareColumns';
export { OfficialTextView } from './components/OfficialTextView';
export type { OfficialTextViewProps } from './components/OfficialTextView';
export { CustomTermsBlock } from './components/CustomTermsBlock';
export type { CustomTermsBlockProps } from './components/CustomTermsBlock';
export { SignResult } from './components/SignResult';
export type { SignResultProps } from './components/SignResult';
export { useIsDesktop } from './useIsDesktop';
export { PaymentPolicyLine } from './components/PaymentPolicyLine';
export type { PaymentPolicyLineProps } from './components/PaymentPolicyLine';
export { CommissionSection } from './components/CommissionSection';
export type { CommissionSectionProps } from './components/CommissionSection';
export { SignatureRow } from './components/SignatureRow';
export type { SignatureRowProps, SignatureRowState } from './components/SignatureRow';
export { EditContractLink } from './components/EditContractLink';
export type { EditContractLinkProps } from './components/EditContractLink';
export { FeePaymentSbp } from './components/FeePaymentSbp';
export type { FeePaymentSbpProps } from './components/FeePaymentSbp';
export { ContractHeader } from './components/ContractHeader';
export type { ContractHeaderProps } from './components/ContractHeader';
export { ContractStatus } from './components/ContractStatus';
export type { ContractStatusProps } from './components/ContractStatus';
export { StageTree } from './components/StageTree';
export type { StageTreeProps, StageTreeItem } from './components/StageTree';
export { StageMaterials } from './components/StageMaterials';
export type { StageMaterialsProps, StageMaterialItem } from './components/StageMaterials';
export { PaymentPlan } from './components/PaymentPlan';
export type { PaymentPlanProps, PaymentPlanRow, PaymentPlanRowState } from './components/PaymentPlan';
export { ContractTimeline } from './components/ContractTimeline';
export type { ContractTimelineProps, ContractTimelineItem } from './components/ContractTimeline';
export { AmendmentsBlock } from './components/AmendmentsBlock';
export type { AmendmentsBlockProps, AmendmentItem } from './components/AmendmentsBlock';
export { PartyRow } from './components/PartyRow';
export type { PartyRowProps, PartyRowState } from './components/PartyRow';
export { PaymentBreakdown } from './components/PaymentBreakdown';
export type { PaymentBreakdownProps } from './components/PaymentBreakdown';
export { PaymentMethodPicker } from './components/PaymentMethodPicker';
export type { PaymentMethodPickerProps, PaymentMethodChoice } from './components/PaymentMethodPicker';
export { SbpPay } from './components/SbpPay';
export type { SbpPayProps, SbpPayStatus } from './components/SbpPay';
export { CashConfirm } from './components/CashConfirm';
export type { CashConfirmProps, CashConfirmParty } from './components/CashConfirm';
export { PaymentResult } from './components/PaymentResult';
export type { PaymentResultProps, PaymentResultState } from './components/PaymentResult';
export { PayoutGate } from './components/PayoutGate';
export type { PayoutGateProps } from './components/PayoutGate';

// ── DEV-09 · Мастер создания договора + конструктор «Этапы» ──
export { Sheet } from './components/Sheet';
export type { SheetProps } from './components/Sheet';
export { ContactPickerSheet } from './components/ContactPickerSheet';
export type { ContactPickerSheetProps, ContactPickerEntry } from './components/ContactPickerSheet';
export { CurrencyField } from './components/CurrencyField';
export type { CurrencyFieldProps } from './components/CurrencyField';
export { TypePicker } from './components/TypePicker';
export type { TypePickerProps, TypePickerTile } from './components/TypePicker';
export { SpherePicker } from './components/SpherePicker';
export type { SpherePickerProps } from './components/SpherePicker';
export { IdentityCard } from './components/IdentityCard';
export type { IdentityCardProps } from './components/IdentityCard';
export { PartyDetails } from './components/PartyDetails';
export type { PartyDetailsProps, PartyDetailsMode, PartyDetailsFieldLabels } from './components/PartyDetails';
export { PartiesStep } from './components/PartiesStep';
export type { PartiesStepProps, PartiesStepCounterparty } from './components/PartiesStep';
export { TypeForm } from './components/TypeForm';
export type {
  TypeFormProps,
  TypeFormLabels,
  TypeFormServiceLabels,
  TypeFormSaleLabels,
  TypeFormRentLabels,
  TypeFormLoanLabels,
} from './components/TypeForm';
export { StagesBuilder, normalizeAmountInput } from './components/StagesBuilder';
export type { StagesBuilderProps, StagesBuilderValue, StagesBuilderLabels, SectionDraft, StageDraft } from './components/StagesBuilder';
export { StageRow } from './components/StageRow';
export type { StageRowProps } from './components/StageRow';
export { SectionHeader } from './components/SectionHeader';
export type { SectionHeaderProps } from './components/SectionHeader';
export { StageEditor } from './components/StageEditor';
export type { StageEditorProps, StageEditorValue, StageEditorLabels } from './components/StageEditor';
export { SearchSelect } from './components/SearchSelect';
export type { SearchSelectProps, SearchSelectOption } from './components/SearchSelect';
export { ChecklistEditor } from './components/ChecklistEditor';
export type { ChecklistEditorProps, ChecklistDraftItem, ChecklistEditorLabels } from './components/ChecklistEditor';
export { MaterialsModal } from './components/MaterialsModal';
export type {
  MaterialsModalProps,
  MaterialsModalDraftItem,
  MaterialsModalLabels,
  MaterialSuppliedBy,
  MaterialDeliveryBase,
} from './components/MaterialsModal';
export { UnitPicker } from './components/UnitPicker';
export type { UnitPickerProps } from './components/UnitPicker';
export { PaymentModal } from './components/PaymentModal';
export type { PaymentModalProps, PaymentModalLabels } from './components/PaymentModal';
export { PreviewStep } from './components/PreviewStep';
export type { PreviewStepProps, PreviewPartyRow, PreviewTermRow } from './components/PreviewStep';

// ── DEV-auth-onboarding · GLOBAL У1 (вход через Google + онбординг) ──
export { Checkbox } from './components/Checkbox';
export type { CheckboxProps } from './components/Checkbox';
export { RadioGroup } from './components/RadioGroup';
export type { RadioGroupProps, RadioGroupOption } from './components/RadioGroup';
export { GoogleButton } from './components/GoogleButton';
export type { GoogleButtonProps } from './components/GoogleButton';
export { InviteBanner } from './components/InviteBanner';
export type { InviteBannerProps } from './components/InviteBanner';
export { CookieBanner } from './components/CookieBanner';
export type { CookieBannerProps } from './components/CookieBanner';
export { ConsentAgree } from './components/ConsentAgree';
export type { ConsentAgreeProps } from './components/ConsentAgree';
export { VisibilityChoice } from './components/VisibilityChoice';
export type { VisibilityChoiceProps, ProfileVisibilityValue } from './components/VisibilityChoice';
export { HandleField } from './components/HandleField';
export type { HandleFieldProps, HandleFieldStatus } from './components/HandleField';
export { ProfileAvatar } from './components/ProfileAvatar';
export type { ProfileAvatarProps } from './components/ProfileAvatar';
export { BackupOption } from './components/BackupOption';
export type { BackupOptionProps } from './components/BackupOption';
export { OnboardingDone } from './components/OnboardingDone';
export type { OnboardingDoneProps } from './components/OnboardingDone';
export { FreshProfileCard } from './components/FreshProfileCard';
export type { FreshProfileCardProps } from './components/FreshProfileCard';

// ── DEV-10 · Согласование — протокол разногласий ──
export { VariantPicker } from './components/VariantPicker';
export type { VariantPickerProps, VariantPickerOption } from './components/VariantPicker';
export { RevisionCard } from './components/RevisionCard';
export type { RevisionCardProps } from './components/RevisionCard';
export { ProposeSheet } from './components/ProposeSheet';
export type { RevisionSheetProps, RevisionSheetSubmitInput, RevisionSheetVariantInput } from './components/ProposeSheet';
export { CounterSheet } from './components/CounterSheet';
export type { CounterSheetProps } from './components/CounterSheet';
export { RejectSheet } from './components/RejectSheet';
export type { RejectSheetProps } from './components/RejectSheet';
export { PreapprovedBlock } from './components/PreapprovedBlock';
export type { PreapprovedBlockProps, PreapprovedBlockItem } from './components/PreapprovedBlock';
export { DisputesPanel } from './components/DisputesPanel';
export type { DisputesPanelProps, DisputesPanelItem } from './components/DisputesPanel';
export { AcceptAllModal } from './components/AcceptAllModal';
export type { AcceptAllModalProps, AcceptAllChange } from './components/AcceptAllModal';
export { FreezeCta } from './components/FreezeCta';
export type { FreezeCtaProps } from './components/FreezeCta';
export { ReviewHeader } from './components/ReviewHeader';
export type { ReviewHeaderProps } from './components/ReviewHeader';
export { ReviewDocument } from './components/ReviewDocument';
export type {
  ReviewDocumentProps,
  ReviewDocumentParty,
  ReviewDocumentStageRow,
  ReviewDocumentTermRow,
  ReviewDocumentSectionTitles,
} from './components/ReviewDocument';

// ── DEV-12 · Экспорт архива сделки ──
export { ArchiveHeader } from './components/ArchiveHeader';
export type { ArchiveHeaderProps } from './components/ArchiveHeader';
export { PackagePreview } from './components/PackagePreview';
export type { PackagePreviewProps, PackagePreviewSection } from './components/PackagePreview';
export { FormatRow } from './components/FormatRow';
export type { FormatRowProps } from './components/FormatRow';
export { Disclosure } from './components/Disclosure';
export type { DisclosureProps } from './components/Disclosure';
export { HashList } from './components/HashList';
export type { HashListProps, HashListRow } from './components/HashList';
export { VerifyPanel } from './components/VerifyPanel';
export type { VerifyPanelProps } from './components/VerifyPanel';
export { StoragePlashka } from './components/StoragePlashka';
export type { StoragePlashkaProps, StoragePlashkaTone } from './components/StoragePlashka';
export { PackageOptions } from './components/PackageOptions';
export type { PackageOptionsProps, PackageOptionValue } from './components/PackageOptions';
export { SnapshotNote } from './components/SnapshotNote';
export type { SnapshotNoteProps } from './components/SnapshotNote';
export { ExportCta } from './components/ExportCta';
export type { ExportCtaProps } from './components/ExportCta';
export { GeneratingState } from './components/GeneratingState';
export type { GeneratingStateProps } from './components/GeneratingState';
export { ReadyState } from './components/ReadyState';
export type { ReadyStateProps } from './components/ReadyState';
// ── DEV-11 · Доказательства + формальная сдача этапа (исполнитель) ──
export { StageHeader } from './components/StageHeader';
export type { StageHeaderProps } from './components/StageHeader';
export { StartConditions } from './components/StartConditions';
export type { StartConditionsProps, StartConditionItem, StartConditionState } from './components/StartConditions';
export { AcceptanceChecklist } from './components/AcceptanceChecklist';
export type { AcceptanceChecklistProps, StageChecklistItemView } from './components/AcceptanceChecklist';
export { CameraStub } from './components/CameraStub';
export type { CameraStubProps } from './components/CameraStub';
export { EvidenceUploader } from './components/EvidenceUploader';
export type { EvidenceUploaderProps, EvidenceBindOption } from './components/EvidenceUploader';
export { EvidenceList } from './components/EvidenceList';
export type { EvidenceListProps, StageEvidenceItemView, StageEvidenceKind } from './components/EvidenceList';
// StoragePlashka уже экспортирован выше (DEV-12 · Экспорт архива) — переиспользуется здесь же (DEV-11).
export { SubmitStageSheet } from './components/SubmitStageSheet';
export type { SubmitStageSheetProps } from './components/SubmitStageSheet';
export { DriveBackupPrompt } from './components/DriveBackupPrompt';
export type { DriveBackupPromptProps } from './components/DriveBackupPrompt';
export { SuspendedBanner } from './components/SuspendedBanner';
export type { SuspendedBannerProps } from './components/SuspendedBanner';

// ── DEV-13 · Список сделок / «Мои договоры» ──
export { MiniStepper } from './components/MiniStepper';
export type { MiniStepperProps } from './components/MiniStepper';
export { ActionMenu } from './components/ActionMenu';
export type { ActionMenuProps, ActionMenuItem } from './components/ActionMenu';
export { SearchInput } from './components/SearchInput';
export type { SearchInputProps } from './components/SearchInput';
export { FilterSheet } from './components/FilterSheet';
export type { FilterSheetProps, FilterOption } from './components/FilterSheet';
export { ContractListRow } from './components/ContractListRow';
export type { ContractListRowProps } from './components/ContractListRow';

// ── DEV-15 · PWA-обвязка — установка, офлайн, обновление ──
export { InstallBanner } from './components/InstallBanner';
export type { InstallBannerProps } from './components/InstallBanner';
export { InstallHowToSheet } from './components/InstallHowToSheet';
export type { InstallHowToSheetProps, InstallHowToStep } from './components/InstallHowToSheet';
export { IosInstallSheet } from './components/IosInstallSheet';
export type { IosInstallSheetProps } from './components/IosInstallSheet';
export { NetworkBanner } from './components/NetworkBanner';
export type { NetworkBannerProps } from './components/NetworkBanner';
export { PreviewBar } from './components/PreviewBar';
export type { PreviewBarProps } from './components/PreviewBar';
export { OfflineStub } from './components/OfflineStub';
export type { OfflineStubProps } from './components/OfflineStub';
export { UpdateToast } from './components/UpdateToast';
export type { UpdateToastProps } from './components/UpdateToast';
export { Toast } from './components/Toast';
export type { ToastProps } from './components/Toast';

/* ── Раскладка десктопа (DEV-19, ADR-099) ──
   Примитивы, из которых собираются рабочие экраны. Медиа-запросы про
   раскладку живут ТОЛЬКО здесь — страницы их не пишут. */
export { DESKTOP_MIN_WIDTH, WIDE_MIN_WIDTH, useDesktopLayout, useWideLayout } from './layout/breakpoints';
export { WorkArea } from './layout/WorkArea';
export type { WorkAreaProps } from './layout/WorkArea';
export { MasterDetail } from './layout/MasterDetail';
export type { MasterDetailProps } from './layout/MasterDetail';
export { RailLayout } from './layout/RailLayout';
export type { RailLayoutProps } from './layout/RailLayout';
export { PassportLayout } from './layout/PassportLayout';
export type { PassportLayoutProps } from './layout/PassportLayout';
export { FormPane } from './layout/FormPane';
export type { FormPaneProps } from './layout/FormPane';
export { CardGrid } from './layout/CardGrid';
export type { CardGridProps } from './layout/CardGrid';
export { ContractPassport } from './components/ContractPassport';
export type { ContractPassportProps, PassportRow } from './components/ContractPassport';
export { ContractTile, CreateContractTile } from './components/ContractTile';
export type { ContractTileProps, CreateContractTileProps } from './components/ContractTile';
export { MilestoneList } from './components/MilestoneList';
export type { MilestoneListProps, MilestoneListItem } from './components/MilestoneList';
export { SectionLabel } from './components/SectionLabel';
export type { SectionLabelProps } from './components/SectionLabel';
export { SummaryCard } from './components/SummaryCard';
export type { SummaryCardProps, SummaryStat, SummaryStatLinkProps } from './components/SummaryCard';

/* ── Компакт-плотность (DEV-20, ADR-1XX) ──
   Density-слой и строчные примитивы, на которых собираются рабочие экраны:
   список — строки на одной поверхности, а не карточка на каждый элемент. */
export { Density } from './components/Density';
export type { DensityProps, DensityMode } from './components/Density';
export { Avatar, avatarHash, avatarInitials } from './components/Avatar';
export type { AvatarProps } from './components/Avatar';
export { Surface } from './components/Surface';
export type { SurfaceProps } from './components/Surface';
export { ListRow } from './components/ListRow';
export type { ListRowProps } from './components/ListRow';
/* Статус словом-цветом и строка результата поиска — один язык списков на всех
   экранах (ADR-152; замечания владельца 03.09 по поиску, платежам, спорам). */
export { StatusWord } from './components/StatusWord';
export type { StatusWordProps } from './components/StatusWord';
export { SearchResultRow } from './components/SearchResultRow';
export type { SearchResultRowProps } from './components/SearchResultRow';
export { ScreenHeader } from './components/ScreenHeader';
export type { ScreenHeaderProps } from './components/ScreenHeader';
export { Segmented } from './components/Segmented';
export type { SegmentedProps, SegmentedItem } from './components/Segmented';
export { ChatLog, ChatBubble, ChatSystemEvent, ChatDay, ChatComposer } from './components/Chat';
export type { ChatLogProps, ChatBubbleProps, ChatSystemEventProps, ChatComposerProps } from './components/Chat';

/* ── Компакт v2 (DEV-20_2) ──
   Вкладки без бокового скролла (2 + воронка), FAB «Создать» вместо кнопки
   в ленте и свайп-действия вместо «⋯» в строке. */
export { ScreenTabs } from './components/ScreenTabs';
export type { ScreenTabsProps, ScreenTabItem } from './components/ScreenTabs';
export { Fab } from './components/Fab';
export type { FabProps } from './components/Fab';
export { SwipeActions } from './components/SwipeActions';
export type { SwipeActionsProps, SwipeAction } from './components/SwipeActions';
