import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Button } from './Button';
import type { IconName } from '../icons/paths';
import styles from './InstallHowToSheet.module.css';

export interface InstallHowToStep {
  icon: IconName;
  label: string;
}

export interface InstallHowToSheetProps {
  open: boolean;
  onClose: () => void;
  titleLabel: string;
  /** Пункты инструкции: иконка + строка. Текст — снаружи, компонент не знает про i18n. */
  steps: readonly InstallHowToStep[];
  /**
   * `true` — последовательность шагов (`ol`, как «Поделиться → На экран → Добавить»);
   * `false` (по умолчанию) — равноправные ВАРИАНТЫ (`ul`, «в Chrome так, в Samsung эдак»).
   * Разметка, а не оформление: маркеры сняты в обоих случаях.
   */
  ordered?: boolean;
  /** Оговорка мелким шрифтом под списком. */
  hintLabel?: string;
  closeLabel: string;
}

/**
 * Инструкция «как поставить приложение руками» (DEV-15 §2, §ло-фай 3).
 *
 * Нужна везде, где системного промпта установки нет: на iOS Safari его не существует
 * в принципе, а на Android его может не отдать браузер (Samsung Internet ставит через
 * собственное меню; Chrome не присылает `beforeinstallprompt` повторно после отказа).
 * Раньше в этих случаях кнопка установки молча не делала ничего.
 *
 * Переиспользует `Sheet` (шторка на мобайле, модалка на десктопе), фокус-ловушка встроена.
 */
export function InstallHowToSheet({
  open,
  onClose,
  titleLabel,
  steps,
  ordered,
  hintLabel,
  closeLabel,
}: InstallHowToSheetProps): JSX.Element {
  const List = ordered ? 'ol' : 'ul';
  return (
    <Sheet
      open={open}
      title={titleLabel}
      onClose={onClose}
      closeLabel={closeLabel}
      actions={
        <Button variant="primary" block onClick={onClose}>
          {closeLabel}
        </Button>
      }
    >
      <List className={styles.steps}>
        {steps.map((step) => (
          <li key={step.label} className={styles.step}>
            <Icon name={step.icon} size={20} className={styles.stepIcon} />
            <span>{step.label}</span>
          </li>
        ))}
      </List>
      {hintLabel ? <p className={styles.hint}>{hintLabel}</p> : null}
    </Sheet>
  );
}
