import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { AccountDeletionPage, ACCOUNT_DELETION_CONTACT_EMAIL } from '../src/pages/AccountDeletionPage';

/**
 * Публичная страница `/legal/account-deletion` (ADR-169) — то, что Google Play
 * требует от приложения с аккаунтами: инструкция по удалению, открывающаяся у
 * постороннего человека БЕЗ входа, с названием приложения, шагами, перечнем
 * удаляемого и сохраняемого и сроком хранения.
 *
 * Ни `QueryClientProvider`, ни авторизация здесь НЕ нужны намеренно: страница
 * не ходит в сеть и не знает о сессии — если однажды понадобится что-то из
 * этого, тест упадёт первым.
 */
function renderPage(path = '/legal/account-deletion', lng = 'ru') {
  const i18n = createI18n(lng);
  return {
    i18n,
    ...render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/legal/account-deletion" element={<AccountDeletionPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    ),
  };
}

describe('AccountDeletionPage (публичная /legal/account-deletion)', () => {
  it('⭐ гость видит заголовок с названием приложения и четыре шага удаления', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /Porukam/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Удаление аккаунта');
    // Шаги — именно нумерованным списком: инструкция «по шагам» и есть требование.
    const steps = screen.getByRole('list').querySelectorAll('li');
    expect(steps).toHaveLength(4);
    expect(steps[1]).toHaveTextContent('Настройки');
  });

  it('⭐ оба обязательных подраздела на месте: что удаляется и что сохраняется со сроком', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Что удаляется сразу и безвозвратно' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Что сохраняется и на какой срок' })).toBeInTheDocument();
    // Срок хранения назван словами, а не только в политике.
    expect(screen.getByText(/хранятся год после завершения договора/)).toBeInTheDocument();
    // Запрет удаления при незакрытых делах — тоже на странице, не только в приложении.
    expect(screen.getByRole('heading', { name: 'Когда удалить аккаунт нельзя' })).toBeInTheDocument();
  });

  it('⭐ «если не можете войти» — рабочая mailto-ссылка на контактный адрес', () => {
    renderPage();
    const mail = screen.getByRole('link', { name: ACCOUNT_DELETION_CONTACT_EMAIL });
    expect(mail).toHaveAttribute('href', `mailto:${ACCOUNT_DELETION_CONTACT_EMAIL}`);
    // Адрес остаётся внутри предложения, а не висит отдельной строкой.
    expect(screen.getByTestId('account-deletion-contact')).toHaveTextContent(/Политике конфиденциальности/);
  });

  it('`?lang=en` — страница по-английски: проверяющему из Google нужен английский', async () => {
    const { i18n } = renderPage('/legal/account-deletion?lang=en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Deleting your Porukam account' })).toBeInTheDocument();
    expect(i18n.language).toBe('en');
  });
});
