import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ReputationCardPage } from '../src/pages/ReputationCardPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Карточка репутации на РЕАЛЬНОМ контракте (ADR-076/093): `GET /v1/handles/{handle}`
 * → `profile_id` → `GET /v1/reputation/profiles/{id}/card`. Тесты держат ровно те
 * состояния, которые способен вернуть бэк: полная карточка, карточка без истории,
 * «стартовая» (`restricted`), хендл объединения без профиля, 404.
 */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function renderPage(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[initialPath]}>
          <LocationProbe />
          <Routes>
            <Route path="/reputation/profiles/:profileId" element={<ReputationCardPage />} />
            <Route path="/:handle" element={<ReputationCardPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const PROFILE_FULL = '018f1a00-0000-7000-8000-0000000000a1';
const PROFILE_COUNTERPARTY = '018f1a00-0000-7000-8000-0000000000a4';

describe('ReputationCardPage — заявленные сферы (ADR-122)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('чипы сфер деятельности видны гостю на карточке', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const chips = await screen.findByTestId('card-spheres');
    expect(within(chips).getByText('Сантехника')).toBeInTheDocument();
  });
});

describe('ReputationCardPage — объединения (ADR-117/118)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('гость по /@хендлу объединения видит его публичную карточку', async () => {
    renderPage('/@masters_otdelki');
    expect(await screen.findByTestId('group-card')).toBeInTheDocument();
    expect(screen.getByText('Мастера отделки')).toBeInTheDocument();
    expect(screen.getByText('Гильдия')).toBeInTheDocument();
    // Лидер — и в шапке («Лидер: …»), и в списке участников.
    const members = await screen.findByTestId('group-members');
    expect(within(members).getByText('Марат Отделкин')).toBeInTheDocument();
    // Гость: регистрация, а не «вступить».
    expect(screen.queryByTestId('group-join')).not.toBeInTheDocument();
    expect(screen.getByText('или зарегистрироваться на сайте')).toBeInTheDocument();
  });

  it('личная карточка: блок «Состоит в объединениях» ведёт на /@хендл объединения', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const block = screen.getByTestId('card-groups');
    expect(within(block).getByText(/Мастера отделки/)).toBeInTheDocument();
    await userEvent.click(within(block).getByText(/Мастера отделки/));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/@masters_otdelki');
  });
});

describe('ReputationCardPage — работы портфолио кликабельны (ADR-120)', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('гость открывает работу: галерея с листанием, период, город, описание', async () => {
    // Сид портфолио привязан к pf-mock-contractor-1; карточка ключуется тем же profile_id.
    renderPage('/reputation/profiles/pf-mock-contractor-1');
    const work = await screen.findByTestId('card-work-pp-1');
    await userEvent.click(work);
    const view = await screen.findByTestId('project-view');
    expect(within(view).getByTestId('project-view-description')).toHaveTextContent('Плитка, сантехника, тёплый пол.');
    expect(within(view).getByTestId('project-view-period')).toHaveTextContent('—');
    expect(within(view).getByText('Алматы')).toBeInTheDocument();
    expect(within(view).getByText('Фото 1 из 2')).toBeInTheDocument();
    const photo = within(view).getByTestId('project-view-photo');
    expect(photo).toHaveAttribute('src', expect.stringContaining('ph-1'));
    await userEvent.click(within(view).getByLabelText('Фото 2 из 2'));
    expect(within(view).getByTestId('project-view-photo')).toHaveAttribute('src', expect.stringContaining('ph-2'));
  });
});

