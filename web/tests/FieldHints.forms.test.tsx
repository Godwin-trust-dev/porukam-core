import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetPortfolio } from '../src/mocks/portfolioHandlers';

/**
 * Подсказки «?» по полям оставшихся форм (отсмотр 22.08, вторая волна):
 * этапы, объединения, портфолио, настройки, правки, подписание. Проверяем
 * две вещи: подсказка реально раскрывается в форме и ключ есть во ВСЕХ
 * 29 локалях (паритет — иначе язык молча свалится в EN-фолбэк).
 */

const LOCALES_DIR = join(__dirname, '../../packages/i18n/src/locales');

/** Плоские пути всех строковых ключей объекта: `stage.materials.unit`. */
function flatKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('Подсказки «?» — новые формы', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    resetPortfolio();
  });

  it('форма работы в портфолио: «?» у названия раскрывает текст подсказки', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={createI18n('ru')}>
          <MemoryRouter initialEntries={['/me/portfolio']}>
            <PortfolioPage />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByTestId('portfolio-add'));
    const hint = /Как назвать эту работу/;
    expect(screen.queryByText(hint)).not.toBeInTheDocument();

    // Первая «?» в модалке — у поля «Название работы».
    const [firstHelp] = screen.getAllByTestId('field-help');
    await userEvent.click(firstHelp!);
    const note = screen.getByText(hint);
    expect(note).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-title').getAttribute('aria-describedby')).toContain(note.id);
  });

  it('ключи новых подсказок есть во всех 29 локалях с паритетом к ru', () => {
    const codes = readdirSync(LOCALES_DIR).filter((n) => statSync(join(LOCALES_DIR, n)).isDirectory());
    expect(codes).toHaveLength(29);

    const read = (code: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(LOCALES_DIR, code, 'hints.json'), 'utf8')) as Record<string, unknown>;
    const expected = flatKeys(read('ru')).sort();
    // Формы этой волны — их ключи обязаны быть в эталоне.
    for (const key of [
      'stage.title',
      'stage.amount',
      'stage.duration',
      'stage.checklist',
      'stage.evidence',
      'stage.materials.unit',
      'group.handle',
      'group.logo',
      'portfolio.completedAt',
      'settings.avatar',
      'settings.notif.deadlines',
      'revision.after',
      'signing.declineComment',
    ]) {
      expect(expected).toContain(key);
    }

    for (const code of codes) {
      expect({ code, keys: flatKeys(read(code)).sort() }).toEqual({ code, keys: expected });
    }
  });
});
