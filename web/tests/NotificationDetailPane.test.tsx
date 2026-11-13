import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { Notification } from '@porukam/core';
import { createI18n, loadLocaleResources } from '@porukam/i18n';

import { NotificationDetailPane } from '../src/features/notifications/NotificationDetailPane';

function item(over: Partial<Notification>): Notification {
  return {
    id: 'n-1',
    type: 'signature',
    title: 'Договор подписан',
    severity: 'info',
    created_at: '2026-08-21T10:00:00Z',
    read: false,
    group: 'today',
    ...over,
  } as Notification;
}

async function renderPane(n: Notification) {
  const i18n = createI18n('ru');
  await loadLocaleResources(i18n, 'ru');
  return render(
    <I18nextProvider i18n={i18n}>
      <NotificationDetailPane notification={n} icon="bell" onOpen={vi.fn()} />
    </I18nextProvider>,
  );
}

// Отсмотр 2026-08-21: в правой панели — одна жёлтая кнопка «Открыть» у всех
// уведомлений. Бэк отдаёт action.label="" → подпись не должна быть пустой.
describe('NotificationDetailPane — единственное действие', () => {
  it('пустой action.label с бэка → «Открыть», второй кнопки нет', async () => {
    await renderPane(
      item({ action: { label: '', href: '/contracts/c-1' }, contract: { id: 'c-1', number: '14001' } } as Partial<Notification>),
    );
    expect(screen.getByTestId('notification-pane-open')).toHaveTextContent('Открыть');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('свой label действия сохраняется', async () => {
    await renderPane(item({ action: { label: 'Принять этап', href: '/x' } } as Partial<Notification>));
    expect(screen.getByTestId('notification-pane-open')).toHaveTextContent('Принять этап');
  });
});
