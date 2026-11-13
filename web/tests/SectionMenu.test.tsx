import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SectionMenu } from '../src/features/shell/SectionMenu';

/** Мобильное меню разделов (отсмотр 2026-08-24): заголовок-кнопка →
 * выпадающий список всех разделов, текущий с галочкой, выбор ведёт по пути. */

function Probe(): JSX.Element {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderMenu(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Probe />
      <Routes>
        <Route
          path="*"
          element={
            <SectionMenu
              title="Главная"
              label="Разделы"
              items={[
                { to: '/', label: 'Главная', icon: 'home', active: true },
                { to: '/notifications', label: 'Уведомления', icon: 'bell', badge: 5 },
                { to: '/groups', label: 'Объединения', icon: 'share' },
              ]}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SectionMenu', () => {
  it('кнопка-заголовок открывает список разделов; текущий отмечен, бейджи видны, выбор переводит', async () => {
    renderMenu();
    const trigger = screen.getByTestId('section-menu-trigger');
    expect(trigger).toHaveTextContent('Главная');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    const list = screen.getByTestId('section-menu-list');
    expect(within(list).getByTestId('section-menu-item-home')).toHaveAttribute('aria-checked', 'true');
    expect(within(list).getByTestId('section-menu-item-notifications')).toHaveTextContent('5');
    await userEvent.click(within(list).getByTestId('section-menu-item-groups'));
    expect(screen.getByTestId('path')).toHaveTextContent('/groups');
    expect(screen.queryByTestId('section-menu-list')).not.toBeInTheDocument();
  });

  it('Escape закрывает меню', async () => {
    renderMenu();
    await userEvent.click(screen.getByTestId('section-menu-trigger'));
    expect(screen.getByTestId('section-menu-list')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('section-menu-list')).not.toBeInTheDocument();
  });
});
