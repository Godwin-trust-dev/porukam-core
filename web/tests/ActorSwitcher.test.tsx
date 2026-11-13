import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActorSwitcher, type ActorSwitcherOrg } from '@porukam/ui';

const personal = { id: 'pf-person-1', name: 'Годвин' };
const orgs: ActorSwitcherOrg[] = [
  { id: 'pf-biz-1', name: 'Мастер Ремонт', kind: 'ИП', subtitle: '@master' },
  { id: 'pf-biz-2', name: 'СтройБыт', kind: 'ООО', subtitle: '@stroybyt' },
];

function setup(current = 'pf-person-1') {
  const onSelect = vi.fn();
  const onAddOrg = vi.fn();
  const onOpenCurrent = vi.fn();
  render(
    <ActorSwitcher
      current={current}
      personal={personal}
      orgs={orgs}
      onSelect={onSelect}
      onOpenCurrent={onOpenCurrent}
      onAddOrg={onAddOrg}
      triggerLabel="Сменить профиль"
      personalLabel="Личный"
      addOrgLabel="Добавить организацию"
      initialOpen
    />,
  );
  return { onSelect, onAddOrg, onOpenCurrent };
}

describe('ActorSwitcher — объединения лидера (ADR-118)', () => {
  it('строка объединения открывает карточку, актёр не меняется', async () => {
    const onSelect = vi.fn();
    const onOpenGroup = vi.fn();
    render(
      <ActorSwitcher
        current="pf-person-1"
        personal={personal}
        orgs={[]}
        onSelect={onSelect}
        groups={[{ id: 'grp-1', name: 'Мастера отделки', subtitle: '@masters_otdelki · Гильдия' }]}
        onOpenGroup={onOpenGroup}
        groupsLabel="Мои объединения"
        triggerLabel="Сменить профиль"
        personalLabel="Личный"
        addOrgLabel="Добавить организацию"
        initialOpen
      />,
    );
    const row = screen.getByTestId('actor-group-grp-1');
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(row).toHaveTextContent('Мои объединения · @masters_otdelki · Гильдия');
    await userEvent.click(row);
    expect(onOpenGroup).toHaveBeenCalledWith('grp-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('без onOpenGroup объединения не показываются', () => {
    render(
      <ActorSwitcher
        current="pf-person-1"
        personal={personal}
        orgs={[]}
        onSelect={() => {}}
        groups={[{ id: 'grp-1', name: 'Мастера отделки' }]}
        triggerLabel="Сменить профиль"
        personalLabel="Личный"
        addOrgLabel="Добавить организацию"
        initialOpen
      />,
    );
    expect(screen.queryByTestId('actor-group-grp-1')).not.toBeInTheDocument();
  });
});

describe('ActorSwitcher — фото в шапке (ADR-103)', () => {
  it('с avatarUrl в триггере и в строке меню картинка, без него — инициал', () => {
    render(
      <ActorSwitcher
        current="pf-person-1"
        personal={{ ...personal, avatarUrl: '/v1/profiles/pf-person-1/avatar?size=256' }}
        orgs={orgs}
        onSelect={() => {}}
        triggerLabel="Сменить профиль"
        personalLabel="Личный"
        addOrgLabel="Добавить организацию"
        initialOpen
      />,
    );
    const trigger = screen.getByTestId('actor-trigger');
    expect(within(trigger).getByRole('presentation')).toHaveAttribute('src', '/v1/profiles/pf-person-1/avatar?size=256');
    // Имя остаётся в DOM (на узком экране прячется стилями) — a11y и тесты не теряют его.
    expect(screen.getByTestId('actor-active')).toHaveTextContent('Годвин');
    const own = screen.getByTestId('actor-option-pf-person-1');
    expect(within(own).getByRole('presentation')).toBeInTheDocument();
    const org = screen.getByTestId('actor-option-pf-biz-1');
    expect(within(org).queryByRole('presentation')).not.toBeInTheDocument();
    expect(org).toHaveTextContent('М');
  });
});

describe('ActorSwitcher (DEV-shell)', () => {
  it('рендерит личный аккаунт, все организации и «Добавить организацию»', () => {
    setup();
    const listbox = screen.getByRole('listbox');
    const rows = within(listbox);
    expect(rows.getByText('Годвин')).toBeInTheDocument();
    expect(rows.getByText('Мастер Ремонт')).toBeInTheDocument();
    expect(rows.getByText('СтройБыт')).toBeInTheDocument();
    expect(rows.getByText('Добавить организацию')).toBeInTheDocument();
  });

  it('личный аккаунт без организаций рендерится без ошибок', () => {
    const onSelect = vi.fn();
    render(
      <ActorSwitcher
        current="pf-person-1"
        personal={personal}
        orgs={[]}
        onSelect={onSelect}
        onAddOrg={() => {}}
        triggerLabel="Сменить профиль"
        personalLabel="Личный аккаунт"
        addOrgLabel="Добавить организацию"
        initialOpen
      />,
    );
    expect(screen.getByTestId('actor-option-pf-person-1')).toBeInTheDocument();
    expect(screen.getByTestId('actor-option-add-org')).toBeInTheDocument();
  });

  it('активная организация отмечена галочкой и показана в триггере', () => {
    setup('pf-biz-2');
    expect(screen.getByTestId('actor-active')).toHaveTextContent('СтройБыт');
    expect(screen.getByTestId('actor-option-pf-biz-2')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('actor-option-pf-person-1')).toHaveAttribute('aria-selected', 'false');
  });

  it('клик по организации вызывает onSelect с её id', async () => {
    const { onSelect } = setup();
    await userEvent.click(screen.getByTestId('actor-option-pf-biz-2'));
    expect(onSelect).toHaveBeenCalledWith('pf-biz-2');
  });

  it('личный профиль подписан «Фамилия Имя» + пометка «Личный», не «Личный аккаунт»', () => {
    setup();
    const row = screen.getByTestId('actor-option-pf-person-1');
    expect(within(row).getByText('Годвин')).toBeInTheDocument();
    expect(within(row).getByText('Личный')).toBeInTheDocument();
    expect(screen.getByTestId('actor-active')).toHaveTextContent('Годвин');
  });

  it('клик по УЖЕ активному актёру открывает его профиль (onOpenCurrent), а не onSelect', async () => {
    const { onSelect, onOpenCurrent } = setup('pf-person-1');
    await userEvent.click(screen.getByTestId('actor-option-pf-person-1'));
    expect(onOpenCurrent).toHaveBeenCalledWith('pf-person-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('клик по «Добавить организацию» вызывает onAddOrg, а не onSelect', async () => {
    const { onSelect, onAddOrg } = setup();
    await userEvent.click(screen.getByTestId('actor-option-add-org'));
    expect(onAddOrg).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('клавиатура: стрелки двигают виртуальный фокус (aria-activedescendant), Enter выбирает', async () => {
    const { onSelect } = setup();
    const listbox = screen.getByRole('listbox');
    listbox.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(listbox).toHaveAttribute('aria-activedescendant', 'actor-switcher-listbox-pf-biz-1');

    await userEvent.keyboard('{ArrowDown}');
    expect(listbox).toHaveAttribute('aria-activedescendant', 'actor-switcher-listbox-pf-biz-2');

    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('pf-biz-2');
  });

  it('Escape закрывает меню и возвращает фокус на триггер', async () => {
    setup();
    const listbox = screen.getByRole('listbox');
    listbox.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('actor-trigger')).toHaveFocus();
  });
});

describe('ActorSwitcher — «Выйти» (замечание владельца 07.09)', () => {
  it('пункт есть последним и вызывает onLogout', async () => {
    const onLogout = vi.fn();
    const onSelect = vi.fn();
    render(
      <ActorSwitcher
        current="pf-person-1"
        personal={personal}
        orgs={orgs}
        onSelect={onSelect}
        onAddOrg={() => {}}
        onLogout={onLogout}
        logoutLabel="Выйти"
        triggerLabel="Сменить профиль"
        personalLabel="Личный"
        addOrgLabel="Добавить организацию"
        initialOpen
      />,
    );
    const options = screen.getAllByRole('option');
    const row = screen.getByTestId('logout');
    // Последним: выход — конец сессии, а не ещё один актёр в списке.
    expect(options[options.length - 1]).toBe(row);
    expect(row).toHaveTextContent('Выйти');
    // Не актёр: галки «выбрано» у него быть не может ни при каком current.
    expect(row).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(row);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('без onLogout пункта нет (старые вызовы не меняются)', () => {
    setup();
    expect(screen.queryByTestId('logout')).not.toBeInTheDocument();
  });
});
