import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import styles from './ActorSwitcher.module.css';

export interface ActorSwitcherPersonal {
  id: string;
  name: string;
  subtitle?: string;
  /** Фото профиля (ADR-103) — вместо инициалов в триггере и в строке меню. */
  avatarUrl?: string | null;
}

export interface ActorSwitcherOrg {
  id: string;
  name: string;
  kind: string;
  subtitle?: string;
  avatarUrl?: string | null;
}

export interface ActorSwitcherGroup {
  id: string;
  name: string;
  /** Подпись строки: @хендл и/или тип. */
  subtitle?: string;
  /** Логотип объединения (ADR-117 §8) — вместо инициала в триггере и в строке меню. */
  avatarUrl?: string | null;
}

export interface ActorSwitcherProps {
  /** id активного профиля — личного или одной из организаций. */
  current: string;
  personal: ActorSwitcherPersonal;
  orgs: ActorSwitcherOrg[];
  onSelect: (id: string) => void;
  /** Клик по УЖЕ активному актёру — открыть его профиль (отсмотр прода
   *  2026-08-20: раньше строка была «мёртвой»). Необязателен: без него
   *  повторный выбор только закрывает меню, как прежде. */
  onOpenCurrent?: (id: string) => void;
  /** Без обработчика пункт «Добавить организацию» не показывается (объединения выключены). */
  onAddOrg?: () => void;
  /** Объединения, которыми пользователь управляет (лидер/админ, ADR-118).
   * Стороной договора объединение по-прежнему не является (tech-spec §5.2.1b),
   * но с ADR-129 это ПОЛНОЦЕННАЯ строка актёра: `onSelectGroup` переводит
   * оболочку в контекст объединения (`current` становится его id). Без
   * `onSelectGroup` поведение прежнее — строка только открывает карточку. */
  groups?: ActorSwitcherGroup[];
  /** Сделать объединение активным актёром (ADR-129). */
  onSelectGroup?: (id: string) => void;
  /** Клик по УЖЕ активному объединению — открыть его карточку. */
  onOpenGroup?: (id: string) => void;
  groupsLabel?: string;
  triggerLabel: string;
  personalLabel: string;
  addOrgLabel: string;
  /** Выход из аккаунта (замечание владельца 07.09: кнопки «Выйти» не было
   *  нигде, кроме скрытого раздела «Безопасность»). Без обработчика пункта
   *  нет — витрина и старые вызовы не меняются. */
  onLogout?: () => void;
  logoutLabel?: string;
  /** Открыть меню сразу (витрина/тесты) — по умолчанию закрыто. */
  initialOpen?: boolean;
}

function initials(name: string | null | undefined): string {
  // Оборонительно: реальные данные могут прийти без имени (display_name:
  // null у свежего пользователя) — шапка не должна ронять всё приложение.
  // Пустая строка => аватар рисует дефолт-глиф (DEV-17 §4), не «•».
  return (name ?? '').trim().charAt(0).toUpperCase();
}

/** Кружок актёра: фото, если есть, иначе инициал на фирменном градиенте. */
function Avatar({ name, avatarUrl, person }: { name: string; avatarUrl?: string | null; person: boolean }): JSX.Element {
  return (
    <span className={`${styles.avatar} ${person ? styles.person : styles.org}`}>
      {avatarUrl ? <img src={avatarUrl} alt="" className={styles.avatarImg} /> : initials(name) || <Icon name="profile" size={20} />}
    </span>
  );
}

type Row = {
  id: string;
  kind: 'personal' | 'org' | 'group' | 'add' | 'logout';
  name: string;
  subtitle?: string;
  avatarUrl?: string | null;
};

/**
 * Переключатель актёра оболочки (DEV-shell): личный аккаунт + список организаций,
 * которые представляет пользователь, + «Добавить организацию». Меню — listbox с
 * виртуальным фокусом (`aria-activedescendant`), Esc закрывает и возвращает фокус триггеру.
 */
