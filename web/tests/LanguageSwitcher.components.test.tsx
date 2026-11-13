import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocaleInfo } from '@porukam/core';
import { LocaleList, LanguageSwitcher } from '@porukam/ui';

const LOCALES: LocaleInfo[] = [
  { code: 'en', self_name: 'English', english_name: 'English', quality: 'human', enabled: true, dir: 'ltr' },
  { code: 'ru', self_name: 'Русский', english_name: 'Russian', quality: 'human', enabled: true, dir: 'ltr' },
  { code: 'es', self_name: 'Español', english_name: 'Spanish', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'uk', self_name: 'Українська', english_name: 'Ukrainian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'ar', self_name: 'العربية', english_name: 'Arabic', quality: 'machine', enabled: false, dir: 'rtl' },
];

const listProps = {
  currentCode: 'en',
  searchPlaceholder: 'Search language…',
  searchAriaLabel: 'Search language',
  searchClearLabel: 'Clear search',
  currentSectionTitle: 'Current',
  allSectionTitle: 'All languages',
  noResultsText: 'No languages found',
  betaLabel: 'auto-translated',
  betaTooltip: 'Machine-translated — may be inaccurate',
  currentAriaLabel: 'Current language',
};

// DEV-16a §7 — LocaleList: поиск self/english/code, секция «Текущий», галочка,
// machine → beta-бейдж+тултип, без флагов, enabled:false приглушён+кликабелен.
describe('LocaleList (DEV-16a §2/§7)', () => {
  it('без поиска — секции «Текущий» → «Все языки» (алфавит по self_name), текущий помечен', () => {
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('All languages')).toBeInTheDocument();
    const current = screen.getByRole('option', { name: /English/ });
    expect(current).toHaveAttribute('aria-selected', 'true');
  });

  it('порядок «Всех языков» не зависит от локали среды: латиница → кириллица → остальные (отсмотр 2026-08-19)', () => {
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    const names = screen
      .getAllByRole('option')
      .map((el) => el.textContent ?? '')
      .filter((text) => !/English/.test(text)); // секция «Текущий» — отдельно
    expect(names.map((text) => text.slice(0, 3))).toEqual(['Esp', 'Рус', 'Укр', 'الع']);
  });

  it('поиск матчит self_name/english_name/code, регистро- и диакритиконечувствительно', async () => {
    const user = userEvent.setup();
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    await user.type(screen.getByRole('searchbox'), 'укр');
    expect(screen.getByRole('option', { name: /Українська/ })).toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument(); // плоский список при поиске
    expect(screen.queryByRole('option', { name: /Español/ })).not.toBeInTheDocument();
  });

  it('поиск по коду (case-insensitive)', async () => {
    const user = userEvent.setup();
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    await user.type(screen.getByRole('searchbox'), 'ES');
    expect(screen.getByRole('option', { name: /Español/ })).toBeInTheDocument();
  });

  it('quality:machine → бейдж beta, human — без бейджа', () => {
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    const spanish = screen.getByRole('option', { name: /Español/ });
    expect(within(spanish).getByText('auto-translated')).toBeInTheDocument();
    const russian = screen.getByRole('option', { name: /Русский/ });
    expect(within(russian).queryByText('auto-translated')).not.toBeInTheDocument();
  });

  it('без флагов стран — само-название рендерится текстом, не эмодзи-флагом', () => {
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    // Само-название — обычный текстовый узел; ни один эмодзи-флаг (regional indicator) не рендерится.
    const html = document.body.innerHTML;
    expect(/[\u{1F1E6}-\u{1F1FF}]/u.test(html)).toBe(false);
  });

  it('enabled:false — строка приглушена, но клик всё равно вызывает onSelect (родитель решает — тост)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<LocaleList locales={LOCALES} onSelect={onSelect} {...listProps} />);
    const arabic = screen.getByRole('option', { name: /العربية/ });
    await user.click(arabic);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ code: 'ar', enabled: false }));
  });

  it('loading — скелетоны, без listbox', () => {
    render(<LocaleList locales={LOCALES} onSelect={() => {}} loading {...listProps} />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('ошибка загрузки — короткий текст + retry, язык не трогаем', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <LocaleList
        locales={[]}
        onSelect={() => {}}
        errorText="Couldn't load the language list"
        onRetry={onRetry}
        retryLabel="Retry"
        {...listProps}
      />,
    );
    expect(screen.getByText("Couldn't load the language list")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('нет результатов поиска — сообщение вместо пустого списка', async () => {
    const user = userEvent.setup();
    render(<LocaleList locales={LOCALES} onSelect={() => {}} {...listProps} />);
    await user.type(screen.getByRole('searchbox'), 'zzz-not-a-language');
    expect(screen.getByText('No languages found')).toBeInTheDocument();
  });

  // docs/tasks/Задача_fix_web-locales-switcher.md — прод-крэш: реальный
  // /v1/locales отдавал записи без self_name, `a.self_name.localeCompare`
  // ронял весь список (`TypeError: Cannot read properties of undefined`).
  it('запись без self_name (неполный ответ API) не роняет список, а не участвует в поиске/сортировке', () => {
    const malformed = [
      ...LOCALES,
      { code: 'zz', english_name: 'Unknown' } as unknown as LocaleInfo,
    ];
    expect(() => render(<LocaleList locales={malformed} onSelect={() => {}} {...listProps} />)).not.toThrow();
    expect(screen.getByRole('option', { name: /Español/ })).toBeInTheDocument();
  });
});

const switcherProps = {
  locales: LOCALES,
  currentLocale: 'en',
  listTitle: 'Interface language',
  ...listProps,
  retryLabel: 'Retry',
  closeLabel: 'Close',
  triggerAriaLabel: 'Interface language',
};

function setDesktop(isDesktop: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isDesktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// DEV-16a §7 — LanguageSwitcher: 3 варианта рендера; открытие sheet/dropdown; выбор.
describe('LanguageSwitcher (DEV-16a §1/§7)', () => {
  beforeEach(() => setDesktop(false));
  afterEach(() => vi.restoreAllMocks());

  it('variant=chip — «🌐 English ▾»-пилюля, без флагов', () => {
    render(<LanguageSwitcher variant="chip" onPick={() => {}} {...switcherProps} />);
    const trigger = screen.getByRole('button', { name: 'Interface language' });
    expect(within(trigger).getByText('English')).toBeInTheDocument();
  });

  it('variant=globe — рендерит триггер с глобусом', () => {
    render(<LanguageSwitcher variant="globe" onPick={() => {}} {...switcherProps} />);
    expect(screen.getByRole('button', { name: 'Interface language' })).toBeInTheDocument();
  });

  it('surface=on-ink — триггер получает on-ink класс (чернильный герой карточки репутации)', () => {
    render(<LanguageSwitcher variant="globe" surface="on-ink" onPick={() => {}} {...switcherProps} />);
    expect(screen.getByRole('button', { name: 'Interface language' }).className).toMatch(/onInk/);
  });

  it('variant=row — строка «Язык интерфейса … English ›» (SettingRow control=link)', () => {
    render(<LanguageSwitcher variant="row" onPick={() => {}} {...switcherProps} />);
    expect(screen.getByText('Interface language')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
  });

  it('mobile (<640px) — клик по триггеру открывает Sheet с ролью dialog', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher variant="chip" onPick={() => {}} {...switcherProps} />);
    await user.click(screen.getByRole('button', { name: 'Interface language' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('desktop (>=640px) — клик по триггеру открывает anchored dropdown с ролью dialog', async () => {
    setDesktop(true);
    const user = userEvent.setup();
    render(<LanguageSwitcher variant="globe" onPick={() => {}} {...switcherProps} />);
    await user.click(screen.getByRole('button', { name: 'Interface language' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('выбор языка вызывает onPick с кодом и закрывает панель', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<LanguageSwitcher variant="chip" onPick={onPick} {...switcherProps} />);
    await user.click(screen.getByRole('button', { name: 'Interface language' }));
    await user.click(screen.getByRole('option', { name: /Español/ }));
    expect(onPick).toHaveBeenCalledWith('es');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape (desktop) закрывает dropdown', async () => {
    setDesktop(true);
    const user = userEvent.setup();
    render(<LanguageSwitcher variant="globe" onPick={() => {}} {...switcherProps} />);
    await user.click(screen.getByRole('button', { name: 'Interface language' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
