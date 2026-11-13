import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { PwaSurfaces } from '../src/features/pwa/PwaSurfaces';
import { usePwaStore } from '../src/features/pwa/pwaStore';

function Harness(): JSX.Element {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/contracts')}>go</button>
      <PwaSurfaces />
    </>
  );
}

function renderSurfaces() {
  const i18n = createI18n('ru');
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/']}>
        <Harness />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function dispatchBeforeInstallPrompt() {
  const evt = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt?: () => Promise<void>;
    userChoice?: Promise<{ outcome: string; platform: string }>;
  };
  evt.prompt = () => Promise.resolve();
  evt.userChoice = Promise.resolve({ outcome: 'accepted', platform: '' });
  window.dispatchEvent(evt);
}

describe('PwaSurfaces (DEV-15) — критерии приёмки §10', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    // `installPrompt` теперь в сторе (перехват идёт до рендера) — сбрасываем, иначе
    // пойманный в одном тесте промпт утечёт в сценарий «браузер промпт не дал».
    usePwaStore.setState({ needRefresh: false, offlineReady: false, updateSW: null, installPrompt: null });
  });

  it('install-баннер — не на загрузке, появляется после первой смены маршрута (§2)', async () => {
    renderSurfaces();
    dispatchBeforeInstallPrompt();
    expect(screen.queryByText(/Установите Porukam/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByText(/Установите Porukam/)).toBeInTheDocument());
  });

  it('«✕» на баннере — скрывает сейчас и откладывает на неделю, а не насовсем (§2, 05.09)', async () => {
    renderSurfaces();
    dispatchBeforeInstallPrompt();
    await userEvent.click(screen.getByText('go'));
    await screen.findByText(/Установите Porukam/);

    await userEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByText(/Установите Porukam/)).not.toBeInTheDocument();

    // Отметка времени, а не «навсегда»: через неделю предложение вернётся
    // (пороги — в tests/installDismissed.test.ts).
    expect(localStorage.getItem('porukam.installBannerDismissed')).toBeNull();
    const at = Number(localStorage.getItem('porukam.installBannerDismissedAt'));
    expect(Number.isFinite(at)).toBe(true);
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  });

  it('браузер не дал промпт (Samsung Internet) — баннер всё равно есть, «Установить» открывает инструкцию', async () => {
    // Раньше баннер требовал `beforeinstallprompt` либо iOS — на Samsung S22 Ultra
    // предложения установки не появлялось вовсе (жалоба владельца 05.09).
    renderSurfaces();
    await userEvent.click(screen.getByText('go'));
    await screen.findByText(/Установите Porukam/);

    await userEvent.click(screen.getByRole('button', { name: 'Установить' }));

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveTextContent('Как установить приложение');
    expect(sheet).toHaveTextContent(/Samsung Internet/);
  });

  it('офлайн → полоса «Нет сети · показано из кэша», онлайн → скрыта (§3)', async () => {
    renderSurfaces();
    expect(screen.queryByText(/Нет сети/)).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('offline')));
    await screen.findByText(/Нет сети · показано из кэша/);

    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.queryByText(/Нет сети/)).not.toBeInTheDocument());
  });

  it('needRefresh → UpdateToast, «Обновить» зовёт updateSW(true), «Отложить» скрывает (§4)', async () => {
    let updateCalledWith: boolean | undefined;
    usePwaStore.setState({
      updateSW: (reload) => {
        updateCalledWith = reload;
        return Promise.resolve();
      },
    });
    renderSurfaces();
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();

    act(() => usePwaStore.getState().setNeedRefresh(true));
    await screen.findByText('Доступна новая версия');

    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(updateCalledWith).toBe(true);
  });

  it('«Отложить» скрывает тост без вызова updateSW', async () => {
    let called = false;
    usePwaStore.setState({ updateSW: () => ((called = true), Promise.resolve()) });
    renderSurfaces();
    act(() => usePwaStore.getState().setNeedRefresh(true));
    await screen.findByText('Доступна новая версия');

    await userEvent.click(screen.getByRole('button', { name: 'Отложить' }));
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });
});
