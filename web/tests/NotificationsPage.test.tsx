import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { NotificationsPage } from '../src/pages/NotificationsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { server } from '../src/mocks/server';
import { resetProfilesDb, setProfileAvatar } from '../src/mocks/profilesDb';

/** Контрагент пункта «Срок приёмки…» в сиде ленты (notificationsDb). */
const NOTIFICATION_COUNTERPARTY = 'pf-masterremont';

function renderPage(initialPath = '/notifications') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="*" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('NotificationsPage (DEV-14) — критерии приёмки §10/§11', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    localStorage.clear();
  });

  // Фото живёт в общем profilesDb — сбрасываем, чтобы соседние тесты видели
  // сид без картинок.
  afterEach(() => {
    resetProfilesDb();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('пункт: тип→иконка/severity, unread-стиль, due — жирный заголовок', async () => {
    renderPage();
    const dueItem = await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    const row = dueItem.closest('[data-testid="notification-item"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(dueItem.closest('b')).not.toBeNull();
  });

  it('симметрия: один факт — одинаковый title; слова-действия в строке нет (§4 ⭐, финал доска A)', async () => {
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    const titles = screen.getAllByText('Этап сдан на приёмку');
    expect(titles).toHaveLength(2);
    const rows = titles.map((el) => el.closest<HTMLElement>('[data-testid="notification-item"]')!);
    // Финал доска A (03.09): действие несёт тап по пункту (и колонка деталей
    // на десктопе), словом в строке оно больше не стоит — ни у заказчика,
    // ни у исполнителя.
    const actionLabels = rows.map((r) => within(r).queryByText('Принять этап'));
    expect(actionLabels.filter(Boolean)).toHaveLength(0);
  });

  // DEV-20_2 §2 (финал доска A), подтверждено владельцем 01.09: в строке стоит
  // НАЗВАНИЕ договора, номер виден в карточке. Отсмотр 2026-08-19 выбирал
  // «контрагент · №», но номер тогда не предпочли названию — его добавили,
  // потому что ссылки на договор в строке не было вовсе (коммит ef7d7dd7).
  // Номер остаётся у безымянного договора, и подставляет его бэкенд:
  // `"title": contract.title or f"№ {number}"` (notifications/selectors.py).
  it('мета пункта — «контрагент · название договора»; без названия — № (ADR-098)', async () => {
    renderPage();
    const title = await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    const row = title.closest<HTMLElement>('[data-testid="notification-item"]')!;
    expect(within(row).getByText(/Ремонт кухни/)).toBeInTheDocument();
    expect(within(row).queryByText(/№ [A-F]\d+/)).toBeNull();
  });

  // ADR-173 (владелец 08.09): лид пункта — ФОТО контрагента, если оно есть и
  // зрителю можно; иначе остаются инициалы. Фото подставляется на чтении
  // ленты (ссылка версионируется, в снимке события протухла бы).
  it('лид пункта: фото контрагента картинкой, без фото — инициалы', async () => {
    const initials = renderPage();
    const row = (await screen.findByText('Срок приёмки этапа истекает через 2 часа')).closest<HTMLElement>(
      '[data-testid="notification-item"]',
    )!;
    expect(row.querySelector('img')).toBeNull();
    initials.unmount();

    setProfileAvatar(NOTIFICATION_COUNTERPARTY, new Uint8Array([1, 2, 3]), 'image/png');
    renderPage();
    const withPhoto = (await screen.findByText('Срок приёмки этапа истекает через 2 часа')).closest<HTMLElement>(
      '[data-testid="notification-item"]',
    )!;
    expect(withPhoto.querySelector('img')?.getAttribute('src')).toContain(
      `/v1/profiles/${NOTIFICATION_COUNTERPARTY}/avatar`,
    );
  });

  it('пункт без названия договора — в мете остаётся № (фолбэк ADR-098)', async () => {
    server.use(
      http.get('*/v1/notifications', () =>
        HttpResponse.json({
          items: [
            {
              id: 'n-no-title',
              type: 'deadline',
              title: 'Срок приёмки этапа истекает',
              contract: { id: 'c-778', number: 'X778' },
              severity: 'due',
              created_at: new Date().toISOString(),
              read: false,
              group: 'today',
            },
          ],
          unread_count: 1,
          groups: { deals: 0, chats: 0, payments: 0, deadlines: 1, disputes: 0 },
          next_cursor: null,
          total: 1,
        }),
      ),
    );
    renderPage();
    const title = await screen.findByText('Срок приёмки этапа истекает');
    const row = title.closest<HTMLElement>('[data-testid="notification-item"]')!;
    expect(within(row).getByText(/№ X778/)).toBeInTheDocument();
  });

  it('пункт без action, но с договором — фолбэк-переход на карточку (ADR-098)', async () => {
    server.use(
      http.get('*/v1/notifications', () =>
        HttpResponse.json({
          items: [
            {
              id: 'n-x1',
              type: 'contract',
              title: 'Договор подписан',
              contract: { id: 'c-777', number: 'X777' },
              severity: 'good',
              created_at: new Date().toISOString(),
              read: true,
              group: 'today',
            },
          ],
          unread_count: 0,
          groups: { deals: 0, chats: 0, payments: 0, deadlines: 0, disputes: 0 },
          next_cursor: null,
          total: 1,
        }),
      ),
    );
    renderPage();
    await userEvent.click(await screen.findByText('Договор подписан'));
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
  });

  it('клик по пункту → отмечает прочитанным + переходит по action.href', async () => {
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    // Финал доска A: слова-действия в строке нет — тап по самому пункту.
    await userEvent.click(screen.getByText('Договор ждёт вашей подписи'));
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
  });

  it('складка «Чаты» (отсмотр 2026-08-24): категория в воронке, фильтр chats уходит на бэк', async () => {
    const filters: string[] = [];
    server.use(
      http.get('/v1/notifications', ({ request }) => {
        const filter = new URL(request.url).searchParams.get('filter') ?? 'all';
        filters.push(filter);
        const chat = {
          id: 'n-chat-1',
          type: 'message',
          title: 'Новое сообщение в чате',
          severity: 'info',
          created_at: new Date().toISOString(),
          read: false,
          group: 'today',
          contract: { id: 'c-1', number: 'РК-1' },
        };
        const deal = { ...chat, id: 'n-deal-1', type: 'signature', title: 'Подпишите договор', severity: 'due' };
        const items = filter === 'chats' ? [chat] : [chat, deal];
        return HttpResponse.json({
          items,
          unread_count: 2,
          groups: { deals: 1, chats: 1, payments: 0, deadlines: 0, disputes: 0 },
          next_cursor: null,
          total: items.length,
        });
      }),
    );
    renderPage();
    // DEV-20_2 §3: в строке вкладок только «Все» и «Новые», категории ленты
    // (в т.ч. «Чаты») выбираются в шите по воронке — полоса вкладок не
    // скроллится вбок ни на какой ширине.
    await screen.findByTestId('tab-all');
    expect(screen.queryByTestId('tab-chats')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('open-filters'));
    await userEvent.selectOptions(await screen.findByTestId('filters-category'), 'chats');
    await userEvent.click(screen.getByTestId('filters-apply'));
    await waitFor(() => expect(filters).toContain('chats'));
    await waitFor(() => expect(screen.queryByText('Подпишите договор')).not.toBeInTheDocument());
    expect(screen.getByText('Новое сообщение в чате')).toBeInTheDocument();
  });

  it('«Прочитать все» — счётчик 0, кнопка неактивна', async () => {
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    const btn = screen.getByRole('button', { name: 'Прочитать все' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it('фильтр «Непрочитанные» — прочитанные пункты скрыты', async () => {
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    expect(screen.getByText('Оплата этапа получена')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    await waitFor(() => expect(screen.queryByText('Оплата этапа получена')).not.toBeInTheDocument());
    expect(screen.getByText('Срок приёмки этапа истекает через 2 часа')).toBeInTheDocument();
  });

  it('PushPromo: видна при push=false и permission≠denied; «✕» скрывает и запоминает локально', async () => {
    renderPage();
    const promoText = await screen.findByText('Разрешите отправлять уведомления, чтобы не пропустить сроки');
    expect(promoText).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    await waitFor(() =>
      expect(screen.queryByText('Разрешите отправлять уведомления, чтобы не пропустить сроки')).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem('porukam.pushPromoDismissed')).toBe('1');
  });

  /* ADR-175: «push включён» на сервере само по себе полосу больше не прячет —
     серверный флаг приходит `true` по умолчанию, и на этом молчании выросли
     пять аккаунтов без единой подписки (прод 10.09). Прячет её РАБОЧАЯ подписка
     на этом устройстве, поэтому тест стал стабить устройство. */
  it('PushPromo не показывается, если push включён И подписка на устройстве жива', async () => {
    server.use(
      http.get('/v1/notification-settings', () =>
        HttpResponse.json({
          in_app: true,
          push: true,
          push_permission: 'granted',
          email: false,
          email_address: 'a@b.c',
          groups: { deals: true, payments: true, deadlines: true, disputes: true },
        }),
      ),
    );
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class FakePushManager {});
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: 'https://push.example/abc' }) },
        }),
      },
      configurable: true,
    });
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    expect(screen.queryByText('Разрешите отправлять уведомления, чтобы не пропустить сроки')).not.toBeInTheDocument();
    expect(screen.queryByText('Разрешите уведомления на этом устройстве, чтобы не пропустить сроки')).not.toBeInTheDocument();
  });

  it('пустая лента — «пока пусто»', async () => {
    server.use(
      http.get('/v1/notifications', () =>
        HttpResponse.json({
          items: [],
          unread_count: 0,
          groups: { deals: 0, chats: 0, payments: 0, deadlines: 0, disputes: 0 },
          next_cursor: null,
          total: 0,
        }),
      ),
    );
    renderPage();
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument();
  });

  it('ошибка загрузки — доменный код и повтор', async () => {
    server.use(
      http.get('/v1/notifications', () =>
        HttpResponse.json({ status: 500, code: 'internal_error', title: 'internal_error' }, { status: 500 }),
      ),
    );
    renderPage();
    expect(await screen.findByText('Не удалось загрузить уведомления')).toBeInTheDocument();
    expect(screen.getByText('code: internal_error')).toBeInTheDocument();
  });

  it('платформо-нейтральные ключи push — в строках нет «браузер»/«web»', async () => {
    renderPage();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    await userEvent.click(screen.getByRole('button', { name: 'Включить' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent ?? '').not.toMatch(/браузер|\bweb\b/i);
  });

  /* Решение владельца 05.09: «пусть штук 15 висят, далее кнопка "показать
     ещё". а то список до бесконечности получился». В моке 22 пункта:
     15 + «Показать ещё 7» + конец без кнопки. */
  describe('пагинация ленты — 15 + «Показать ещё»', () => {
    it('первая страница — 15 пунктов, кнопка со счётом оставшихся', async () => {
      renderPage();
      await screen.findByText('Срок приёмки этапа истекает через 2 часа');
      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(15));
      expect(screen.getByTestId('notifications-show-more')).toHaveTextContent('Показать ещё 7 уведомлений');
    });

    it('«Показать ещё» дописывает следующую страницу вниз; на конце кнопки нет', async () => {
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(15));
      const first = screen.getAllByTestId('notification-item')[0];

      await userEvent.click(screen.getByTestId('notifications-show-more'));

      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(22));
      // Дозагрузка идёт ВНИЗ — верх списка не перерисовывается (нет прыжка).
      expect(screen.getAllByTestId('notification-item')[0]).toBe(first);
      expect(screen.queryByTestId('notifications-show-more')).not.toBeInTheDocument();
    });

    it('смена фильтра начинает ленту заново — догруженная страница не протекает', async () => {
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(15));
      await userEvent.click(screen.getByTestId('notifications-show-more'));
      await waitFor(() => expect(screen.getByText('Этап 1 принят заказчиком')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));

      await waitFor(() => expect(screen.queryByText('Этап 1 принят заказчиком')).not.toBeInTheDocument());
      expect(screen.getAllByTestId('notification-item')).toHaveLength(5);
      expect(screen.queryByTestId('notifications-show-more')).not.toBeInTheDocument();
    });

    it('«Прочитать все» не теряет догруженные страницы (обновление кэша на месте)', async () => {
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(15));
      await userEvent.click(screen.getByTestId('notifications-show-more'));
      await waitFor(() => expect(screen.getAllByTestId('notification-item')).toHaveLength(22));

      await userEvent.click(screen.getByRole('button', { name: 'Прочитать все' }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Прочитать все' })).toBeDisabled());
      expect(screen.getAllByTestId('notification-item')).toHaveLength(22);
    });
  });
});
