import { Tooltip } from './Tooltip';
import styles from './MachineTranslationMark.module.css';

export interface MachineTranslationMarkProps {
  /** Короткое слово-пометка («beta», «авто-перевод»). */
  label: string;
  tooltip: string;
}

/**
 * Пометка «машинный перевод» (docs/tasks/Задача_feat_l10n-launch-surfaces.md
 * §C) — МЕЛКАЯ, приглушённая, без плашки-акцента: замечание к /welcome —
 * «акцент на самом языке, пометка неброская». Раньше на строке языка стоял
 * `Badge tone="amber"` с текстом «авто-перевод»: янтарная плашка
 * перетягивала внимание с названия языка на служебную ремарку, а на 27
 * машинных языках из 29 плашка стояла почти в каждой строке списка.
 *
 * Честность при этом не теряется: сам факт виден всегда (слово-пометка), а
 * подробность — в тултипе, как и было (`Tooltip`, DEV-16a §2/§4). Одна и та
 * же пометка на строке языка в переключателе и над машинно переведённым
 * юр-документом — один факт выглядит одинаково в обоих местах.
 */
export function MachineTranslationMark({ label, tooltip }: MachineTranslationMarkProps): JSX.Element {
  return (
    <Tooltip text={tooltip}>
      {/* `span`, не интерактивный элемент: пометка живёт внутри `<button>`
          строки языка, а вложенный фокусируемый контрол внутри button
          невалиден по HTML (см. LocaleRow). */}
      <span className={styles.mark}>{label}</span>
    </Tooltip>
  );
}
