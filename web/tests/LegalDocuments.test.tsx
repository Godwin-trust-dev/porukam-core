import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n, loadLocaleResources } from '@porukam/i18n';
import { MarkdownDocument } from '@porukam/ui';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { server } from '../src/mocks/server';

/**
 * Юр-документы платформы на языке пользователя
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md §B/§4).
 */

async function renderWelcome(lng = 'en') {
  const i18n = createI18n(lng);
  await loadLocaleResources(i18n, lng);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/welcome']}>
          <WelcomePage />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { i18n, ...utils };
}

describe('Ссылки на юр-документы на /welcome (§B)', () => {
  it('«Privacy Policy» открывает документ, а не разворачивает дисклеймер', async () => {
    const user = userEvent.setup();
    await renderWelcome('en');

    await user.click(screen.getByRole('button', { name: 'Privacy Policy' }));

    const dialog = await screen.findByRole('dialog', { name: 'Privacy Policy' });
    expect(await within(dialog).findByText('Privacy Policy', { selector: 'h1' })).toBeInTheDocument();
    expect(within(dialog).getByText(/What we store/)).toBeInTheDocument();
  });

  it('«Terms of Service» открывает ИМЕННО условия, а не тот же текст, что политика', async () => {
    const user = userEvent.setup();
    await renderWelcome('en');

    await user.click(screen.getByRole('button', { name: 'Terms of Service' }));

    const dialog = await screen.findByRole('dialog', { name: 'Terms of Service' });
    expect(await within(dialog).findByText('Terms of Service', { selector: 'h1' })).toBeInTheDocument();
    expect(within(dialog).getByText(/What the Service is/)).toBeInTheDocument();
  });

  it('дисклеймер о юрсиле напечатан РОВНО один раз (был дубль: статикой + по каждой кнопке)', async () => {
    const user = userEvent.setup();
    await renderWelcome('en');
    // Именно UI-строка `auth.legalDisclaimerText` (укорочена по эталону доски B,
    // 03.09), а не похожая фраза из тела Условий («We record facts: who
    // signed…» — законная часть документа).
    const disclaimer = /Legal effect depends on your jurisdiction/;

    expect(screen.getAllByText(disclaimer)).toHaveLength(1);

    // Открытие документа не добавляет второй копии того же абзаца.
    await user.click(screen.getByRole('button', { name: 'Terms of Service' }));
    await screen.findByRole('dialog');
    expect(screen.getAllByText(disclaimer)).toHaveLength(1);
  });

  it('документ приходит на текущем языке интерфейса, с оговоркой об основной версии', async () => {
    const user = userEvent.setup();
    await renderWelcome('es');

    await user.click(screen.getByRole('button', { name: 'Política de privacidad' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Política de privacidad', { selector: 'h1' })).toBeInTheDocument();
    expect(within(dialog).getByText(/prevalece el texto inglés/)).toBeInTheDocument();
  });

  it('машинный перевод помечен тихо — словом-пометкой, без плашки-акцента', async () => {
    const user = userEvent.setup();
    await renderWelcome('es');

    await user.click(screen.getByRole('button', { name: 'Política de privacidad' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('traducción automática')).toBeInTheDocument();
  });

  it('язык человека без документа → английский текст + честное предупреждение о фолбэке', async () => {
    const user = userEvent.setup();
    // `de` есть в интерфейсе, но юр-документа на нём мок не знает → EN-фолбэк.
    await renderWelcome('de');

    await user.click(screen.getByRole('button', { name: 'Datenschutzerklärung' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Privacy Policy', { selector: 'h1' })).toBeInTheDocument();
    // Не молча: интерфейс говорит, что перевода документа пока нет.
    expect(within(dialog).getByRole('status')).toHaveTextContent(/englische Original|englischen Original/i);
  });

  it('ошибка загрузки документа — сообщение и повтор, не пустая шторка', async () => {
    server.use(http.get('/v1/legal/:doc', () => HttpResponse.json(null, { status: 500 })));
    const user = userEvent.setup();
    await renderWelcome('en');

    await user.click(screen.getByRole('button', { name: 'Privacy Policy' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(/Couldn't load the document/));
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('MarkdownDocument — подмножество разметки юр-документов', () => {
  it('заголовки, абзац с переводом строки, список, таблица, ссылка, жирный, код', () => {
    render(
      <MarkdownDocument
        source={[
          '# Заголовок',
          '',
          '**Сервис:** Porukam',
          '**Версия:** 1.0',
          '',
          '---',
          '',
          '## 1. Раздел',
          '',
          '| Данные | Зачем |',
          '|---|---|',
          '| Имя | Аккаунт |',
          '',
          '- Первый **важный** пункт',
          '- Второй с [ссылкой](https://example.org) и `drive.file`',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Заголовок' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '1. Раздел' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Данные' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Аккаунт' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('важный', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('drive.file', { selector: 'code' })).toBeInTheDocument();

    // Внешняя ссылка — в новой вкладке: человек не должен потерять открытый
    // документ и незавершённый онбординг.
    const link = screen.getByRole('link', { name: 'ссылкой' });
    expect(link).toHaveAttribute('href', 'https://example.org');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('шапка из нескольких строк остаётся ОДНИМ абзацем с переносами (а не склеенной строкой)', () => {
    const { container } = render(<MarkdownDocument source={'**Сервис:** Porukam\n**Версия:** 1.0\n'} />);

    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  it('markdown не превращается в HTML — теги в тексте остаются текстом', () => {
    const { container } = render(<MarkdownDocument source={'Обычный текст <script>alert(1)</script> дальше'} />);

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });
});
