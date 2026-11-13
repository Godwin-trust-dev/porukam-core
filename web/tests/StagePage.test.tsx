import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';
import { StagePage } from '../src/pages/StagePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';
import { acceptMilestone, confirmMilestonePayment, listEvidence, listMilestoneTimeline, uploadEvidence } from '../src/mocks/realContractsDb';
import { parseMultipart } from '../src/mocks/multipart';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/stages/:sid" element={<StagePage />} />
            <Route path="/contracts/:id/overview" element={<div>overview-stub</div>} />
            <Route path="/contracts/:id/stages" element={<div>materials-stub</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('StagePage (DEV-11)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-performer', kind: 'person', display_name: 'Исполнитель', handle: '@performer', verification_level: 'basic', has_business_status: false },
    ]);
    useViewerStore.getState().setViewAs('contractor');
  });

  it('гейт роли: не-исполнитель видит приглашение переключиться (§1)', async () => {
    useViewerStore.getState().setViewAs('customer');
    renderPage('/contracts/c-9101/stages/st-9101');
    expect(await screen.findByText('Экран доступен только исполнителю')).toBeInTheDocument();
  });

  it('«Сдать этап» доступна без единого доказательства → подтверждение → under_acceptance (§4 ⭐, приёмка 1—2)', async () => {
    renderPage('/contracts/c-9101/stages/st-9101');
    const cta = await screen.findByTestId('submit-stage-cta');
    expect(cta).toBeEnabled();

    await userEvent.click(cta);
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));

    expect(await screen.findByText(/до автоприёмки/)).toBeInTheDocument();
  });

  it('первая сдача + Drive off → DriveBackupPrompt, «Позже» не блокирует (приёмка 4)', async () => {
    renderPage('/contracts/c-9101/stages/st-9101');
    await userEvent.click(await screen.findByTestId('submit-stage-cta'));
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));

    await userEvent.click(await screen.findByTestId('drive-prompt-later'));
    expect(screen.queryByTestId('drive-prompt-later')).not.toBeInTheDocument();
    // Сдача уже прошла — экран остаётся в состоянии «на приёмке».
    expect(screen.getByText(/до автоприёмки/)).toBeInTheDocument();
  });

  it('загрузка файла → привязка к пункту → «приложено» на чек-листе (приёмка 2)', async () => {
    renderPage('/contracts/c-9101/stages/st-9101');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const row = within(checklist).getAllByTestId('checklist-item')[0]!;

    const file = new File(['x'], 'фото-плитка.jpg', { type: 'image/jpeg' });
    await userEvent.upload(within(row).getByLabelText(/\+ Приложить/), file);

    await waitFor(() => expect(within(row).getByText('приложено · 1')).toBeInTheDocument());
  });

  it('поздняя загрузка показывает «с задержкой N дней» отдельной меткой (приёмка 3)', async () => {
    renderPage('/contracts/c-9102/stages/st-9102');
    expect(await screen.findByText('загружено с задержкой 2 дней')).toBeInTheDocument();
  });

  it('удаление доказательства доступно до сдачи; после сдачи кнопки нет (приёмка 5)', async () => {
    renderPage('/contracts/c-9102/stages/st-9102');
    const list = await screen.findByTestId('evidence-list');
    const before = within(list).getAllByTestId('evidence-item');
    expect(before.length).toBeGreaterThan(0);

    const deleteBtn = within(before[0]!).getByRole('button', { name: /Удалить/ });
    await userEvent.click(deleteBtn);

    await waitFor(() => expect(within(screen.getByTestId('evidence-list')).getAllByTestId('evidence-item')).toHaveLength(before.length - 1));
  });

  it('suspended → CTA неактивна, срок сдвинут (приёмка 6)', async () => {
    renderPage('/contracts/c-9104/stages/st-9104');
    expect(await screen.findByTestId('suspended-banner')).toBeInTheDocument();
    expect(screen.getByTestId('submit-stage-cta')).toBeDisabled();
    expect(screen.getByText('Станет активной, когда возобновите работу')).toBeInTheDocument();
  });

  it('старт-условие «Материалы получены» ведёт в договор/материалы (приёмка 7)', async () => {
    renderPage('/contracts/c-9101/stages/st-9101');
    await userEvent.click(await screen.findByRole('button', { name: /Договор подписан/ }));
    expect(await screen.findByText('overview-stub')).toBeInTheDocument();
  });

  it('камера — заглушка, не блокирует веб-загрузку (приёмка 8)', async () => {
    renderPage('/contracts/c-9101/stages/st-9101');
    expect(await screen.findByTestId('camera-stub')).toHaveTextContent('в приложении (скоро)');
    expect(screen.getByLabelText('Выбрать файлы')).toBeEnabled();
  });

  it('принятый этап показывает итог, доказательства без кнопки удаления', async () => {
    renderPage('/contracts/c-9105/stages/st-9105');
    expect(await screen.findByText('Этап принят')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument();
  });
});

