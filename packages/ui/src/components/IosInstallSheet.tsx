import { InstallHowToSheet } from './InstallHowToSheet';

export interface IosInstallSheetProps {
  open: boolean;
  onClose: () => void;
  titleLabel: string;
  step1Label: string;
  step2Label: string;
  step3Label: string;
  /** Оговорка «push включится после установки» (§5) — опущена вне контекста push. */
  pushHintLabel?: string;
  closeLabel: string;
}

/**
 * Инструкция установки для iOS Safari (DEV-15 §2, §ло-фай 3): нет `beforeinstallprompt`,
 * поэтому вместо системного промпта — три шага «Поделиться → На экран „Домой" → Добавить».
 *
 * Частный случай `InstallHowToSheet` (та же шторка понадобилась Android и десктопу без
 * системного промпта) — оставлен отдельным компонентом, потому что его три шага фиксированы
 * и вызывающая сторона не должна каждый раз подбирать к ним иконки.
 */
export function IosInstallSheet({
  open,
  onClose,
  titleLabel,
  step1Label,
  step2Label,
  step3Label,
  pushHintLabel,
  closeLabel,
}: IosInstallSheetProps): JSX.Element {
  return (
    <InstallHowToSheet
      open={open}
      onClose={onClose}
      titleLabel={titleLabel}
      ordered
      steps={[
        { icon: 'share', label: step1Label },
        { icon: 'home', label: step2Label },
        { icon: 'plus', label: step3Label },
      ]}
      hintLabel={pushHintLabel}
      closeLabel={closeLabel}
    />
  );
}
