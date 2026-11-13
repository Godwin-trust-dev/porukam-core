import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { SigningPage } from '../src/pages/SigningPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/sign" element={<SigningPage />} />
            <Route path="/contracts/:id" element={<div data-testid="detail-stub">detail</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('SigningPage (DEV-05) — приёмка §10; финмодель v2 (DEV-05-PATCH v2) — комиссии нет ни у кого', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      {
        id: 'pf-viewer',
        kind: 'person',
        display_name: 'Смотрящий',
        handle: '@viewer',
        verification_level: 'basic',
        has_business_status: false,
      },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('C2C: заказчик подписывает первым → «ждём вторую»; комиссии нет (§7)', async () => {
    renderPage('/contracts/c-3003/sign');
    expect(await screen.findByTestId('sign-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('commission-section')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sign-cta'));
    expect(await screen.findByText('Одна подпись есть — ждём вторую')).toBeInTheDocument();
  });

  it('C2C: обе подписи → церемония «по рукам» (искра только здесь)', async () => {
    renderPage('/contracts/c-3003/sign');
    await userEvent.click(await screen.findByTestId('sign-cta'));
    await screen.findByText('Одна подпись есть — ждём вторую');

    useViewerStore.getState().setViewAs('contractor');
    await userEvent.click(await screen.findByTestId('sign-cta'));

    expect(await screen.findByText('По рукам!')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть договор' }));
  });

  it('исполнитель-бизнес: та же одна кнопка «Подписать», раздела «Комиссия» нет → signed → церемония', async () => {
    // Сид c-3004: заказчик уже подписал — исполнителю остаётся одна подпись.
    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-3004/sign');

    expect(await screen.findByTestId('sign-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('commission-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('go-pay-and-sign')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('sign-cta'));

    expect(await screen.findByText('По рукам!')).toBeInTheDocument();
  });

  it('заказчику никогда не показывается CommissionSection, даже на бывшем платном сегменте (§7)', async () => {
    renderPage('/contracts/c-3004/sign');
    await screen.findByText('Одна подпись есть — ждём вторую');
    expect(screen.queryByTestId('commission-section')).not.toBeInTheDocument();
  });

  it('«Заключение договора — бесплатно» видно обеим сторонам (финмодель v2)', async () => {
    renderPage('/contracts/c-3003/sign');
    expect(await screen.findByText('Заключение договора — бесплатно')).toBeInTheDocument();

    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-3004/sign');
    expect(await screen.findByText('Заключение договора — бесплатно')).toBeInTheDocument();
  });

  it('«Редактировать договор» доступен, пока не подписано обеими сторонами (ADR-006)', async () => {
    renderPage('/contracts/c-3003/sign');
    expect(await screen.findByTestId('edit-contract-link')).toBeEnabled();
  });

  it('другая юрисдикция (DEV-05-PATCH §5): платный перевод и сумма в валюте политики — без правок кода', async () => {
    renderPage('/contracts/c-3005/sign');
    expect(await screen.findByText('Платежи — с комиссией за перевод')).toBeInTheDocument();
    expect(screen.queryByText('Платежи — без комиссии')).not.toBeInTheDocument();
    expect(screen.getByText(/90 \$/)).toBeInTheDocument();
    expect(screen.queryByTestId('commission-section')).not.toBeInTheDocument();
  });
});

/**
 * ADR-088 Фаза 4 + ADR-124 — этап подписания одной панелью действий
 * (id-префикс `rc-`, диспетчер в SigningPage.tsx). Отсмотр 2026-08-25:
 * отдельных кнопок «Заморозить версию» и «Отправить заявку на подпись»
 * в UI больше нет — «Подписать» ведёт всю цепочку сама, рядом «Вернуть на
 * доработку» и «Отклонить». `realContractsDb.ts`: rc-review-1 (под
 * согласованием, дерево 25000 RUB — freeze-кандидат), rc-frozen-1
 * (заморожен, ни одна сторона не маршрутизирована), rc-awaiting-my-turn-1
 * (моя заявка pending), rc-awaiting-other-signed-1 (контрагент уже подписал —
 * моя подпись финальная), rc-business-blocked-1 (business-сторона —
 * `list_signatories` пуст, честный блок).
 */
describe('SigningPage — реальный контур (ADR-088 Фаза 4, ADR-124)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('ADR-124: под согласованием — ровно три кнопки, отдельной «Заморозить версию» нет', async () => {
    renderPage('/contracts/rc-review-1/sign');
    expect(await screen.findByTestId('sign-cta')).toBeInTheDocument();
    expect(screen.getByTestId('return-for-revision')).toBeInTheDocument();
    expect(screen.getByTestId('reject-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('freeze-cta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('route-signatory-cta')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Заморозить версию' })).not.toBeInTheDocument();
  });

  it('ADR-124: «Подписать» из under_review одним нажатием — заморозка → заявка → подпись', async () => {
    renderPage('/contracts/rc-review-1/sign');
    await userEvent.click(await screen.findByTestId('sign-cta'));
    // Подписал только я — вторая сторона ещё нет, церемонии быть не должно.
    expect(await screen.findByText('Одна подпись есть — ждём вторую')).toBeInTheDocument();
    expect(screen.getByText('🔒 Заморожено')).toBeInTheDocument();
  });

  it('заморозка отклонена бэком (422 leaf_sum_mismatch) → понятная ошибка, статус остаётся under_review', async () => {
    server.use(
      http.post('/v1/contracts/rc-review-1/freeze', () =>
        HttpResponse.json({ code: 'leaf_sum_mismatch', title: 'Дерево этапов пусто — нечего замораживать' }, { status: 422 }),
      ),
    );
    renderPage('/contracts/rc-review-1/sign');
    await userEvent.click(await screen.findByTestId('sign-cta'));
    const error = await screen.findByTestId('signing-error');
    expect(error).toHaveTextContent('Сумма этапов не равна сумме договора');
    expect(screen.getByTestId('sign-cta')).toBeInTheDocument();
    expect(screen.queryByText('Одна подпись есть — ждём вторую')).not.toBeInTheDocument();
  });

  it('заморожен, заявок ещё нет → «Подписать» сам маршрутизирует мою сторону и подписывает', async () => {
    renderPage('/contracts/rc-frozen-1/sign');
    await userEvent.click(await screen.findByTestId('sign-cta'));
    expect(await screen.findByText('Одна подпись есть — ждём вторую')).toBeInTheDocument();
  });

  it('моя заявка pending → «Подписать» переводит мою строку в «Подписано», без церемонии (вторая сторона не подписала)', async () => {
    renderPage('/contracts/rc-awaiting-my-turn-1/sign');
    const signBtn = await screen.findByTestId('sign-cta');
    await userEvent.click(signBtn);
    expect(await screen.findAllByText('Подписано')).not.toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: 'По рукам!' })).not.toBeInTheDocument();
  });

  it('контрагент уже подписал → моя подпись финальная → церемония «по рукам»', async () => {
    renderPage('/contracts/rc-awaiting-other-signed-1/sign');
    const signBtn = await screen.findByTestId('sign-cta');
    await userEvent.click(signBtn);
    expect(await screen.findByRole('dialog', { name: 'По рукам!' })).toBeInTheDocument();
  });

  it('business-сторона — подписант недоступен (SigningAuthority не смёржен): «Подписать» заблокирована, выйти из заморозки можно', async () => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-biz-1', kind: 'business', display_name: 'ИП Годвин · «Тёплый ремонт»', handle: '@teplo_remont', verification_level: 'verified', has_business_status: true },
    ]);
    renderPage('/contracts/rc-business-blocked-1/sign');
    expect(await screen.findByText('Подписант недоступен')).toBeInTheDocument();
    expect(screen.getByTestId('sign-cta')).toBeDisabled();
    expect(screen.getByTestId('return-for-revision')).toBeEnabled();
    expect(screen.getByTestId('reject-cta')).toBeEnabled();
  });

  // Отсмотр 2026-08-21: «Переадресовать» — B2B-маршрутизация подписи, скрыта.
  // «Вернуть на доработку» ВОЗВРАЩЕНА (решение 2026-08-23), с 2026-08-25 идёт
  // через `return_for_revision` (ADR-124) и стоит рядом с «Отклонить».
  it('C2C: «Переадресовать» скрыта, «Вернуть на доработку» и «Отклонить» доступны', async () => {
    renderPage('/contracts/rc-awaiting-my-turn-1/sign');
    await screen.findByTestId('sign-cta');
    expect(screen.getByTestId('return-for-revision')).toBeInTheDocument();
    expect(screen.getByTestId('reject-cta')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Переадресовать' })).not.toBeInTheDocument();
  });

  it('ADR-124: «Вернуть на доработку» с комментарием → раунд аннулирован, договор снова на согласовании', async () => {
    renderPage('/contracts/rc-awaiting-my-turn-1/sign');
    await screen.findByTestId('sign-cta');
    await userEvent.click(screen.getByTestId('return-for-revision'));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Комментарий (обязателен)'), 'Нужно уточнить сроки');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Вернуть на доработку' }));
    // Возврат ведёт на карточку — там протокол разногласий.
    expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
    renderPage('/contracts/rc-awaiting-my-turn-1/sign');
    // Заморозки больше нет: снова под согласованием, версия не показана.
    expect(await screen.findByText('Нажмите «Подписать» — версия будет зафиксирована и подписана')).toBeInTheDocument();
  });

  it('ADR-124: «Отклонить» из заморозки — подтверждение → договор отозван/отклонён, назад на карточку', async () => {
    renderPage('/contracts/rc-frozen-1/sign');
    await userEvent.click(await screen.findByTestId('reject-cta'));
    await userEvent.click(await screen.findByTestId('reject-confirm'));
    expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
    // Терминальный статус — своя заглушка, панели действий больше нет.
    renderPage('/contracts/rc-frozen-1/sign');
    expect(await screen.findByText('Договор больше не на подписании')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-cta')).not.toBeInTheDocument();
  });
});
