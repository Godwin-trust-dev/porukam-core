import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { AboutPage } from '../src/pages/help/AboutPage';
import { FaqPage } from '../src/pages/help/FaqPage';

/** Отсмотр 2026-08-22: «Что такое По рукам» с инструкциями и FAQ с ответами. */
function wrap(ui: JSX.Element): JSX.Element {
  return (
    <I18nextProvider i18n={createI18n('ru')}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nextProvider>
  );
}

describe('Справка', () => {
  it('«Что такое Porukam»: описание и раскрывающиеся инструкции', async () => {
    render(wrap(<AboutPage />));
    expect(screen.getByRole('heading', { level: 1, name: 'Что такое Porukam' })).toBeInTheDocument();
    const first = screen.getByRole('button', { name: 'Создать договор' });
    expect(screen.queryByText(/Сделки → «Создать»/)).not.toBeInTheDocument();
    await userEvent.click(first);
    expect(screen.getByText(/Сделки → «Создать»/)).toBeInTheDocument();
    // Соцсети спрятаны — ссылок ещё нет (фич-флаг socialLinks выключен).
    expect(screen.queryByRole('navigation', { name: 'Мы в соцсетях' })).not.toBeInTheDocument();
  });

  it('FAQ: вопрос раскрывает ответ', async () => {
    render(wrap(<FaqPage />));
    await userEvent.click(screen.getByRole('button', { name: 'Это бесплатно?' }));
    expect(screen.getByText(/без комиссии с платежей/)).toBeInTheDocument();
  });
});