export function ActorSwitcher({
  current,
  personal,
  orgs,
  onSelect,
  onOpenCurrent,
  onAddOrg,
  groups = [],
  onSelectGroup,
  onOpenGroup,
  groupsLabel,
  triggerLabel,
  personalLabel,
  addOrgLabel,
  onLogout,
  logoutLabel,
  initialOpen = false,
}: ActorSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = 'actor-switcher-listbox';

  const rows: Row[] = [
    { id: personal.id, kind: 'personal', name: personal.name, subtitle: personal.subtitle ?? personalLabel, avatarUrl: personal.avatarUrl },
    ...orgs.map((o): Row => ({ id: o.id, kind: 'org', name: o.name, subtitle: [o.kind, o.subtitle].filter(Boolean).join(' · '), avatarUrl: o.avatarUrl })),
    ...(onOpenGroup || onSelectGroup
      ? groups.map((g): Row => ({
          id: g.id,
          kind: 'group',
          name: g.name,
          subtitle: [groupsLabel, g.subtitle].filter(Boolean).join(' · '),
          avatarUrl: g.avatarUrl,
        }))
      : []),
    ...(onAddOrg ? [{ id: '__add-org__', kind: 'add' as const, name: addOrgLabel }] : []),
    // Выход — ПОСЛЕДНИМ и за разделителем: это не выбор актёра, а конец сессии.
    ...(onLogout ? [{ id: '__logout__', kind: 'logout' as const, name: logoutLabel ?? '' }] : []),
  ];

  // Активным может быть и объединение (ADR-129) — иначе в триггере оставалось
  // бы имя личного профиля, хотя оболочка уже в контексте объединения.
  const active = [personal, ...orgs, ...groups].find((p) => p.id === current) ?? personal;
  const activeIsGroup = groups.some((g) => g.id === current);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, rows.findIndex((r) => r.id === current)));
    listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function activate(row: Row): void {
    if (row.kind === 'add') {
      onAddOrg?.();
    } else if (row.kind === 'logout') {
      onLogout?.();
    } else if (row.kind === 'group') {
      // Уже активное объединение — открыть карточку, как onOpenCurrent у профиля.
      if (row.id !== current && onSelectGroup) onSelectGroup(row.id);
      else onOpenGroup?.(row.id);
    } else if (row.id !== current) {
      onSelect(row.id);
    } else {
      onOpenCurrent?.(row.id);
    }
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % rows.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(rows.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const row = rows[activeIndex];
        if (row) activate(row);
        break;
      }
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={triggerLabel}
        data-testid="actor-trigger"
      >
        <Avatar name={active.name} avatarUrl={active.avatarUrl} person={!activeIsGroup && active.id === personal.id} />
        {/* На узком экране имя скрыто (CSS): в шапке остаются фото и шеврон —
            место под кнопку разделов и заголовок (замечание 2026-08-25). */}
        <span className={`${styles.whoName} ${styles.triggerName}`} data-testid="actor-active">
          {active.name}
        </span>
        {/* Шеврон раскрытия (DEV-17 §4): раньше стояла иконка «sort» и читалась
            как отдельный контрол сортировки рядом с аватаром. */}
        <Icon name="chevron-down" size={16} className={styles.triggerChevron} />
      </button>

      {open ? (
        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={triggerLabel}
          aria-activedescendant={`${listboxId}-${rows[activeIndex]?.id}`}
          className={styles.menu}
          onKeyDown={onKeyDown}
        >
          {rows.map((row, i) => (
            <div
              key={row.id}
              id={`${listboxId}-${row.id}`}
              role="option"
              aria-selected={row.kind !== 'add' && row.kind !== 'logout' && row.id === current}
              className={[
                styles.item,
                i === activeIndex ? styles.itemFocused : '',
                row.kind !== 'add' && row.kind !== 'logout' && row.id === current ? styles.itemActive : '',
                row.kind === 'add' ? styles.itemAdd : '',
                row.kind === 'logout' ? styles.itemLogout : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => activate(row)}
              data-testid={
                row.kind === 'add'
                  ? 'actor-option-add-org'
                  : row.kind === 'logout'
                    ? 'logout'
                    : row.kind === 'group'
                      ? `actor-group-${row.id}`
                      : `actor-option-${row.id}`
              }
            >
              {row.kind === 'add' ? (
                <Icon name="plus" size={20} className={styles.addIcon} />
              ) : row.kind === 'logout' ? (
                <Icon name="logout" size={20} className={styles.addIcon} />
              ) : (
                <Avatar name={row.name} avatarUrl={row.avatarUrl} person={row.kind === 'personal'} />
              )}
              <span className={styles.who}>
                <span className={styles.whoName}>{row.name}</span>
                {row.subtitle ? <span className={styles.whoSubtitle}>{row.subtitle}</span> : null}
              </span>
              {row.kind !== 'add' && row.kind !== 'logout' && row.id === current ? (
                <Icon name="sealed" size={20} className={styles.check} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
