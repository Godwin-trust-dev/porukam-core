import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { NotificationsPage } from '../src/pages/NotificationsPage';
import { NotificationsSettingsPage } from '../src/pages/settings/NotificationsSettingsPage';
import { AppSettingsPage } from '../src/pages/settings/AppSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { usePushDeviceStore } from '../src/features/notifications/pushDeviceStore';
import { server } from '../src/mocks/server';

/**
 * Разрешение спрашивают ПО-УСТРОЙСТВЕННО, сбои подписки видны (ADR-175).
 *
 * До этой правки новому человеку разрешение не предлагали никогда: серверный
 * `push` приходит `true`, поэтому промо-полоса была скрыта («уже включено»), а
 * тумблер стоял в положении «вкл». Второе устройство того же человека тоже
 * молчало. Прод 10.09: пять активных пользователей из семи — ноль подписок.
 */

const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZZoJvvJI';

function settingsResponse(patch: Record<string, unknown> = {}) {
  return {
    in_app: true,
    push: true,
    push_permission: 'default',
    email: false,
    email_address: 'a@b.c',
    groups: { deals: true, chats: true, payments: true, deadlines: true, disputes: true },
    ...patch,
  };
}

/** Серверные настройки — отдельный от устройства источник (в этом и была ловушка). */
function serverSettings(patch: Record<string, unknown> = {}): void {
  server.use(http.get('/v1/notification-settings', () => HttpResponse.json(settingsResponse(patch))));
}

function fakeSubscription() {
  return {
    endpoint: 'https://push.example/abc',
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

interface DeviceOptions {
  permission?: 'default' | 'granted' | 'denied';
  subscribed?: boolean;
  unsupported?: boolean;
}

function stubDevice({ permission = 'default', subscribed = false, unsupported }: DeviceOptions = {}) {
  if (unsupported) return { requestPermission: vi.fn() };
  const requestPermission = vi.fn().mockResolvedValue(permission === 'default' ? 'granted' : permission);
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('PushManager', class FakePushManager {});
  const subscription = subscribed ? fakeSubscription() : null;
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
          subscribe: vi.fn().mockResolvedValue(fakeSubscription()),
        },
      }),
    },
    configurable: true,
  });
  return { requestPermission };
}

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/notifications']}>
          <Routes>
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="*" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function renderSettings(which: 'notifications' | 'app' = 'notifications') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        {which === 'notifications' ? <NotificationsSettingsPage /> : <AppSettingsPage />}
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  localStorage.clear();
  usePushDeviceStore.setState({ lastSubscribeResult: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  usePushDeviceStore.setState({ lastSubscribeResult: null });
});

describe('промо-полоса ленты — спрашиваем на ЭТОМ устройстве (ADR-175)', () => {
  it('серверный push=true, но разрешения здесь не спрашивали — полоса есть, формулировка про устройство', async () => {
    serverSettings({ push: true });
    stubDevice({ permission: 'default' });
    renderFeed();
    expect(
      await screen.findByText('Разрешите уведомления на этом устройстве, чтобы не пропустить сроки'),
    ).toBeInTheDocument();
  });

  it('разрешение выдано и подписка жива — полосы нет', async () => {
    serverSettings({ push: true, push_permission: 'granted' });
    stubDevice({ permission: 'granted', subscribed: true });
    renderFeed();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    expect(screen.queryByText(/Разрешите уведомления на этом устройстве/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Разрешите отправлять уведомления/)).not.toBeInTheDocument();
  });

  it('отказ на этом устройстве — полосы нет (переспросить нельзя)', async () => {
    serverSettings({ push: false });
    stubDevice({ permission: 'denied' });
    renderFeed();
    await screen.findByText('Срок приёмки этапа истекает через 2 часа');
    expect(screen.queryByText(/Разрешите/)).not.toBeInTheDocument();
  });

  it('разрешение запрашивается ТОЛЬКО по нажатию (§5 «мягкий момент»)', async () => {
    serverSettings({ push: true });
    const { requestPermission } = stubDevice({ permission: 'default' });
    renderFeed();
    await screen.findByText('Разрешите уведомления на этом устройстве, чтобы не пропустить сроки');
    expect(requestPermission).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Включить' }));
    await screen.findByRole('dialog');
    expect(requestPermission).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
  });
});

