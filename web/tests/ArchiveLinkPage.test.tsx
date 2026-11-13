import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ArchiveLinkPage, archiveLinkNavigation } from '../src/pages/ArchiveLinkPage';

/**
 * Страховка от УСТАРЕВШЕГО service worker'а на пути `/a/<token>` (ADR-139 §7,
 * инцидент 03.09 в docs/backlog.md). В норме этот экран не рисуется вообще:
 * nginx отдаёт `/a/` бэкенду. Но пока у человека жив SW со старым денилистом,
 * оболочка открывается здесь — и обязана уйти в сеть, а не показать «не найдено».
 */
function renderAt(path: string): void {
  window.history.replaceState({}, '', path);
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <MemoryRouter initialEntries={[path]}>
        <ArchiveLinkPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('ArchiveLinkPage — /a/<token> в оболочке SPA', () => {
  let replace: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // `window.location.replace` в jsdom не реализован и подменить его нельзя —
    // ради этого настоящая навигация вынесена в `archiveLinkNavigation`.
    replace = vi.spyOn(archiveLinkNavigation, 'replace').mockImplementation(() => {});
  });

  afterEach(() => {
    replace.mockRestore();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    window.history.replaceState({}, '', '/');
  });

  it('снимает регистрацию service worker и повторяет переход с меткой ?swbypass=1', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
    });

    renderAt('/a/Mzs-9Q_toKen');

    expect(screen.getByText('Открываем архив…')).toBeInTheDocument();
    await waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(String(replace.mock.calls[0]![0])).toContain('/a/Mzs-9Q_toKen?swbypass=1');
  });

  it('без service worker в браузере — просто повторяет переход, не падая', async () => {
    renderAt('/a/tok');

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(String(replace.mock.calls[0]![0])).toContain('/a/tok?swbypass=1');
  });

  it('метка уже стоит — второго перехода нет (иначе вечный цикл), показываем ссылку на скачивание', async () => {
    renderAt('/a/tok?swbypass=1');

    const link = await screen.findByTestId('archive-link-download');
    expect(link).toHaveAttribute('href', '/a/tok?swbypass=1');
    expect(link).toHaveAttribute('download');
    expect(screen.queryByText('Открываем архив…')).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
