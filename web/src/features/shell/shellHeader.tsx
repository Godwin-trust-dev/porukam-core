import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Шапка оболочки на телефоне принадлежит экрану (финал доска A, 03.09):
 * «Уведомления · Прочитать все», «Чат · +», «‹ Настройки». Раньше у экрана
 * была своя шапка ПОД шапкой оболочки, и название стояло дважды
 * («Уведомления ˅» и ниже «Уведомления»), а действия — второй полосой.
 *
 * Как устроено. Оболочка (`ShellLayout`) держит два пустых контейнера —
 * заголовок и действия — и отдаёт их через контекст. Экран рендерит свои
 * узлы порталом в эти контейнеры: порталы не создают петли состояния
 * (узел действий пересоздаётся каждый рендер, в state его класть нельзя),
 * а оболочке достаточно двух булевых флагов, чтобы спрятать меню разделов
 * и переключатель актёра, пока экран занял их место.
 *
 * Без провайдера (изолированный рендер страницы в тестах) хук возвращает
 * `inShell: false` и ничего не порталит — экран рисует свою шапку сам.
 */
interface ShellHeaderContextValue {
  titleEl: HTMLElement | null;
  actionsEl: HTMLElement | null;
  setOccupied: (next: { title: boolean; actions: boolean }) => void;
}

const ShellHeaderContext = createContext<ShellHeaderContextValue | null>(null);

export interface ShellHeaderOptions {
  /** Заголовок с «назад» вместо меню разделов (drill-in: настройки). */
  title?: ReactNode;
  /** Действия справа вместо переключателя актёра («Прочитать все», «+»). */
  actions?: ReactNode;
}

export interface ShellHeaderResult {
  /** Есть оболочка — экран прячет свою шапку на узком экране (`ScreenHeader inShell`). */
  inShell: boolean;
  /** Порталы — отрендерить в дереве экрана (ничего не занимают в потоке). */
  portal: ReactNode;
}

export function useShellHeader({ title, actions }: ShellHeaderOptions): ShellHeaderResult {
  const ctx = useContext(ShellHeaderContext);
  const hasTitle = Boolean(title);
  const hasActions = Boolean(actions);
  const setOccupied = ctx?.setOccupied;

  useEffect(() => {
    if (!setOccupied) return undefined;
    setOccupied({ title: hasTitle, actions: hasActions });
    return () => setOccupied({ title: false, actions: false });
  }, [setOccupied, hasTitle, hasActions]);

  if (!ctx) return { inShell: false, portal: null };
  return {
    inShell: true,
    portal: (
      <>
        {title && ctx.titleEl ? createPortal(title, ctx.titleEl) : null}
        {actions && ctx.actionsEl ? createPortal(actions, ctx.actionsEl) : null}
      </>
    ),
  };
}

export interface ShellHeaderHostProps {
  /** Меню разделов — показывается, пока экран не занял заголовок. */
  menu: ReactNode;
  /** Переключатель актёра — показывается, пока экран не занял действия. */
  actor: ReactNode;
  /** Обёртка шапки (тег, рабочая область, стили) — оболочка решает сама. */
  renderHeader: (slots: ReactNode) => ReactNode;
  titleClassName?: string;
  actionsClassName?: string;
  children: ReactNode;
}

/**
 * Провайдер + слоты шапки: `[меню | заголовок экрана] … [актёр | действия экрана]`.
 * Контейнеры экрана существуют всегда (порталу нужен узел до первого
 * рендера экрана), но пустые они спрятаны (`hidden`) и места не занимают.
 */
export function ShellHeaderHost({ menu, actor, renderHeader, titleClassName, actionsClassName, children }: ShellHeaderHostProps): JSX.Element {
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const [occupied, setOccupiedState] = useState({ title: false, actions: false });
  const setOccupied = useCallback((next: { title: boolean; actions: boolean }) => {
    setOccupiedState((prev) => (prev.title === next.title && prev.actions === next.actions ? prev : next));
  }, []);
  const value = useMemo<ShellHeaderContextValue>(() => ({ titleEl, actionsEl, setOccupied }), [titleEl, actionsEl, setOccupied]);

  return (
    <ShellHeaderContext.Provider value={value}>
      {renderHeader(
        <>
          {occupied.title ? null : menu}
          <div ref={setTitleEl} className={titleClassName} data-testid="shell-header-title" hidden={!occupied.title} />
          <div ref={setActionsEl} className={actionsClassName} data-testid="shell-header-actions" hidden={!occupied.actions} />
          {occupied.actions ? null : actor}
        </>,
      )}
      {children}
    </ShellHeaderContext.Provider>
  );
}
