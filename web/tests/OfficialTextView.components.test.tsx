import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfficialTextView } from '@porukam/ui';

function setDesktop(isDesktop: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isDesktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const props = {
  onClose: () => {},
  closeLabel: 'Закрыть',
  sheetTitle: 'Официальный текст (English)',
  sheetSubtitle: 'Это версия, которая подписывается.',
  footnote: 'При расхождении перевода и официального текста действует официальный (English).',
  officialText: 'Official body text.',
  viewerLabel: 'Ваш язык (автоперевод)',
  viewerText: 'Текст на языке пользователя.',
  officialLabel: 'Официальный текст (English)',
};

// DEV-16b §7 — «OfficialTextView (mobile sheet / desktop columns)».
describe('OfficialTextView (DEV-16b §3/§6)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('closed=false — ничего не рендерит ни на mobile, ни на desktop', () => {
    setDesktop(false);
    const { rerender, container } = render(<OfficialTextView open={false} {...props} />);
    expect(container).toBeEmptyDOMElement();
    setDesktop(true);
    rerender(<OfficialTextView open={false} {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mobile (<640px) — открывает Sheet с заголовком «Официальный текст (English)»', () => {
    setDesktop(false);
    render(<OfficialTextView open {...props} />);
    expect(screen.getByRole('dialog', { name: 'Официальный текст (English)' })).toBeInTheDocument();
    expect(screen.getByText('Official body text.')).toBeInTheDocument();
  });

  it('desktop (>=640px) — рендерит CompareColumns инлайн (обе колонки видны)', () => {
    setDesktop(true);
    render(<OfficialTextView open {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Ваш язык (автоперевод)')).toBeInTheDocument();
    expect(screen.getByText('Текст на языке пользователя.')).toBeInTheDocument();
    expect(screen.getByText('Official body text.')).toBeInTheDocument();
  });
});