describe('подсказка под тумблером — статус устройства (ADR-175)', () => {
  it('не запрошено при включённом на сервере тумблере — «Включить на этом устройстве» открывает тот же шит', async () => {
    serverSettings({ push: true });
    stubDevice({ permission: 'default' });
    renderSettings();
    expect(await screen.findByText('На этом устройстве: разрешение не запрошено')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('push-enable-here'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Разрешить уведомления');
  });

  it('разрешение есть и подписка жива — «уведомления включены», чинить нечего', async () => {
    serverSettings({ push: true, push_permission: 'granted' });
    stubDevice({ permission: 'granted', subscribed: true });
    renderSettings();
    expect(await screen.findByText('На этом устройстве: уведомления включены')).toBeInTheDocument();
    expect(screen.queryByTestId('push-enable-here')).not.toBeInTheDocument();
    expect(screen.queryByTestId('push-retry')).not.toBeInTheDocument();
    // Единственное действие здесь — ручная сверка «Проверить сейчас» (10.09):
    // она заменяет выход из аккаунта и повторный вход (tests/pushResubscribe).
    expect(screen.getByTestId('push-recheck')).toBeInTheDocument();
  });

  it('отказ на устройстве — «отклонено в настройках устройства», тумблер неактивен', async () => {
    serverSettings({ push: false, push_permission: 'granted' });
    stubDevice({ permission: 'denied' });
    renderSettings();
    expect(await screen.findByText('На этом устройстве: отклонено в настройках устройства')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Push-уведомления' })).toBeDisabled());
  });

  it('устройство не умеет push — «не поддерживаются»', async () => {
    serverSettings({ push: true });
    stubDevice({ unsupported: true });
    renderSettings();
    expect(await screen.findByText('На этом устройстве: уведомления не поддерживаются')).toBeInTheDocument();
  });

  it('разрешение есть, подписки нет — причина сбоя и «Повторить» с новой причиной', async () => {
    serverSettings({ push: true, push_permission: 'granted' });
    stubDevice({ permission: 'granted', subscribed: false });
    renderSettings();
    // Попытки в этой вкладке ещё не было — честно называем самый вероятный отказ.
    expect(
      await screen.findByText('На этом устройстве: не удалось включить — устройство отказало в подключении'),
    ).toBeInTheDocument();

    // Мок отдаёт пустой ключ (инсталляция без Web Push) — повтор обязан
    // ПОКАЗАТЬ эту причину, а не промолчать, как делал `false` до ADR-175.
    await userEvent.click(screen.getByTestId('push-retry'));
    expect(
      await screen.findByText('На этом устройстве: не удалось включить — сервер не выдал ключ подключения'),
    ).toBeInTheDocument();
  });

  it('результат сверки из оболочки виден в настройках — причина и текст устройства', async () => {
    serverSettings({ push: true, push_permission: 'granted' });
    stubDevice({ permission: 'granted', subscribed: false });
    usePushDeviceStore.setState({
      lastSubscribeResult: { ok: false, reason: 'register_failed', message: 'HttpError: 500' },
    });
    renderSettings();
    expect(
      await screen.findByText('На этом устройстве: не удалось включить — подключение не удалось сохранить'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('push-device-detail')).toHaveTextContent('HttpError: 500');
  });

  it('успешный повтор снимает жалобу — «уведомления включены»', async () => {
    serverSettings({ push: true, push_permission: 'granted' });
    server.use(http.get('/v1/push/config', () => HttpResponse.json({ vapid_public_key: VAPID })));
    let subscribed = false;
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', class FakePushManager {});
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockImplementation(() => Promise.resolve(subscribed ? fakeSubscription() : null)),
            subscribe: vi.fn().mockImplementation(() => {
              subscribed = true;
              return Promise.resolve(fakeSubscription());
            }),
          },
        }),
      },
      configurable: true,
    });
    renderSettings();
    await userEvent.click(await screen.findByTestId('push-retry'));
    expect(await screen.findByText('На этом устройстве: уведомления включены')).toBeInTheDocument();
  });

  it('настройки «Приложение» показывают ту же строку состояния', async () => {
    serverSettings({ push: true });
    stubDevice({ permission: 'default' });
    renderSettings('app');
    expect(await screen.findByText('На этом устройстве: разрешение не запрошено')).toBeInTheDocument();
  });
});