/**
 * ADR-088, Фаза 5 — этапы: сдача + РЕАЛЬНАЯ multipart-загрузка evidence
 * (id-префикс `rc-`, диспетчер в StagePage.tsx). `realContractsDb.ts`:
 * rc-progress-1/ms-3 (подписан, `in_progress`, Годвин — исполнитель, один
 * пункт чек-листа), rc-signed-cash-1/ms-cash-1 (подписан, `cash` — гейт
 * полностью зелёный, `pending`, ждёт `POST .../start`).
 */
describe('StagePage — реальный контур (ADR-088, Фаза 5)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('заказчик видит ход работ read-only — без «Сдать этап» (это действие исполнителя)', async () => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();
    expect(screen.queryByTestId('submit-stage-cta')).not.toBeInTheDocument();
  });

  it('заказчик в in_progress: приложенное к пункту тоже ложится В ЧЕРНОВИК, мгновенной загрузки больше нет', async () => {
    // Раньше файл заказчика уходил на сервер прямо из чек-листа: хешировался,
    // уведомлял вторую сторону и удалению не подлежал. Решение владельца
    // 05.09 распространило черновик на обе стороны.
    const uploads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && /\/milestones\/[^/]+\/evidence$/.test(new URL(request.url).pathname)) uploads.push(request.url);
    });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const row = within(checklist).getAllByTestId('checklist-item')[0]!;

    await userEvent.upload(within(row).getByLabelText(/\+ Приложить/), new File(['x'], 'моё-фото.jpg', { type: 'image/jpeg' }));

    expect(await screen.findByTestId('evidence-draft-label')).toBeInTheDocument();
    expect(uploads).toEqual([]);
    expect(listEvidence('ms-3')).toHaveLength(0);
    // Счётчики у пункта разделены одинаково для ОБЕИХ сторон: свой черновик —
    // «черновик · 1», «приложено» остаётся про серверные файлы.
    expect(within(row).getByTestId('checklist-item-draft')).toHaveTextContent('черновик · 1');
    expect(within(row).queryByText(/приложено · /)).not.toBeInTheDocument();
    // Корзина у черновика есть — ровно то, чего не давал сервер.
    expect(screen.getByRole('button', { name: 'Удалить · моё-фото.jpg' })).toBeInTheDocument();
    // «Сдать этап» у заказчика по-прежнему нет — отправляет он своей кнопкой.
    expect(screen.queryByTestId('submit-stage-cta')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-attached-cta')).toBeEnabled();
  });

  it('не сторона договора — честный блок, не экран сдачи', async () => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-stranger-1', kind: 'person', display_name: 'Посторонний', handle: '@stranger', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Вы не сторона этого договора')).toBeInTheDocument();
  });

  it('in_progress: выбранный файл ложится В ЧЕРНОВИК, на сервер не уходит (ADR-160)', async () => {
    const uploads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && /\/milestones\/[^/]+\/evidence$/.test(new URL(request.url).pathname)) uploads.push(request.url);
    });
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();

    const file = new File(['настоящие байты фото'], 'шов.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), file);

    // Строка есть, но она ЧЕРНОВАЯ: ни «загружено …», ни «хеш зафиксирован» —
    // на сервер ничего не ушло, значит и хешировать было нечего.
    expect(await screen.findByText('шов.jpg')).toBeInTheDocument();
    expect(await screen.findByTestId('evidence-draft-label')).toHaveTextContent('Черновик — ещё не отправлено');
    expect(screen.queryByText(/загружено /)).not.toBeInTheDocument();
    expect(uploads).toEqual([]);
  });

  it('in_progress: черновик удаляется одним касанием — то, чего не давал сервер (жалоба владельца 05.09)', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), [
      new File(['1'], 'смазанное.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'хорошее.jpg', { type: 'image/jpeg' }),
    ]);
    await waitFor(() => expect(within(screen.getByTestId('evidence-list')).getAllByTestId('evidence-item')).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: 'Удалить · смазанное.jpg' }));

    await waitFor(() => expect(screen.queryByText('смазанное.jpg')).not.toBeInTheDocument());
    expect(screen.getByText('хорошее.jpg')).toBeInTheDocument();
  });

  it('«Сдать этап»: диалог говорит, сколько уйдёт, отправляет ВСЕ черновики и только потом submit (ADR-160 §3)', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), [
      new File(['1'], 'первое.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'второе.jpg', { type: 'image/jpeg' }),
    ]);
    await waitFor(() => expect(within(screen.getByTestId('evidence-list')).getAllByTestId('evidence-item')).toHaveLength(2));
    // До подтверждения на сервере ничего нет.
    expect(listEvidence('ms-3')).toHaveLength(0);

    await userEvent.click(screen.getByTestId('submit-stage-cta'));
    expect(await screen.findByText('Будет отправлено 2 файла')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('confirm-submit-stage'));

    expect(await screen.findByText('На приёмке')).toBeInTheDocument();
    // Оба файла реально ушли на сервер, черновик очищен.
    expect(listEvidence('ms-3').map((e) => e.file_name)).toEqual(['первое.jpg', 'второе.jpg']);
    expect(screen.queryByTestId('evidence-draft-label')).not.toBeInTheDocument();
  });

  it('ошибка одного файла: submit НЕ вызывается, файл остаётся в черновике, кнопка становится «Повторить»', async () => {
    let uploadCalls = 0;
    let submitCalls = 0;
    server.use(
      // Второй файл падает 413 от nginx (HTML, без problem+json); первый идёт
      // обычным путём мок-движка — состояние сервера должно быть настоящим.
      http.post('/v1/milestones/:milestoneId/evidence', async ({ request, params }) => {
        uploadCalls += 1;
        if (uploadCalls === 2) return new HttpResponse('<html>413 Request Entity Too Large</html>', { status: 413 });
        const parsed = await parseMultipart(request);
        return HttpResponse.json(uploadEvidence(String(params['milestoneId']), parsed!.files['file']!, parsed?.fields['checklist_item_id'], 'u-1001'), { status: 201 });
      }),
      http.post('/v1/milestones/:milestoneId/submit', () => {
        submitCalls += 1;
        return HttpResponse.json({});
      }),
    );
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), [
      new File(['ok'], 'нормальное.jpg', { type: 'image/jpeg' }),
      new File(['big'], 'большое.jpg', { type: 'image/jpeg' }),
    ]);
    await waitFor(() => expect(within(screen.getByTestId('evidence-list')).getAllByTestId('evidence-item')).toHaveLength(2));

    await userEvent.click(screen.getByTestId('submit-stage-cta'));
    await userEvent.click(screen.getByTestId('confirm-submit-stage'));

    // Диалог остался открытым, сдачи не было.
    expect((await screen.findAllByText('Часть файлов не отправилась. Этап не сдан — попробуйте ещё раз.')).length).toBeGreaterThan(0);
    expect(submitCalls).toBe(0);
    expect(screen.getByTestId('confirm-submit-stage')).toHaveTextContent('Повторить');
    // Ушедший файл ушёл и из черновика убран, упавший — остался с текстом про размер.
    expect(listEvidence('ms-3').map((e) => e.file_name)).toEqual(['нормальное.jpg']);
    expect(await screen.findByText('Будет отправлен 1 файл')).toBeInTheDocument();
    expect(screen.getByText(/больше 25 МБ/)).toBeInTheDocument();
    expect(screen.queryByText(/Entity Too Large/)).not.toBeInTheDocument();
  });

  it('черновик переживает перезагрузку страницы: после повторного захода файлы на месте (мобайл, ADR-160 §1)', async () => {
    const first = renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), new File(['1'], 'снято-камерой.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByTestId('evidence-draft-label')).toBeInTheDocument();

    // Android перезагружает вкладку после камеры — эмулируем полным
    // размонтированием: состояние React теряется, хранилище остаётся.
    first.unmount();
    renderPage('/contracts/rc-progress-1/stages/ms-3');

    expect(await screen.findByText('снято-камерой.jpg')).toBeInTheDocument();
    expect(await screen.findByTestId('evidence-draft-label')).toBeInTheDocument();
  });

  it('in_progress: файл больше 25 МБ не попадает даже в черновик — ошибка сразу в окне прикрепления', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();

    const big = new File(['x'], 'огромное.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), big);

    const alert = await screen.findByTestId('evidence-upload-error');
    expect(alert).toHaveTextContent('огромное.jpg');
    expect(alert).toHaveTextContent(/больше 25 МБ/);
    expect(screen.queryByTestId('evidence-list')).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByTestId('evidence-upload-error')).not.toBeInTheDocument();
  });

  it('просмотр без миниатюры: честный текст «превью недоступно» и «Скачать оригинал» (GET /evidence/{id}/download)', async () => {
    // Уже СДАННЫЙ этап: доказательство лежит на сервере (`ev-review-1`,
    // `has_thumbnail: false`) — до сдачи файлы черновые и смотрятся локально.
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    expect(await screen.findByText('стена-1.jpg')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'стена-1.jpg' }));
    expect(await screen.findByTestId('photo-viewer-fallback')).toHaveTextContent('Превью недоступно');
    const createObjectURL = vi.fn(() => 'blob:mock');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    await userEvent.click(screen.getByTestId('photo-viewer-download'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it('in_progress: черновик у пункта считается ОТДЕЛЬНО — «черновик · 1», а не «приложено» (правка 05.09)', async () => {
    // Раньше черновик приплюсовывался к «приложено», и счётчик врал: своё
    // «приложено» человек читает как «дело сделано», а на приёмке тот же
    // счётчик у второй стороны значит «файл у меня есть».
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const row = within(checklist).getAllByTestId('checklist-item')[0]!;

    const file = new File(['x'], 'фото-шва.jpg', { type: 'image/jpeg' });
    await userEvent.upload(within(row).getByLabelText(/\+ Приложить/), file);

    await waitFor(() => expect(within(row).getByTestId('checklist-item-draft')).toHaveTextContent('черновик · 1'));
    expect(within(row).queryByText(/приложено · /)).not.toBeInTheDocument();
  });

  it('после сдачи тот же файл переходит из «черновик · 1» в «приложено · 1» (ушёл на сервер)', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const row = within(checklist).getAllByTestId('checklist-item')[0]!;
    await userEvent.upload(within(row).getByLabelText(/\+ Приложить/), new File(['x'], 'шов.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(within(row).getByTestId('checklist-item-draft')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('submit-stage-cta'));
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));
    expect(await screen.findByText('На приёмке')).toBeInTheDocument();

    // `under_acceptance`: чек-лист сдачи сменился списком приёмки, но счётчик
    // уже посчитал файл как серверный — черновиков не осталось.
    expect(listEvidence('ms-3').map((e) => e.file_name)).toEqual(['шов.jpg']);
    expect(screen.queryByTestId('checklist-item-draft')).not.toBeInTheDocument();
  });

  it('«Сдать этап» переводит in_progress → under_acceptance (реальный POST /submit)', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const cta = await screen.findByTestId('submit-stage-cta');
    expect(cta).toBeEnabled();

    await userEvent.click(cta);
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));

    expect(await screen.findByText('На приёмке')).toBeInTheDocument();
  });

  /**
   * ADR-164 (жалоба владельца 05.09). `ms-3` держит пункт чек-листа с
   * `required_evidence: ['фото']` и НИ ОДНОГО файла — раньше бэк отвечал на
   * такую сдачу 422 со служебным текстом «этап <uuid>: не все
   * required_evidence чек-листа покрыты». Теперь: пометка у пункта, мягкое
   * предупреждение в диалоге, сдача проходит.
   */
  it('непокрытый пункт чек-листа: пометка у пункта + мягкое предупреждение в диалоге, сдача НЕ блокируется', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const checklist = await screen.findByTestId('acceptance-checklist');
    expect(within(checklist).getByTestId('checklist-item-no-evidence')).toHaveTextContent('фото нет');

    await userEvent.click(await screen.findByTestId('submit-stage-cta'));
    const warning = await screen.findByTestId('submit-stage-warning');
    expect(warning).toHaveTextContent('Сдать этап всё равно можно');
    expect(warning).toHaveTextContent('Швы затёрты ровно');

    const confirm = await screen.findByTestId('confirm-submit-stage');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await screen.findByText('На приёмке')).toBeInTheDocument();
  });

  it('пункт с приложенным фото не помечен и в предупреждение не попадает', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    const checklist = await screen.findByTestId('acceptance-checklist');
    const row = within(checklist).getAllByTestId('checklist-item')[0]!;
    await userEvent.upload(within(row).getByLabelText(/\+ Приложить/), new File(['x'], 'шов.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(within(row).getByTestId('checklist-item-draft')).toBeInTheDocument());

    // Черновик снимает пометку «фото нет» намеренно: к моменту сдачи файл уже
    // уйдёт, и предупреждать в диалоге не о чем — считаться в «приложено» он
    // при этом всё равно не должен.
    await waitFor(() => expect(screen.queryByTestId('checklist-item-no-evidence')).not.toBeInTheDocument());
    await userEvent.click(await screen.findByTestId('submit-stage-cta'));
    expect(screen.queryByTestId('submit-stage-warning')).not.toBeInTheDocument();
  });

  it('ошибка сдачи: человеку — текст по коду, БЕЗ служебного detail с UUID; повторное открытие диалога её не тащит', async () => {
    server.use(
      http.post('/v1/milestones/:id/submit', () =>
        HttpResponse.json(
          { title: 'Недопустимое действие', detail: 'этап 01a06217-0000-0000-0000-000000000000: нельзя', code: 'invalid_milestone_transition', status: 409 },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    await userEvent.click(await screen.findByTestId('submit-stage-cta'));
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));

    // Текст рисуется и в листе, и в теле страницы — важно, что он ОДИН и тот
    // же человеческий, а служебного `detail` с UUID нет нигде.
    expect((await screen.findAllByText('Это действие недоступно для текущего статуса этапа.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/01a06217/)).not.toBeInTheDocument();

    // Закрыли, снова открыли — диалог чистый (ровно жалоба: сообщение
    // показывалось ещё до запроса, а сдача при этом проходила).
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await userEvent.click(await screen.findByTestId('submit-stage-cta'));
    expect(screen.queryAllByText('Это действие недоступно для текущего статуса этапа.')).toHaveLength(0);
  });

  it('pending + гейт полностью выполнен (cash) → «Начать этап» доступна → POST /start → in_progress', async () => {
    renderPage('/contracts/rc-signed-cash-1/stages/ms-cash-1');
    const cta = await screen.findByTestId('start-stage-cta');
    await waitFor(() => expect(cta).toBeEnabled());

    await userEvent.click(cta);

    expect(await screen.findByText('В работе')).toBeInTheDocument();
    expect(await screen.findByTestId('submit-stage-cta')).toBeInTheDocument();
  });

  it('suspended: баннер приостановки, CTA неактивна', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3-suspended');
    expect(await screen.findByTestId('suspended-banner')).toBeInTheDocument();
    expect(screen.getByTestId('submit-stage-cta')).toBeDisabled();
  });

  it('accepted: итог этапа, без кнопки удаления доказательств (реального DELETE у бэка нет)', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3-accepted');
    expect(await screen.findByText('Этап принят')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument();
  });

  it('disputed: честный блок «в споре», не выдаётся за принятый/в работе', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3-disputed');
    expect(await screen.findByText('По этапу открыт спор — доказательства ниже сохранены неизменными.')).toBeInTheDocument();
  });
});

/**
 * ADR-088, Фаза 6 — приёмка этапа (`accept`/`reject`, id-префикс `rc-`,
 * тот же `StagePage`/диспетчер, что и Фаза 5 — приёмка НЕ отдельный экран).
 * `realContractsDb.ts`: rc-signed-review-1/ms-review-1 — подписан, Годвин
 * ЗАКАЗЧИК (в отличие от rc-progress-1/rc-signed-cash-1, там он исполнитель),
 * `under_acceptance`, два пункта чек-листа: ci-review-1 (есть evidence
 * ev-review-1), ci-review-2 (evidence нет — намеренно, для проверки честного
 * блока «нечем отклонить»).
 */
describe('StagePage — реальный контур: приёмка (ADR-088, Фаза 6)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('заказчик видит пункты чек-листа для приёмки, «Принять этап» доступна сразу', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const list = await screen.findByTestId('acceptance-review-list');
    // Именно В СПИСКЕ ПРИЁМКИ: те же названия пунктов теперь есть и в
    // селекте привязки окна прикрепления — у заказчика на приёмке появился
    // свой черновик (расширение ADR-160 от 05.09).
    expect(within(list).getByText('Швы совпадают, нет пузырей')).toBeInTheDocument();
    expect(within(list).getByText('Углы проклеены')).toBeInTheDocument();
    expect(screen.getByTestId('accept-milestone-cta')).toBeEnabled();
    // Пока пункт для отклонения не выбран — «Отклонить» недоступна.
    expect(screen.getByTestId('reject-milestone-cta')).toBeDisabled();
  });

  it('«Принять этап» → подтверждение → реальный POST /accept → статус «Принят»', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    await userEvent.click(await screen.findByTestId('accept-milestone-cta'));
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));

    expect(await screen.findByText('Принят')).toBeInTheDocument();
  });

  it('пункт без evidence нельзя отклонить — честный блок, «Отклонить» остаётся недоступна', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const list = await screen.findByTestId('acceptance-review-list');
    await userEvent.click(within(list).getByText('Углы проклеены'));

    expect(await screen.findByText(/К этому пункту не приложено ни одного доказательства/)).toBeInTheDocument();
    expect(screen.getByTestId('reject-milestone-cta')).toBeDisabled();
  });

  it('выбор пункта с evidence + чекбокс → «Отклонить» → реальный POST /reject {checklist_item_id, evidence} → disputed → «Принять всё же» доступна', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const list = await screen.findByTestId('acceptance-review-list');
    await userEvent.click(within(list).getByText('Швы совпадают, нет пузырей'));

    const evidenceCheckbox = await within(list).findByLabelText('стена-1.jpg');
    await userEvent.click(evidenceCheckbox);
    expect(screen.getByTestId('reject-milestone-cta')).toBeEnabled();

    await userEvent.click(screen.getByTestId('reject-milestone-cta'));

    expect(await screen.findByText('По этапу открыт спор — доказательства ниже сохранены неизменными.')).toBeInTheDocument();
    const acceptAnyway = await screen.findByTestId('accept-milestone-cta');
    expect(acceptAnyway).toBeInTheDocument();

    // «Принять всё же» — реальный disputed -> accepted (MILESTONE_FSM).
    await userEvent.click(acceptAnyway);
    await userEvent.click(await screen.findByTestId('confirm-submit-stage'));
    expect(await screen.findByText('Принят')).toBeInTheDocument();
  });

  it('заказчик на приёмке: файл ложится в черновик, «Отправить приложенное» шлёт его с описанием одним рейсом', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    expect(await screen.findByTestId('acceptance-review-list')).toBeInTheDocument();

    // Пока файла нет — отправлять нечего.
    expect(screen.getByTestId('send-attached-cta')).toBeDisabled();

    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), new File(['скол'], 'скол.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByTestId('evidence-draft-label')).toHaveTextContent('Черновик — ещё не отправлено');
    // На сервере по-прежнему только доказательство исполнителя.
    expect(listEvidence('ms-review-1').map((e) => e.file_name)).toEqual(['стена-1.jpg']);
    expect(screen.getByTestId('send-attached-cta')).toBeEnabled();

    await userEvent.type(screen.getByLabelText('Описание'), 'Скол на левом углу');
    await userEvent.click(screen.getByTestId('send-attached-cta'));

    await waitFor(() => expect(listEvidence('ms-review-1').map((e) => e.file_name)).toEqual(['стена-1.jpg', 'скол.jpg']));
    // Описание уехало ВМЕСТЕ с файлом (изменить его потом нечем — PATCH нет).
    expect(listEvidence('ms-review-1')[1]!.description).toBe('Скол на левом углу');
    // Черновик очищен, поле описания — тоже: следующая партия не подпишется
    // чужим текстом.
    await waitFor(() => expect(screen.queryByTestId('evidence-draft-label')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Описание')).toHaveValue('');
  });

  it('заказчик на приёмке: черновик удаляется корзиной, на сервер не уходит («вдруг он случайно личное фото приложит»)', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    expect(await screen.findByTestId('acceptance-review-list')).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), [
      new File(['1'], 'личное.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'скол.jpg', { type: 'image/jpeg' }),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('evidence-draft-label')).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: 'Удалить · личное.jpg' }));

    await waitFor(() => expect(screen.queryByText('личное.jpg')).not.toBeInTheDocument());
    expect(screen.getByText('скол.jpg')).toBeInTheDocument();
    // Ни один из двух на сервер не уходил — удалять было нечего, кроме
    // локального файла.
    expect(listEvidence('ms-review-1').map((e) => e.file_name)).toEqual(['стена-1.jpg']);
  });

  it('заказчик: приложенное к пункту доказательство становится доступным для отклонения по этому пункту', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const list = await screen.findByTestId('acceptance-review-list');
    // Пункт без доказательств — раньше это был тупик: отклонить нечем.
    await userEvent.click(within(list).getByText('Углы проклеены'));
    expect(await screen.findByText(/К этому пункту не приложено ни одного доказательства/)).toBeInTheDocument();
    expect(screen.getByTestId('reject-milestone-cta')).toBeDisabled();

    // Привязываем свой файл к этому пункту и отправляем.
    await userEvent.selectOptions(screen.getByLabelText('Привязать к'), 'ci-review-2');
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), new File(['x'], 'угол.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByTestId('send-attached-cta'));

    // Теперь файл — настоящее доказательство пункта, его можно отметить.
    const checkbox = await within(screen.getByTestId('acceptance-review-list')).findByLabelText('угол.jpg');
    await userEvent.click(checkbox);
    expect(screen.getByTestId('reject-milestone-cta')).toBeEnabled();
  });

  it('заказчик не видит черновик исполнителя того же этапа (scope — пара «актёр + этап»)', async () => {
    // Исполнитель кладёт файл в черновик на СВОЁМ этапе...
    const asContractor = renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Выбрать файлы'), new File(['1'], 'исполнителя.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByTestId('evidence-draft-label')).toBeInTheDocument();
    asContractor.unmount();

    // ...а заказчик того же этапа (общее устройство, переключение актёра) его
    // не видит: scope = `<ownerId>::<milestoneId>`.
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-progress-1/stages/ms-3');
    expect(await screen.findByText('Плитка')).toBeInTheDocument();
    expect(screen.queryByText('исполнителя.jpg')).not.toBeInTheDocument();
    expect(screen.queryByTestId('evidence-draft-label')).not.toBeInTheDocument();
  });

  it('исполнитель на under_acceptance — read-only, без контролов приёмки', async () => {
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    await screen.findByText('На приёмке');
    expect(screen.queryByTestId('acceptance-review-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accept-milestone-cta')).not.toBeInTheDocument();
    // Черновик и «Отправить приложенное» — заказчику: этап уже сдан, у
    // исполнителя доприкладывать нечего.
    expect(screen.queryByTestId('send-attached-cta')).not.toBeInTheDocument();
  });
});

