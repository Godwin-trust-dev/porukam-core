import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DeleteAccountPage, normalizeConfirmWord } from '../src/pages/settings/DeleteAccountPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { MOCK_SCENARIO_KEY } from '../src/mocks/profileHandlers';

/**
 * Рабочее удаление аккаунта (ADR-169) — второе требование Google Play: удалить
 * аккаунт можно ИЗ приложения. Экран был заглушкой с `disabled`-кнопкой.
 */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/me/settings/account/delete']}>
          <Routes>
            <Route path="/me/settings/account/delete" element={<DeleteAccountPage />} />
            <Route path="/welcome" element={<div data-testid="welcome-stub" />} />
            <Route path="/contracts" element={<div data-testid="contracts-stub" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Удаление аккаунта — экран настроек', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1', profiles: [] });
  });
  afterEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().logout();
  });

  it('⭐ второй шаг требует слово-подтверждение: до совпадения кнопка удаления заблокирована', async () => {
    const user = userEvent.setup();
    renderPage();
    // Первый шаг — только предупреждение и переход дальше, удалять ещё нечем.
    expect(screen.queryByTestId('delete-submit')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('delete-continue'));

    const submit = screen.getByTestId('delete-submit');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('delete-word'), 'удали');
    expect(submit).toBeDisabled();
  });

  it('⭐ слово в другом регистре и с пробелом принимается — проверяем намерение, а не набор', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('delete-continue'));
    await user.type(screen.getByTestId('delete-word'), ' удалить ');
    expect(screen.getByTestId('delete-submit')).toBeEnabled();
  });

  it('⭐ успех: сессия и контекст актёра очищены, человек уведён на экран входа с уведомлением', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('delete-continue'));
    await user.type(screen.getByTestId('delete-word'), 'УДАЛИТЬ');
    await user.click(screen.getByTestId('delete-submit'));

    await screen.findByTestId('welcome-stub');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().access).toBeNull();
    expect(useActorStore.getState().activeProfileId).toBeNull();
    // Одноразовый флаг для тоста «Аккаунт удалён» на /welcome.
    expect(sessionStorage.getItem('porukam.accountDeleted')).toBe('1');
  });

  it('⭐ 409 account_deletion_blocked: показаны ЧИСЛА незакрытых дел и ссылка в сделки, сессия цела', async () => {
    sessionStorage.setItem(MOCK_SCENARIO_KEY, 'deletion-blocked');
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('delete-continue'));
    await user.type(screen.getByTestId('delete-word'), 'УДАЛИТЬ');
    await user.click(screen.getByTestId('delete-submit'));

    const blocked = await screen.findByTestId('delete-blocked');
    // Числа из `context` мока: 2 договора, 1 спор.
    expect(blocked).toHaveTextContent('2');
    expect(blocked).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: 'К сделкам' })).toHaveAttribute('href', '/contracts');
    // Удержание — не выход: человек остаётся в аккаунте.
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(screen.queryByTestId('welcome-stub')).not.toBeInTheDocument();
  });

  it('ссылка «что удаляется и что сохраняется» ведёт на публичную страницу', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Что удаляется и что сохраняется' })).toHaveAttribute(
      'href',
      '/legal/account-deletion',
    );
  });
});

/**
 * Слово-подтверждения набирает ЧЕЛОВЕК, поэтому сверка обязана переживать
 * реальную клавиатуру. Две ловушки нашлись при переводе на 29 языков.
 */
describe('normalizeConfirmWord — сверка набранного слова', () => {
  it('турецкая «İ» складывается по правилам ЯЗЫКА, а не локали машины', () => {
    // Наивный toLowerCase() дал бы «si̇l» (i + комбинирующая точка) и слово
    // никогда бы не совпало с набранным «sil».
    expect(normalizeConfirmWord('SİL', 'tr')).toBe(normalizeConfirmWord('sil', 'tr'));
    expect(normalizeConfirmWord('SİL', 'az')).toBe(normalizeConfirmWord('sil', 'az'));
  });

  it('узбекский апостроф-модификатор (Oʻ) совпадает с обычным апострофом клавиатуры', () => {
    expect(normalizeConfirmWord('OʻCHIRISH', 'uz')).toBe(normalizeConfirmWord("o'chirish", 'uz'));
    expect(normalizeConfirmWord('OʻCHIRISH', 'uz')).toBe(normalizeConfirmWord('ochirish', 'uz'));
  });

  it('краевые пробелы не мешают, а другое слово — не совпадает', () => {
    expect(normalizeConfirmWord('  УДАЛИТЬ ', 'ru')).toBe(normalizeConfirmWord('удалить', 'ru'));
    expect(normalizeConfirmWord('удали', 'ru')).not.toBe(normalizeConfirmWord('удалить', 'ru'));
  });
});