describe('ReputationCardPage — реальные пути репутации', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('гость по /@handle видит карточку с реальными счётчиками и сделкой', async () => {
    renderPage('/@akovalev');
    expect(await screen.findByText('Артём Ковалёв')).toBeInTheDocument();
    // deals_count / counterparties_count — ровно то, что отдал бэк
    expect(screen.getByText('Завершённых сделок')).toBeInTheDocument();
    expect(screen.getByText('Контрагентов')).toBeInTheDocument();
    // сама сделка: тип, сегмент, сфера, исход
    // Отсмотр 2026-08-19: сырой contract_type_code не показываем — семейство
    // кода маплится на локализованную плитку мастера («Услуга»).
    expect(screen.getByText('Услуга')).toBeInTheDocument();
    expect(screen.queryByText('services_repair')).not.toBeInTheDocument();
    expect(screen.getByText('Между людьми')).toBeInTheDocument(); // «бесплатно» убрано (отсмотр 2026-08-19)
    // Имя сферы ищем ВНУТРИ списка сделок: с макетом 05.09 та же сфера
    // называется ещё и в строках раздела «по сферам и ролям».
    const deals = await screen.findByTestId('card-deals');
    expect(await within(deals).findByText('Ремонт и строительство')).toBeInTheDocument();
    expect(screen.getByText('Завершена')).toBeInTheDocument();
    expect(screen.getByText('Принято этапов: 3')).toBeInTheDocument();
    expect(screen.getByText('Возвращено на доработку: 1')).toBeInTheDocument();
  });

  it('ни объёма по валютам, ни доли защищённых платежей на публичной карточке (ADR-163 §4)', async () => {
    const { container } = renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    // Сид несёт объём и защищённые платежи в /insights — на карточке их
    // не должно быть НИ ПОД КАКИМ видом.
    expect(container.textContent).not.toMatch(/₽|RUB|4\s?820\s?000/);
    expect(screen.queryByText(/защищённ/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/объём/i)).not.toBeInTheDocument();
  });

  it('профиль без истории — честное пустое состояние, а не нули из воздуха', async () => {
    renderPage('/@novichok');
    expect(await screen.findByText('Пока нет завершённых сделок')).toBeInTheDocument();
    // display_name = null → честная подпись + хендл как единственный идентификатор
    expect(screen.getByText('Профиль без имени')).toBeInTheDocument();
    expect(screen.getByText('@novichok')).toBeInTheDocument();
  });

  it('restricted (стартовая карточка) — счётчики скрыты, возраст профиля виден', async () => {
    renderPage('/@zakrytyi');
    expect(await screen.findByText('История сделок скрыта')).toBeInTheDocument();
    // Четыре плитки фактов (сделки, контрагенты, без споров, сделано в
    // срок) — при `restricted` скрыты ВСЕ: агрегаты производны от списка
    // сделок, и любая из цифр слила бы скрытую историю (ADR-163 §4).
    expect(screen.getAllByText('скрыто').length).toBe(4);
    expect(screen.getByText(/На платформе с/)).toBeInTheDocument();
    expect(screen.queryByText('services_repair')).not.toBeInTheDocument();
  });

  it('гость на restricted-карточке: CTA «зарегистрироваться» один — в шапке, без дубля в locked-блоке', async () => {
    renderPage('/@zakrytyi');
    await screen.findByText('История сделок скрыта');
    expect(screen.getAllByText('или зарегистрироваться на сайте')).toHaveLength(1);
  });

  it('хендл объединения (profile_id = null) — карточки нет, и это сказано честно', async () => {
    renderPage('/@teplo_remont');
    expect(await screen.findByText('У этого хендла нет карточки репутации')).toBeInTheDocument();
  });

  it('неизвестный хендл → «нет такой страницы»', async () => {
    renderPage('/@no-such-user');
    expect(await screen.findByText('Такой страницы нет')).toBeInTheDocument();
  });

  it('сегмент без «@» карточкой не считается', async () => {
    renderPage('/akovalev');
    expect(await screen.findByText('Такой страницы нет')).toBeInTheDocument();
  });

  it('прямая ссылка по profile_id (сторона договора) открывает ту же карточку', async () => {
    renderPage(`/reputation/profiles/${PROFILE_FULL}`);
    expect(await screen.findByText('Артём Ковалёв')).toBeInTheDocument();
    // хендл приезжает с самой карточкой, статус верификации — по нему
    expect(screen.getByText('@akovalev')).toBeInTheDocument();
    expect(await screen.findByText('Личность подтверждена')).toBeInTheDocument();
  });

  it('слова «в срок» без уточнения роли на экране нет (ADR-163 §1)', async () => {
    const { container } = renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    // «сделано в срок» и «оплачено в срок» — можно; голое «в срок» после
    // цифры (например «36 из 39 в срок») — нельзя.
    expect(container.textContent).not.toMatch(/из \d+ в срок/);
    expect(screen.getAllByText(/сделано в срок/).length).toBeGreaterThan(0);
  });

  it('раздел «по сферам и ролям»: одна сфера в двух ролях — две строки', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const contractor = await screen.findByTestId('spheres-contractor');
    const customer = await screen.findByTestId('spheres-customer');
    // «Ремонт» есть и как исполнитель, и как заказчик — цифры разные.
    expect(within(contractor).getByText('29 из 31 сделано в срок')).toBeInTheDocument();
    expect(within(customer).getByText('3 из 6 оплачено в срок')).toBeInTheDocument();
  });

  it('подсказка «?» объясняет, что именно показывает полоса в этом разделе', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const contractor = await screen.findByTestId('spheres-contractor');
    await userEvent.click(within(contractor).getByRole('button', { name: /Что показывает полоса/ }));
    expect(within(contractor).getByText('Полоса — сделано в срок.')).toBeInTheDocument();
  });

  it('дробь и процент — текстом, зона не закодирована одним лишь цветом', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const contractor = await screen.findByTestId('spheres-contractor');
    // 3 из 8 — красная зона (37,5 % → оранжевая), но проверяем именно то,
    // что процент выведен СЛОВОМ рядом с дробью.
    expect(within(contractor).getByText('3 из 8 сделано в срок')).toBeInTheDocument();
    expect(within(contractor).getByText('38%')).toBeInTheDocument();
  });

  it('блок «надёжность»: споры, гарантийные, повторные контрагенты, последняя сделка', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    const block = await screen.findByTestId('card-reliability');
    expect(within(block).getByText('44 из 45 без споров')).toBeInTheDocument();
    expect(within(block).getByText('Гарантийных обращений: 2')).toBeInTheDocument();
    expect(within(block).getByText('4 из 17 контрагентов вернулись')).toBeInTheDocument();
  });

  it('пояснение внизу называет обе системы оценки и правило цвета', async () => {
    renderPage('/@akovalev');
    const legend = await screen.findByTestId('card-legend');
    expect(legend.textContent).toMatch(/Исполнителя оцениваем по срокам работ/);
    expect(legend.textContent).toMatch(/до трети красный/);
  });

  it('restricted: агрегатов нет вовсе — ни сфер, ни надёжности', async () => {
    renderPage('/@zakrytyi');
    await screen.findByText('Пётр Закрытый');
    expect(screen.queryByTestId('card-spheres-by-role')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-reliability')).not.toBeInTheDocument();
  });

  it('контрагент сделки — ссылка на его карточку по profile_id', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    await userEvent.click(screen.getByText('Заказчик — открыть карточку'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent(`/reputation/profiles/${PROFILE_COUNTERPARTY}`);
  });
});