/**
 * Хроника ЭТАПА (`GET /milestones/{id}/timeline`) — тот же сериализатор, что
 * у хроники договора (`apps.milestones.selectors.get_timeline` зовёт
 * `contracts_selectors.timeline_entries`, ADR-134): подпись приходит с бэка
 * полем `title`. Находка 07.09: экран печатал `e.topic` — человек видел
 * `milestone.submitted` вместо «Этап сдан на приёмку».
 */
describe('StagePage — хроника этапа (ADR-134)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('подпись события — человеческая с бэка, код `milestone.submitted` не печатается', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const tl = await screen.findByTestId('contract-timeline');
    expect(within(tl).getByText('Этап сдан на приёмку')).toBeInTheDocument();
    expect(within(tl).queryByText('milestone.submitted')).not.toBeInTheDocument();
  });

  it('неизвестный kind без подписи — нейтральное «Событие», код уходит в пояснение (как <code> в хронике договора)', async () => {
    server.use(
      http.get('/v1/milestones/ms-review-1/timeline', () =>
        HttpResponse.json([
          // Старый бэк `kind`/`title` не отдаёт вовсе.
          { event_id: 'x1', topic: 'milestone.something_new', occurred_at: '2026-08-15T09:00:00Z', actor: {}, subject: { type: 'milestone', id: 'ms-review-1' }, payload: {} },
          // Новый бэк без текста в паке отдаёт `title == kind` — тот же фолбэк.
          { event_id: 'x2', topic: 'milestone.other_new', kind: 'milestone.other_new', nested: true, title: 'milestone.other_new', detail: null, occurred_at: '2026-08-15T10:00:00Z', actor: {}, subject: { type: 'milestone', id: 'ms-review-1' }, payload: {} },
          // Подпись есть — `detail` бэка показывается под ней.
          { event_id: 'x3', topic: 'milestone.rejected', kind: 'milestone.rejected', nested: true, title: 'Этап отклонён', detail: 'Пункт «Углы проклеены»', occurred_at: '2026-08-15T11:00:00Z', actor: {}, subject: { type: 'milestone', id: 'ms-review-1' }, payload: {} },
        ]),
      ),
    );
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const tl = await screen.findByTestId('contract-timeline');
    expect(within(tl).getAllByText('Событие')).toHaveLength(2);
    expect(within(tl).getByText('milestone.something_new')).toBeInTheDocument();
    expect(within(tl).getByText('milestone.other_new')).toBeInTheDocument();
    expect(within(tl).getByText('Этап отклонён')).toBeInTheDocument();
    expect(within(tl).getByText('Пункт «Углы проклеены»')).toBeInTheDocument();
  });

  it('мок `GET /milestones/{id}/timeline` отдаёт `kind`/`title`, как бэк (общий сериализатор)', () => {
    const events = listMilestoneTimeline('ms-review-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('milestone.submitted');
    expect(events[0]!.title).toBe('Этап сдан на приёмку');
    expect(events[0]!.detail).toBeNull();
  });
});

