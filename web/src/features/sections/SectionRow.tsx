import type { KeyboardEvent, ReactNode } from 'react';

export interface SectionRowProps {
  className?: string;
  /** Доступное имя строки — то же, что её заголовок. */
  label: string;
  onOpen: () => void;
  selected?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Строка раздела, ведущая себя как кнопка, но НЕ являющаяся `<button>`:
 * внутри теперь живут собственные интерактивные элементы (ссылка на карточку
 * контрагента + кнопка «Скопировать хендл»), а HTML запрещает вкладывать
 * интерактивное в интерактивное. Тот же приём, что `ContractListRow`:
 * `role="button"` + `tabIndex` + Enter/Space, вложенные элементы сами
 * останавливают всплытие клика.
 */
export function SectionRow({
  className,
  label,
  onOpen,
  selected,
  children,
  'data-testid': testId,
}: SectionRowProps): JSX.Element {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      data-testid={testId}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
