import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ProfileSettingsPage } from '../src/pages/settings/ProfileSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';

/**
 * Виды работ в профиле (ADR-190/191) — `WorkTypeChipsEditor` под
 * `SphereChipsEditor`, сохранение полем `work_type_codes` тем же
 * `PATCH /profiles/{id}`, что и сферы. Раскладка/URL-фильтр той же панели
 * в поиске — `SearchCatalogFilters.test.tsx`; здесь — профиль.
 */

function renderProfileSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  const router = createMemoryRouter([{ path: '/', element: <ProfileSettingsPage /> }], { initialEntries: ['/'] });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.getState().reset();
});

describe('ProfileSettingsPage — виды работ (ADR-190/191)', () => {
  it('без сфер блока видов работ нет; после выбора сферы разворачивается её список, множественный выбор', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');

    // Сид `pf-person-1` — sphere_codes: [] — блока видов работ нет вовсе.
    expect(screen.queryByTestId('profile-work-types')).not.toBeInTheDocument();

    // Пикер сфер уже развёрнут (список пуст, `SphereChipsEditor` открывается сам).
    await userEvent.click(await screen.findByTestId('sphere-repair'));

    const workTypesBlock = await screen.findByTestId('profile-work-types');
    const group = within(workTypesBlock).getByTestId('profile-work-types-group-repair');
    expect(within(group).getByText('Ремонт кухни')).toBeInTheDocument();

    await userEvent.click(within(group).getByTestId('work-type-repair.repair_kitchen'));
    await userEvent.click(within(group).getByTestId('work-type-repair.repair_bathroom'));
    expect(within(group).getByTestId('work-type-repair.repair_kitchen')).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByTestId('work-type-repair.repair_bathroom')).toHaveAttribute('aria-pressed', 'true');
  });

  it('сохранённые виды работ видны при повторном заходе на страницу', async () => {
    const { unmount } = renderProfileSettings();
    await screen.findByLabelText('Город');

    await userEvent.click(await screen.findByTestId('sphere-repair'));
    const group = await screen.findByTestId('profile-work-types-group-repair');
    await userEvent.click(within(group).getByTestId('work-type-repair.repair_kitchen'));

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByText('Сохранено')).toBeInTheDocument());

    unmount();
    renderProfileSettings();
    await screen.findByLabelText('Город');
    const groupAgain = await screen.findByTestId('profile-work-types-group-repair');
    expect(within(groupAgain).getByTestId('work-type-repair.repair_kitchen')).toHaveAttribute('aria-pressed', 'true');
  });

  it('снятие сферы сразу прячет и её виды работ, ДО сохранения', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');

    await userEvent.click(await screen.findByTestId('sphere-repair'));
    await screen.findByTestId('profile-work-types-group-repair');
    await userEvent.click(within(screen.getByTestId('profile-work-types-group-repair')).getByTestId('work-type-repair.repair_kitchen'));

    // Снимаем сферу «Ремонт и строительство» через чип.
    const sphereBlock = screen.getByTestId('profile-spheres');
    await userEvent.click(within(sphereBlock).getByRole('button', { name: /Убрать сферу/ }));

    await waitFor(() => expect(screen.queryByTestId('profile-work-types-group-repair')).not.toBeInTheDocument());
    // Блок видов работ пропадает целиком — не осталось ни одной сферы.
    expect(screen.queryByTestId('profile-work-types')).not.toBeInTheDocument();
  });

  it('422 `work_type_sphere_not_declared` — человекочитаемая ошибка, не крашится', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');
    await userEvent.click(await screen.findByTestId('sphere-repair'));
    const group = await screen.findByTestId('profile-work-types-group-repair');
    await userEvent.click(within(group).getByTestId('work-type-repair.repair_kitchen'));

    server.use(
      http.patch('/v1/profiles/:id', () =>
        HttpResponse.json(
          { status: 422, code: 'work_type_sphere_not_declared', title: 'work_type_sphere_not_declared', detail: 'сфера не заявлена' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(screen.getByTestId('work-types-save-error')).toHaveTextContent('Этот вид работ относится к сфере, которую вы не добавили — сначала добавьте сферу.'),
    );
  });

  it('422 `invalid_work_type` — человекочитаемая ошибка', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');
    await userEvent.click(await screen.findByTestId('sphere-repair'));
    const group = await screen.findByTestId('profile-work-types-group-repair');
    await userEvent.click(within(group).getByTestId('work-type-repair.repair_kitchen'));

    server.use(
      http.patch('/v1/profiles/:id', () =>
        HttpResponse.json(
          { status: 422, code: 'invalid_work_type', title: 'invalid_work_type', detail: 'неизвестный вид работ' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByTestId('work-types-save-error')).toHaveTextContent('Этот вид работ недоступен для выбора.'));
  });

  it('422 `profile_work_types_limit` — человекочитаемая ошибка', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');
    await userEvent.click(await screen.findByTestId('sphere-repair'));
    const group = await screen.findByTestId('profile-work-types-group-repair');
    await userEvent.click(within(group).getByTestId('work-type-repair.repair_kitchen'));

    server.use(
      http.patch('/v1/profiles/:id', () =>
        HttpResponse.json(
          { status: 422, code: 'profile_work_types_limit', title: 'profile_work_types_limit', detail: 'не больше 30' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByTestId('work-types-save-error')).toHaveTextContent('Не больше 30 видов работ'));
  });
});

/**
 * Мок как зеркало бэкенда (web/CLAUDE.md §3), не заглушка — тот же PATCH
 * `/v1/profiles/:id`, БЕЗ `server.use`-подмены: проверяем, что
 * `profilesDb.patchProfileSettings` сам воспроизводит инварианты ADR-190
 * (сфера обязана быть заявлена, код обязан существовать в справочнике,
 * лимит 30), не только что UI умеет показать текст чужой подмены.
 */
describe('Мок PATCH /profiles/{id} — реальная валидация work_type_codes (ADR-190)', () => {
  async function patchProfile(body: Record<string, unknown>): Promise<Response> {
    return fetch('/v1/profiles/pf-person-1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer a', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('вид работ без заявленной сферы — 422 work_type_sphere_not_declared', async () => {
    const res = await patchProfile({ work_type_codes: ['repair.repair_kitchen'] }); // sphere_codes профиля пуст
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('work_type_sphere_not_declared');
  });

  it('неизвестный код категории при заявленной сфере — 422 invalid_work_type', async () => {
    const res = await patchProfile({ sphere_codes: ['repair'], work_type_codes: ['repair.no_such_category'] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('invalid_work_type');
  });

  it('больше 30 видов работ — 422 profile_work_types_limit', async () => {
    const res = await patchProfile({ sphere_codes: ['repair'], work_type_codes: Array.from({ length: 31 }, (_, i) => `repair.fake_${i}`) });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('profile_work_types_limit');
  });

  it('валидный код реальной сферы — принимается и возвращается обратно', async () => {
    const res = await patchProfile({ sphere_codes: ['repair'], work_type_codes: ['repair.repair_kitchen'] });
    expect(res.status).toBe(200);
    expect((await res.json()).work_type_codes).toEqual(['repair.repair_kitchen']);
  });

  it('сужение sphere_codes БЕЗ явного work_type_codes в том же PATCH — осиротевшие коды обрезаются молча', async () => {
    await patchProfile({ sphere_codes: ['repair', 'plumbing'], work_type_codes: ['repair.repair_kitchen', 'plumbing.plumbing_install'] });
    const res = await patchProfile({ sphere_codes: ['plumbing'] }); // repair выпала из списка
    expect(res.status).toBe(200);
    expect((await res.json()).work_type_codes).toEqual(['plumbing.plumbing_install']);
  });
});