/**
 * Э5, ADR-130 — блок оплаты этапа читает ТОТ ЖЕ ресурс, что вкладка
 * «Оплаты» карточки договора (`GET /contracts/{id}/payments`), и
 * подтверждает через `POST /payments/{id}/confirm` (не через
 * унаследованный `/milestones/{id}/confirm-payment`). Источник правды —
 * `Payment`; отметки `paid_confirmed_*_at` на этапе остались зеркалом,
 * поэтому строки сторон по-прежнему сходятся со счётом.
 * Сид: rc-signed-review-1 (`cash`, Годвин ЗАКАЗЧИК = плательщик,
 * ms-review-1) — до `accepted` доводится реальными вызовами мок-движка
 * (тот же путь, что POST /accept), не выдуманным сидом.
 */
describe('StagePage — реальный контур: подтверждение оплаты (Э5, ADR-130)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
    acceptMilestone('ms-review-1', 'u-1001');
  });

  it('accepted + cash: строка постоплаты, обе стороны «Ждём подтверждения», CTA плательщика', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    const card = within(await screen.findByTestId('stage-payment-confirm'));
    expect(card.getByText('Оплата этапа')).toBeInTheDocument();
    expect(card.getByText(/Наличный расчёт/)).toBeInTheDocument();
    // Счёт материализуется «read-repair»-ом на GET — заголовок строки это её вид.
    expect(card.getByText('Постоплата')).toBeInTheDocument();
    expect(card.getByText('Не оплачено')).toBeInTheDocument();
    expect(card.getAllByText('Ждём подтверждения')).toHaveLength(2);
    const cta = card.getByTestId('payment-confirm');
    expect(cta).toBeEnabled();
    expect(cta).toHaveTextContent('Я оплатил');
    // Ошибочно выставленную ПОСТОПЛАТУ отозвать можно: после отмены счёт
    // выставится заново при следующей приёмке — тупика нет.
    expect(card.getByTestId('payment-cancel')).toBeInTheDocument();
  });

  it('«Я оплатил» → POST /payments/{id}/confirm → своя строка «Подтвердил(а)», ждём вторую сторону, CTA скрыта', async () => {
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');
    await userEvent.click(await screen.findByTestId('payment-confirm'));

    expect(await screen.findByText(/Ждём подтверждения второй стороны/)).toBeInTheDocument();
    const card = within(screen.getByTestId('stage-payment-confirm'));
    // Зеркало на этапе сходится со счётом: строка плательщика подтверждена.
    expect(card.getByText('Подтвердил(а)')).toBeInTheDocument();
    expect(card.getByText('Ждём подтверждения')).toBeInTheDocument();
    expect(card.getByText('Отмечено плательщиком')).toBeInTheDocument();
    expect(card.queryByTestId('payment-confirm')).not.toBeInTheDocument();
    // Статус этапа НЕ меняется от одного подтверждения (pay — только от обоих).
    expect(screen.getByText('Принят')).toBeInTheDocument();
  });

  it('встречное подтверждение исполнителя → paid: статус «Оплачен», обе строки подтверждены', async () => {
    // Заказчик уже подтвердил (напрямую мок-движком — тот же код, что POST выше).
    confirmMilestonePayment('ms-review-1', 'customer', 'pf-person-1', 'u-1001');

    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-mock-contractor-1', kind: 'person', display_name: 'Марат Отделкин', handle: '@marat_otdelkin', verification_level: 'basic', has_business_status: false },
    ]);
    renderPage('/contracts/rc-signed-review-1/stages/ms-review-1');

    const cta = await screen.findByTestId('payment-confirm');
    expect(cta).toHaveTextContent('Подтвердить получение');
    await userEvent.click(cta);

    expect(await screen.findByText('Оплата подтверждена обеими сторонами — факт зафиксирован в доказательной базе.')).toBeInTheDocument();
    const card = within(screen.getByTestId('stage-payment-confirm'));
    expect(card.getAllByText('Подтвердил(а)')).toHaveLength(2);
    expect(card.queryByTestId('payment-confirm')).not.toBeInTheDocument();
  });

  /** Предоплата (`payment_order=before_start`, ADR-151/155): счёт по листу
   * выставлен с подписания и ДЕРЖИТ гейт §6.3, поэтому его строка видна ещё
   * на `pending`-этапе. Вида «аванс» больше нет — вид платежа один, срок
   * несёт `payment_order`. */
  it('предоплата: счёт по листу виден до старта и подписан сроком, а не видом платежа', async () => {
    renderPage('/contracts/rc-prepay-1/stages/ms-prepay-1');
    const card = within(await screen.findByTestId('stage-payment-confirm'));
    expect(card.getByText('К оплате до старта этапа')).toBeInTheDocument();
    expect(card.getByText('Не оплачено')).toBeInTheDocument();
    // Предоплатный счёт не отменяется (409 `payment_not_cancellable`): он —
    // условие гейта, выставить его заново нельзя (`UNIQUE (milestone, kind)`),
    // и старт этапа остался бы запертым навсегда.
    expect(card.queryByTestId('payment-cancel')).not.toBeInTheDocument();

    await userEvent.click(card.getByTestId('payment-confirm'));
    expect(await screen.findByText(/Ждём подтверждения второй стороны/)).toBeInTheDocument();
    expect(within(screen.getByTestId('stage-payment-confirm')).getByText('Отмечено плательщиком')).toBeInTheDocument();
  });

  it('direct_platform: счетов нет — вместо блока пояснение, деньги пойдут через платёжный модуль', async () => {
    renderPage('/contracts/rc-progress-1/stages/ms-3-accepted');
    expect(await screen.findByText('Этап принят')).toBeInTheDocument();
    expect(screen.queryByTestId('stage-payment-confirm')).not.toBeInTheDocument();
    // Отсмотр 2026-08-25: пустое место вместо блока читалось как поломка —
    // вместо кнопки стоит пояснение, почему её нет.
    const notice = within(await screen.findByTestId('platform-payment-notice'));
    expect(notice.getByText('Оплата через платформу пока недоступна')).toBeInTheDocument();
    expect(notice.getByText(/рассчитывайтесь напрямую по реквизитам/)).toBeInTheDocument();
  });
});
