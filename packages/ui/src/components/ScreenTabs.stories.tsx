import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ScreenTabs } from './ScreenTabs';

const meta: Meta<typeof ScreenTabs> = {
  title: 'Компоненты/ScreenTabs',
  component: ScreenTabs,
};
export default meta;
type Story = StoryObj<typeof ScreenTabs>;

const PHONE = { viewport: { defaultViewport: 'w360' } };
const DESKTOP = { viewport: { defaultViewport: 'w1440' } };

function Demo({ items }: { items: { key: string; label: string; count?: number }[] }): JSX.Element {
  const [active, setActive] = useState(items[0]!.key);
  const [filtered, setFiltered] = useState(false);
  return (
    <ScreenTabs
      items={items}
      active={active}
      onChange={setActive}
      onOpenFilters={() => setFiltered((v) => !v)}
      filtersLabel="Фильтр"
      filtersActive={filtered}
    />
  );
}

/** Сделки: «Активные · Архив» + воронка (черновики и «все» — в шите). */
export const Сделки: Story = {
  parameters: PHONE,
  render: () => (
    <Demo items={[{ key: 'active', label: 'Активные', count: 4 }, { key: 'archive', label: 'Архив', count: 2 }]} />
  ),
};

/** Уведомления: «Все · Новые 10» + воронка. */
export const Уведомления: Story = {
  parameters: PHONE,
  render: () => <Demo items={[{ key: 'all', label: 'Все' }, { key: 'unread', label: 'Новые', count: 10 }]} />,
};

/**
 * Приёмка §12: полоса вкладок НЕ скроллится вбок ни на какой ширине. Лишние
 * вкладки не рендерятся вовсе — их место в шите по воронке, а длинное
 * название усекается многоточием.
 */
export const ЛишниеВкладкиНеРендерятся: Story = {
  parameters: PHONE,
  render: () => (
    <Demo
      items={[
        { key: 'active', label: 'Активные договоры и заявки', count: 4 },
        { key: 'archive', label: 'Архив', count: 2 },
        { key: 'drafts', label: 'Черновики', count: 1 },
        { key: 'all', label: 'Все', count: 7 },
      ]}
    />
  ),
};

/** Вкладки контента карточки — 3–4 коротких допустимы (`allowExtra`), но без бокового скролла. */
export const ВкладкиКарточки: Story = {
  parameters: DESKTOP,
  render: () => {
    const items = [
      { key: 'overview', label: 'Обзор' },
      { key: 'terms', label: 'Условия' },
      { key: 'stages', label: 'Этапы' },
      { key: 'pay', label: 'Оплата' },
    ];
    return <ScreenTabs items={items} active="overview" onChange={() => {}} allowExtra />;
  },
};
