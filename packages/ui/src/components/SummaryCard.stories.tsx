import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { SummaryCard, type SummaryStatLinkProps } from './SummaryCard';

/** Карточка сводки правого рейла дашборда (DEV-19 §3). */
const meta: Meta<typeof SummaryCard> = {
  title: 'Компоненты/SummaryCard',
  component: SummaryCard,
  decorators: [(Story) => <div style={{ maxWidth: 320 }}>{Story()}</div>],
};
export default meta;
type Story = StoryObj<typeof SummaryCard>;

export const Money: Story = {
  args: {
    eyebrow: 'Деньги в активных сделках',
    values: ['163 000 ₽'],
    stats: [
      { label: 'Активные', value: '3' },
      { label: 'Архив', value: '12' },
    ],
  },
};

/**
 * Несколько валют — по строке на каждую: Money не складывает разные валюты,
 * валюты по умолчанию в продукте нет (доменный инвариант).
 */
export const MultiCurrency: Story = {
  args: {
    eyebrow: 'Деньги в активных сделках',
    values: ['163 000 ₽', '2 400 $', '900 €'],
    stats: [
      { label: 'Активные', value: '5' },
      { label: 'Архив', value: '12' },
    ],
  },
};

/** Сделок ещё нет — сумма не выдумывается, а честно называется незаданной. */
export const NoDeals: Story = {
  args: {
    eyebrow: 'Деньги в активных сделках',
    note: 'Сумма не задана',
    stats: [
      { label: 'Активные', value: '0' },
      { label: 'Архив', value: '0' },
    ],
  },
};

/**
 * Плитки-счётчики как входы в раздел (решение владельца 05.09): «Активные» и
 * «Архив» ведут на соответствующую вкладку «Сделок». Маршруты знает страница —
 * она и передаёт компонент ссылки (`Link` роутера); в Storybook его роль
 * играет обычная `<a>`. Вид числа не меняется — ссылочность видна по
 * наведению и фокусу, нажимается вся плитка.
 */
function DemoLink({ to, className, children }: SummaryStatLinkProps): JSX.Element {
  return (
    <a href={to} className={className} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  );
}

export const LinkedStats: Story = {
  args: {
    eyebrow: 'Деньги в активных сделках',
    values: ['163 000 ₽'],
    statLinkAs: DemoLink,
    stats: [
      { label: 'Активные', value: '3', to: '/contracts' },
      { label: 'Архив', value: '12', to: '/contracts?tab=archive' },
    ],
  },
};

export const MiniProfile: Story = {
  render: () => (
    <SummaryCard eyebrow="Профиль">
      <div style={{ display: 'grid', gap: 'var(--pr-sp-2)' }}>
        <p style={{ margin: 0, fontFamily: 'var(--pr-font-head)', fontWeight: 700, fontSize: 'var(--pr-fs-h3)' }}>
          Анна Кузнецова
        </p>
        <span style={{ color: 'var(--pr-text-2)', fontSize: 'var(--pr-fs-sm)' }}>@anna.k</span>
        <p style={{ margin: 0, color: 'var(--pr-text-2)', fontSize: 'var(--pr-fs-sm)' }}>Появится после первых сделок</p>
        <Button variant="ghost" size="sm" onClick={() => {}}>
          Открыть карточку
        </Button>
      </div>
    </SummaryCard>
  ),
};
