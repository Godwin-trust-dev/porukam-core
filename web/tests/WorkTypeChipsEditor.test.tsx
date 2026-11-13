import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { WorkTypeChipsEditor } from '../src/features/profile/WorkTypeChipsEditor';

/**
 * «Сфера → её виды работ» (ADR-190/191) — компонент, общий для профиля
 * (`ProfileSettingsPage`) и панели фильтров поиска (`SearchPage`): под КАЖДОЙ
 * сферой из `spheres` разворачивается список её видов работ (`GET
 * /v1/work-types?sphere=`), множественный выбор. Тесты страниц-потребителей —
 * `OwnerProfile.components.test.tsx`/`SearchCatalogFilters.test.tsx`; здесь —
 * поведение самого компонента в изоляции.
 */

function Harness({ initialSpheres, initialValue, max }: { initialSpheres: string[]; initialValue: string[]; max?: number }): JSX.Element {
  const [spheres, setSpheres] = useState(initialSpheres);
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <button type="button" data-testid="drop-repair" onClick={() => setSpheres((s) => s.filter((c) => c !== 'repair'))}>
        drop repair
      </button>
      <WorkTypeChipsEditor spheres={spheres} value={value} onChange={setValue} max={max} />
      <div data-testid="value-out">{value.join(',')}</div>
    </>
  );
}

function renderHarness(props: { initialSpheres: string[]; initialValue: string[]; max?: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <Harness {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('WorkTypeChipsEditor (ADR-190/191)', () => {
  it('без сфер — ничего не рендерит', () => {
    const { container } = renderHarness({ initialSpheres: [], initialValue: [] });
    expect(screen.queryByTestId('profile-work-types')).not.toBeInTheDocument();
    // Единственное содержимое DOM — служебные элементы каркаса (кнопка/value-out).
    expect(within(container).queryByTestId('profile-work-types')).toBeNull();
  });

  it('под сферой разворачивается список её видов работ — множественный выбор', async () => {
    renderHarness({ initialSpheres: ['repair'], initialValue: [] });

    const group = await screen.findByTestId('profile-work-types-group-repair');
    expect(within(group).getByText('Ремонт кухни')).toBeInTheDocument();
    expect(within(group).getByText('Ремонт ванной')).toBeInTheDocument();

    const kitchen = within(group).getByTestId('work-type-repair.repair_kitchen');
    const bathroom = within(group).getByTestId('work-type-repair.repair_bathroom');
    expect(kitchen).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(kitchen);
    expect(kitchen).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('value-out')).toHaveTextContent('repair.repair_kitchen'));

    // Второй выбор ДОБАВЛЯЕТСЯ, не заменяет первый — множественный выбор.
    await userEvent.click(bathroom);
    await waitFor(() => expect(screen.getByTestId('value-out')).toHaveTextContent('repair.repair_kitchen,repair.repair_bathroom'));

    // Повторный клик по уже выбранному — снимает выбор.
    await userEvent.click(kitchen);
    await waitFor(() => expect(screen.getByTestId('value-out')).toHaveTextContent('repair.repair_bathroom'));
    expect(screen.getByTestId('value-out')).not.toHaveTextContent('repair_kitchen');
  });

  it('несколько сфер сразу — под каждой свой список, коды не путаются между сферами', async () => {
    renderHarness({ initialSpheres: ['repair', 'plumbing'], initialValue: [] });

    const repairGroup = await screen.findByTestId('profile-work-types-group-repair');
    const plumbingGroup = await screen.findByTestId('profile-work-types-group-plumbing');
    expect(within(plumbingGroup).getByText('Монтаж сантехники')).toBeInTheDocument();

    await userEvent.click(within(plumbingGroup).getByTestId('work-type-plumbing.plumbing_install'));
    await waitFor(() => expect(screen.getByTestId('value-out')).toHaveTextContent('plumbing.plumbing_install'));
    // Список «Ремонта» не затронут выбором в другой сфере.
    expect(within(repairGroup).getByTestId('work-type-repair.repair_kitchen')).toHaveAttribute('aria-pressed', 'false');
  });

  it('снятие сферы прячет её группу, но НЕ трогает `value` само по себе (ADR-191 — чистка значения ЗА вызывающей стороной)', async () => {
    renderHarness({ initialSpheres: ['repair', 'plumbing'], initialValue: ['repair.repair_kitchen', 'plumbing.plumbing_install'] });

    await screen.findByTestId('profile-work-types-group-repair');
    expect(screen.getByTestId('value-out')).toHaveTextContent('repair.repair_kitchen,plumbing.plumbing_install');

    await userEvent.click(screen.getByTestId('drop-repair'));

    // Группа «Ремонта» пропала с экрана — рендерить нечего без сферы...
    await waitFor(() => expect(screen.queryByTestId('profile-work-types-group-repair')).not.toBeInTheDocument());
    // ...но код `repair.repair_kitchen` остался в значении: компонент сам
    // `value` не чистит (иначе прямая ссылка на фильтр поиска с одним
    // `work_type=`, без выбранной сферы в этом же URL, лишилась бы параметра
    // при первом же рендере — ADR-190 §3, сфера и вид работ независимы).
    // Чистка при РЕАЛЬНОМ снятии сферы — в обработчике `SphereChipsEditor.onChange`
    // вызывающей страницы (`ProfileSettingsPage`/`SearchPage`), не здесь.
    expect(screen.getByTestId('value-out')).toHaveTextContent('repair.repair_kitchen,plumbing.plumbing_install');
  });

  it('лимит (`max`) — новые чипы недоступны, уже выбранные остаются кликабельными', async () => {
    renderHarness({ initialSpheres: ['repair'], initialValue: ['repair.repair_kitchen'], max: 1 });

    const group = await screen.findByTestId('profile-work-types-group-repair');
    const kitchen = within(group).getByTestId('work-type-repair.repair_kitchen');
    const bathroom = within(group).getByTestId('work-type-repair.repair_bathroom');
    expect(kitchen).not.toBeDisabled();
    expect(bathroom).toBeDisabled();

    // Снятие уже выбранного освобождает лимит.
    await userEvent.click(kitchen);
    await waitFor(() => expect(within(group).getByTestId('work-type-repair.repair_bathroom')).not.toBeDisabled());
  });
});
