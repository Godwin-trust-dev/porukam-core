import type { ElementType, ReactNode } from 'react';

export type DensityMode = 'compact' | 'cozy';

export interface DensityProps {
  /** `compact` — рабочие экраны (по умолчанию во всём приложении),
   * `cozy` — якоря: вход/онбординг, подписание «по рукам», церемония
   * приёмки (DEV-20 §7). */
  mode: DensityMode;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}

/**
 * Переключатель плотности (DEV-20 §1). Ставит `data-density` на обёртку —
 * дальше работают CSS-переменные `--pr-d-*` из `styles/tokens.css`, компоненты
 * ниже по дереву ничего о режиме не знают и никаких пропсов не получают.
 *
 * Компакт — значение по умолчанию (`:root`), поэтому оборачивать рабочие
 * экраны НЕ нужно: обёртка нужна только якорям, где нужен воздух.
 */
export function Density({ mode, as: Tag = 'div', className, children }: DensityProps): JSX.Element {
  return (
    <Tag data-density={mode} className={className}>
      {children}
    </Tag>
  );
}