/**
 * Предпросмотр собственной карточки «как гость» (замечание владельца 05.09:
 * «при просмотре своей карточки „как гость“ на десктопе не понятно как
 * вернуться обратно — зависает в неопределённости; общее решение и для
 * мобильного»). Полоса — только владельцу и только на ПУБЛИЧНОМ `/@хендл`,
 * который идёт вне оболочки приложения.
 */
describe('ReputationCardPage — полоса предпросмотра «как гость»', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('владелец на своём /@хендле видит полосу с текстом и выходом', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    renderPage('/@godwin');
    const bar = await screen.findByTestId('preview-bar');
    expect(within(bar).getByText('Вы смотрите свою карточку как гость')).toBeInTheDocument();
    expect(within(bar).getByText('Вернуться в профиль')).toBeInTheDocument();
  });

  it('клик по «Вернуться в профиль» ведёт в профиль владельца', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    renderPage('/@godwin');
    await userEvent.click(await screen.findByTestId('preview-bar-back'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/me');
  });

  it('выход из режима один — в полосе; дубля в действиях шапки нет', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    renderPage('/@godwin');
    await screen.findByTestId('preview-bar');
    // Полоса липкая, второй кнопки «назад» рядом с «Поделиться» быть не должно.
    expect(await screen.findByText('Поделиться')).toBeInTheDocument();
    expect(screen.queryByText('В профиль')).not.toBeInTheDocument();
    expect(screen.getAllByText('Вернуться в профиль')).toHaveLength(1);
  });

  it('гость на чужой карточке полосы не видит', async () => {
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    expect(screen.queryByTestId('preview-bar')).not.toBeInTheDocument();
  });

  it('авторизованный на ЧУЖОЙ карточке полосы не видит', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    renderPage('/@akovalev');
    await screen.findByText('Артём Ковалёв');
    // ждём, пока приедет /users/me и действия шапки перерисуются на «свой/чужой»
    expect(await screen.findByTestId('save-contact')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-bar')).not.toBeInTheDocument();
  });

  it('гость на карточке владельца (без сессии) полосы не видит', async () => {
    renderPage('/@godwin');
    await screen.findByText('Годвин');
    expect(screen.queryByTestId('preview-bar')).not.toBeInTheDocument();
  });

  it('внутри оболочки (/reputation/profiles/:id) полосы нет — там своя навигация', async () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    renderPage('/reputation/profiles/pf-person-1');
    await screen.findByText('Годвин');
    expect(screen.queryByTestId('preview-bar')).not.toBeInTheDocument();
  });
});
