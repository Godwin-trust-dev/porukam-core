import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { Sheet } from './Sheet';
import styles from './SwipeActions.module.css';

export interface SwipeAction {
  key: string;
  label: string;
  destructive?: boolean;
  /**
   * Быстрое действие: показывается прямо под строкой при свайпе. Долгий тап
   * открывает ПОЛНЫЙ список — под пальцем помещается два-три пункта, не больше.
   * Если быстрых не отмечено, берём первые два.
   */
  quick?: boolean;
  onSelect: () => void;
}

export interface SwipeActionsProps {
  children: ReactNode;
  actions: SwipeAction[];
  /** Заголовок шита действий (он же имя доступной кнопки-запасного входа). */
  menuLabel: string;
  closeLabel: string;
  'data-testid'?: string;
}

/** Порог открытия и максимальный сдвиг строки, px. */
const OPEN_AT = 56;
const MAX_SHIFT = 168;
/** Долгий тап — то же меню, что и свайп (§2). */
const LONG_PRESS_MS = 500;

/**
 * Свайп-действия строки списка (DEV-20_2 §2). Заменяют «⋯» в строке: список
 * остаётся чистым (название + сумма + статус), а быстрые действия приходят
 * жестом — свайпом по строке или долгим тапом.
 *
 * Клавиатура и скринридер жеста не имеют, поэтому здесь же живёт кнопка
 * «действия»: визуально скрыта, но фокусируема и проявляется по фокусу —
 * иначе действия были бы недоступны без тачскрина (§10).
 *
 * Горизонтальный сдвиг живёт ВНУТРИ строки (`overflow: clip` на обёртке) —
 * страница вбок не уезжает.
 */
export function SwipeActions({
  children,
  actions,
  menuLabel,
  closeLabel,
  ...rest
}: SwipeActionsProps): JSX.Element {
  const [shift, setShift] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** null — жест ещё не распознан, 'x' — свайп (перехватываем), 'y' — скролл (не мешаем). */
  const axis = useRef<'x' | 'y' | null>(null);
  const longPress = useRef<number | null>(null);

  function clearLongPress(): void {
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current);
      longPress.current = null;
    }
  }
  useEffect(() => clearLongPress, []);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.pointerType === 'mouse') return; // мышь свайпом не пользуется — у неё фокус и меню
    start.current = { x: e.clientX, y: e.clientY };
    axis.current = null;
    clearLongPress();
    longPress.current = window.setTimeout(() => {
      start.current = null;
      setShift(0);
      setSheetOpen(true);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    if (axis.current === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      clearLongPress();
      if (axis.current === 'x') setDragging(true);
    }
    if (axis.current !== 'x') return;
    // Тянем только «от конца строки» — открытие вправо смысла не имеет.
    setShift(Math.max(0, Math.min(MAX_SHIFT, -dx)));
  }

  function onPointerUp(): void {
    clearLongPress();
    if (axis.current === 'x') setShift((s) => (s >= OPEN_AT ? MAX_SHIFT : 0));
    setDragging(false);
    start.current = null;
    axis.current = null;
  }

  function run(a: SwipeAction): void {
    setShift(0);
    setSheetOpen(false);
    a.onSelect();
  }

  const quick = actions.some((a) => a.quick) ? actions.filter((a) => a.quick) : actions.slice(0, 2);

  return (
    <div className={styles.wrap} {...rest}>
      <div className={styles.actions} aria-hidden={shift === 0}>
        {quick.slice(0, 3).map((a) => (
          <button
            key={a.key}
            type="button"
            className={`${styles.action} ${a.destructive ? styles.destructive : ''}`}
            tabIndex={shift === 0 ? -1 : 0}
            onClick={() => run(a)}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className={`${styles.sled} ${dragging ? styles.dragging : ''}`}
        // Трансформа ТОЛЬКО пока строка реально сдвинута. `translateX(0)` —
        // не «ничего»: любая трансформа создаёт контекст наложения, и
        // раскрытое меню «⋯» оказывалось заперто внутри своей строки — его
        // перекрывала СЛЕДУЮЩАЯ строка, хотя у меню z-index выше (тот же
        // класс ловушки, что ADR-143 с `contain: layout`).
        style={shift ? { transform: `translateX(calc(var(--pr-swipe-dir) * ${shift}px))` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Открытая «полка» закрывается тем же тапом, которым обычно открывают
        // строку — иначе первый тап после свайпа уводил бы с экрана.
        onClickCapture={(e) => {
          if (shift === 0) return;
          e.stopPropagation();
          e.preventDefault();
          setShift(0);
        }}
      >
        {children}
      </div>
      <button
        type="button"
        className={styles.a11yTrigger}
        aria-label={menuLabel}
        onClick={() => setSheetOpen(true)}
      >
        {menuLabel}
      </button>
      {sheetOpen ? (
        <Sheet open title={menuLabel} onClose={() => setSheetOpen(false)} closeLabel={closeLabel}>
          <div className={styles.sheetActions}>
            {actions.map((a) => (
              <Button key={a.key} variant={a.destructive ? 'destructive' : 'ghost'} block onClick={() => run(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
