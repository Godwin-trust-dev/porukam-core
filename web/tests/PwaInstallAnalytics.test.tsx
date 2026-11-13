import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { PwaSurfaces } from '../src/features/pwa/PwaSurfaces';
import { usePwaStore } from '../src/features/pwa/pwaStore';
import { captureInstallPrompt } from '../src/features/pwa/installPromptCapture';
import { recordedInstallEvents, resetRecordedInstallEvents } from '../src/mocks/analyticsHandlers';

/**
 * Воронка установки на реальных точках интерфейса (ADR-171).
 *
 * Без верхней ступени («предложение показали») нижние нечитаемы: ноль
 * установок при нуле показов и ноль установок при сотне показов — разные
 * диагнозы, и по одному числу «установок» их не различить.
 */
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

function kinds(): string[] {
  return recordedInstallEvents.map((event) => event.kind);
}

describe('воронка установки на точках интерфейса (ADR-171)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecordedInstallEvents();
  });
  afterEach(() => {
    localStorage.clear();
    resetRecordedInstallEvents();
    usePwaStore.setState({ needRefresh: false, offlineReady: false, updateSW: null, installPrompt: null });
  });

  it('показ баннера и нажатие «Установить» дают две ступени воронки', async () => {
    renderSurfaces();
    // Баннер намеренно не показывается на загрузке (§2) — до перехода
    // показывать нечего, значит и считать нечего.
    expect(kinds()).toEqual([]);

    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(kinds()).toContain('install_prompt_shown'));

    await userEvent.click(screen.getByRole('button', { name: /Установить/ }));
    await waitFor(() => expect(kinds()).toEqual(['install_prompt_shown', 'install_click']));
  });

  it('показ считается один раз за монтирование, а не на каждую перерисовку', async () => {
    renderSurfaces();
    await userEvent.click(screen.getByText('go'));
    await waitFor(() => expect(kinds()).toContain('install_prompt_shown'));

    await userEvent.click(screen.getByText('go'));
    await userEvent.click(screen.getByText('go'));
    await waitFor(() =>
      expect(kinds().filter((kind) => kind === 'install_prompt_shown')).toHaveLength(1),
    );
  });

  it('appinstalled от браузера — единственный факт установки, который мы знаем', async () => {
    captureInstallPrompt();
    window.dispatchEvent(new Event('appinstalled'));

    await waitFor(() => expect(kinds()).toContain('pwa_installed'));
  });

  it('событие не несёт персональных данных — только вид, платформа, режим, источник', async () => {
    captureInstallPrompt();
    window.dispatchEvent(new Event('appinstalled'));

    await waitFor(() => expect(recordedInstallEvents).toHaveLength(1));
    const event = recordedInstallEvents[0];
    if (!event) throw new Error('событие установки не записано');
    expect(Object.keys(event).sort()).toEqual([
      'display_mode',
      'kind',
      'platform',
      'source',
    ]);
  });
});
