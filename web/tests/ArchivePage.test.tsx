import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import { ArchivePage } from '../src/pages/ArchivePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';
import { server } from '../src/mocks/server';

/**
 * Экспорт архива сделки на реальном контракте `apps.archive` (ADR-139,
 * DEV-12 §12): превью + `exports[]`, POST → 202 + поллинг до `ready|failed`,
 * два артефакта (пакет бессрочно / файлы по сроку), ссылки сторон, retention.
 */
function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/archive" element={<ArchivePage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

describe('ArchivePage (DEV-12 + ADR-139)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-viewer', kind: 'person', display_name: 'Смотрящий', handle: '@viewer', verification_level: 'basic', has_business_status: false },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('реальный контур (rc-*): превью строится из данных сделки — заглушки больше нет', async () => {
    renderPage('/contracts/rc-progress-1/archive');
    expect(await screen.findByTestId('archive-header')).toBeInTheDocument();
    expect(screen.queryByText('Экспорт архива пока недоступен')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-cta')).toHaveTextContent('Собрать снимок');
    expect(screen.getByTestId('package-preview')).toHaveTextContent('Договор и все версии');
  });

  it('закрытый: автоэкспорт «выдан при завершении сделки», два артефакта — пакет (бессрочно, sha256) и файлы (до даты)', async () => {
    renderPage('/contracts/c-9301/archive');
    expect(await screen.findByTestId('archive-header')).toHaveTextContent('№ 2026-0301');

    const row = screen.getByTestId('export-row');
    expect(row).toHaveAttribute('data-trigger', 'auto');
    expect(row).toHaveTextContent('Выдан при завершении сделки');
    expect(row).toHaveTextContent('Готов');

    const pkg = screen.getByTestId('artifact-package');
    expect(within(pkg).getByText('Бессрочно')).toBeInTheDocument();
    expect(within(pkg).getByTestId('package-sha256').textContent).toMatch(/^[0-9a-f]{64}$/);
    const dl = within(pkg).getByTestId('download-package');
    expect(dl.tagName).toBe('A');
    expect(dl).toHaveAttribute('href', expect.stringContaining('/a/'));
    expect(dl).toHaveTextContent('Скачать пакет');

    const files = screen.getByTestId('artifact-files');
    expect(files).toHaveAttribute('data-state', 'available');
    expect(within(files).getByTestId('download-files')).toHaveAttribute('href', expect.stringContaining('/a/'));
    expect(within(files).getByText(/Хранятся до/)).toBeInTheDocument();

    // PDF — только «скоро», кнопки скачивания PDF нет.
    expect(screen.getByTestId('format-pdf')).toHaveTextContent('Скоро');
    expect(screen.queryByTestId('download-pdf')).not.toBeInTheDocument();
    // Google Drive в UI больше нет.
    expect(document.body.textContent).not.toMatch(/Drive/);
  });

  it('Собрать заново → 202 → генерация (queued/running) → поллинг до ready → новый экспорт с пакетом', async () => {
    renderPage('/contracts/c-9303/archive');
    await screen.findByTestId('archive-header');
    expect(screen.getByTestId('snapshot-note')).toBeInTheDocument();
    expect(screen.getByText('Экспортов пока нет — соберите первый')).toBeInTheDocument();

    const cta = screen.getByTestId('export-cta');
    expect(cta).toHaveTextContent('Собрать снимок');
    await userEvent.click(cta);

    await screen.findByTestId('generating-state');
    expect(screen.queryByTestId('export-cta')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ready-state')).toBeInTheDocument(), { timeout: 8000 });
    expect(screen.getByTestId('download-package')).toBeInTheDocument();
    const row = screen.getByTestId('export-row');
    expect(row).toHaveAttribute('data-status', 'ready');
    expect(row).toHaveAttribute('data-trigger', 'manual');
    expect(row).toHaveTextContent('Снимок');
    expect(screen.getByTestId('export-cta')).toHaveTextContent('Собрать снимок');
  });

  it('«Только манифест» → файлы не запрашивались (zip: null), пакет есть', async () => {
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    await userEvent.click(screen.getByRole('radio', { name: /Только манифест/ }));
    await userEvent.click(screen.getByTestId('export-cta'));
    await screen.findByTestId('generating-state');
    await waitFor(() => expect(screen.getAllByTestId('export-row')[0]).toHaveAttribute('data-status', 'ready'), { timeout: 8000 });
    const files = screen.getByTestId('artifact-files');
    expect(files).toHaveAttribute('data-state', 'not_requested');
    expect(within(files).getByText('Файлы не запрашивались — только манифест')).toBeInTheDocument();
    expect(within(files).queryByTestId('download-files')).not.toBeInTheDocument();
    expect(screen.getByTestId('download-package')).toBeInTheDocument();
  });

  it('409 archive_nothing_to_export на POST → понятный текст, экран не падает', async () => {
    server.use(
      http.post('/v1/contracts/c-9301/archive/export', () => problem(409, 'archive_nothing_to_export', 'Пока нечего собирать: договор ни разу не заморожен')),
    );
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    await userEvent.click(screen.getByTestId('export-cta'));
    expect(await screen.findByText('Собирать пока нечего: договор ни разу не был заморожен')).toBeInTheDocument();
    expect(screen.queryByTestId('generating-state')).not.toBeInTheDocument();
  });

  it('черновик без заморозки (can_export=false) → пусто, кнопки нет', async () => {
    renderPage('/contracts/c-9304/archive');
    expect(await screen.findByText('Пока нечего собирать')).toBeInTheDocument();
    expect(screen.queryByTestId('export-cta')).not.toBeInTheDocument();
  });

  it('сборка failed → ошибка с текстом бэка и «Повторить»', async () => {
    renderPage('/contracts/c-9305/archive');
    await screen.findByTestId('archive-header');
    await userEvent.click(screen.getByTestId('export-cta'));
    await screen.findByTestId('generating-state');
    // Текст ошибки — и в плашке сборки, и в строке списка экспортов.
    expect((await screen.findAllByText(/Сборка не удалась/, {}, { timeout: 8000 })).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.getByTestId('export-row')).toHaveAttribute('data-status', 'failed');
  });

  it('shredded: файлы удалены — дата и «пакет с хешами по-прежнему доступен», пакет скачивается; retention shredded', async () => {
    renderPage('/contracts/c-9302/archive');
    await screen.findByTestId('archive-header');
    const files = screen.getByTestId('artifact-files');
    expect(files).toHaveAttribute('data-state', 'shredded');
    expect(within(files).getByText(/Файлы удалены .+ по истечении срока хранения/)).toBeInTheDocument();
    expect(within(files).getByText(/Пакет с хешами по-прежнему доступен/)).toBeInTheDocument();
    expect(within(files).queryByTestId('download-files')).not.toBeInTheDocument();
    expect(screen.getByTestId('download-package')).toBeInTheDocument();
    expect(screen.getByTestId('archive-retention')).toHaveAttribute('data-state', 'shredded');
    expect(screen.getByTestId('archive-retention')).toHaveTextContent('оригиналы удалены');
  });

  it('ссылки сторон: свои — с адресом, копированием и счётчиком; чужой стороны — без url', async () => {
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    const links = screen.getAllByTestId('archive-link');
    expect(links).toHaveLength(4);
    const mine = links.filter((l) => l.getAttribute('data-mine') === 'true');
    const other = links.filter((l) => l.getAttribute('data-mine') === 'false');
    expect(mine).toHaveLength(2);
    expect(other).toHaveLength(2);
    expect(mine.every((l) => l.getAttribute('data-role') === 'customer')).toBe(true);
    // Отсмотр 03.09: адрес обязан быть КЛИКАБЕЛЬНЫМ, а не только копируемым.
    const url = within(mine[0]!).getByTestId('archive-link-url');
    expect(url).toHaveTextContent('/a/');
    expect(url.tagName).toBe('A');
    expect(url).toHaveAttribute('href', expect.stringContaining('/a/'));
    expect(url).toHaveAttribute('download');
    expect(within(mine[0]!).getByTestId('archive-link-copy')).toBeInTheDocument();
    expect(within(mine[0]!).getByText(/Обращений: 2/)).toBeInTheDocument();
    expect(within(mine[0]!).getByTestId('archive-link-revoke')).toBeInTheDocument();

    expect(other[0]).toHaveAttribute('data-role', 'contractor');
    expect(within(other[0]!).queryByTestId('archive-link-url')).not.toBeInTheDocument();
    expect(within(other[0]!).queryByTestId('archive-link-revoke')).not.toBeInTheDocument();
    expect(within(other[0]!).getByText(/Ссылка другой стороны/)).toBeInTheDocument();
  });

  it('отзыв ссылки: подтверждение → POST /archive/links/{id}/revoke → «Отозвана», url исчез', async () => {
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    const mine = screen.getAllByTestId('archive-link').filter((l) => l.getAttribute('data-mine') === 'true');
    await userEvent.click(within(mine[0]!).getByTestId('archive-link-revoke'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Отозвать ссылку?');
    await userEvent.click(screen.getByTestId('archive-link-revoke-confirm'));

    await waitFor(() => {
      const revoked = screen.getAllByTestId('archive-link').filter((l) => l.getAttribute('data-revoked') === 'true');
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toHaveAttribute('data-kind', 'package');
      expect(within(revoked[0]!).queryByTestId('archive-link-url')).not.toBeInTheDocument();
      expect(within(revoked[0]!).getByText(/Отозвана/)).toBeInTheDocument();
    });
    // Пакет по отозванной ссылке скачать нельзя — подсказка «соберите заново».
    expect(screen.getByTestId('package-link-revoked')).toBeInTheDocument();
    expect(screen.queryByTestId('download-package')).not.toBeInTheDocument();
  });

  it('обе роли видят одинаковое превью — симметрия, нет ролевого гейта', async () => {
    const { unmount } = renderPage('/contracts/c-9301/archive');
    const asCustomer = (await screen.findByTestId('package-preview')).textContent;
    unmount();

    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-9301/archive');
    const asContractor = (await screen.findByTestId('package-preview')).textContent;

    expect(asCustomer).toBe(asContractor);
  });

  it('сроки хранения: идущая сделка — таймер не запущен; закрытая — даты + общий RetentionNotice', async () => {
    renderPage('/contracts/c-9303/archive');
    await screen.findByTestId('archive-header');
    expect(screen.getByTestId('archive-retention')).toHaveAttribute('data-state', 'none');
    expect(screen.getByTestId('archive-retention')).toHaveTextContent('отсчёт срока хранения файлов начнётся после её окончания');
    expect(screen.getByTestId('retention-notice')).toHaveAttribute('data-variant', 'compact');
  });

  it('шаги проверки повторяют часть 2 README: команда на каждую систему + что означают OK/FAILED', async () => {
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    const panel = screen.getByTestId('verify-panel');
    expect(within(panel).queryByText('sha256sum -c SHA256SUMS')).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /Как это работает/ }));

    // Команды — те же, что печатает README.txt пакета (apps/archive/package.py).
    expect(within(panel).getByText('powershell -ExecutionPolicy Bypass -File .\\verify.ps1')).toBeInTheDocument();
    expect(within(panel).getByText('shasum -a 256 -c SHA256SUMS')).toBeInTheDocument();
    expect(within(panel).getByText('sha256sum -c SHA256SUMS')).toBeInTheDocument();
    expect(within(panel).getByText('--ignore-missing')).toBeInTheDocument();
    // Команда — код, а не копирайт: ltr даже в RTL-локалях.
    expect(within(panel).getByText('sha256sum -c SHA256SUMS')).toHaveAttribute('dir', 'ltr');
    expect(panel).toHaveTextContent('«OK»');
    expect(panel).toHaveTextContent('«FAILED»');
    expect(panel).toHaveTextContent('README.txt');
  });

  it('нет тарифов/пейвола и лексики Drive на экране', async () => {
    renderPage('/contracts/c-9301/archive');
    await screen.findByTestId('archive-header');
    expect(document.body.textContent).not.toMatch(/тариф|подписк|платный экспорт|Drive/i);
  });
});
