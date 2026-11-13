import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';
import { ContractStatus } from './ContractStatus';
import { ListRow } from './ListRow';
import { Surface } from './Surface';

const meta: Meta<typeof ListRow> = {
  title: 'Компоненты/ListRow',
  component: ListRow,
};
export default meta;
type Story = StoryObj<typeof ListRow>;

/** Приёмка DEV-20 §9 / DEV-20_2 §12: смотреть на 360 · 768 · 1440 — плотность одна на всех. */
const PHONE = { viewport: { defaultViewport: 'w360' } };
const DESKTOP = { viewport: { defaultViewport: 'w1440' } };

const DEALS = [
  { title: 'Аренда квартиры', who: 'Мария Соколова', role: 'вы исполнитель', status: 'rejected_by_counterparty', label: 'отклонён', amount: '— ₽' },
  { title: 'Продажа — личное имущество', who: 'Мария Соколова', role: 'наличные', status: 'under_warranty', label: 'гарантия', amount: '200 ₽' },
  { title: 'Аренда квартиры', who: 'Иван Петров', role: 'вы заказчик', status: 'under_review', label: 'согласование', amount: '45 000 ₽' },
  { title: 'Ремонт кухни', who: 'Анна Ковалёва', role: 'этап 3/5', status: 'in_progress', label: 'в работе', amount: '120 000 ₽' },
  { title: 'Логотип для кафе', who: 'Дмитрий Волков', role: 'этап 1/3', status: 'signed', label: 'защита', amount: '25 000 ₽' },
  { title: 'Тексты для лендинга', who: 'София Мельник', role: 'вы заказчик', status: 'draft', label: 'черновик', amount: '18 000 ₽' },
] as const;

export const Строка: Story = {
  args: {
    avatarName: 'Анна Ковалёва',
    title: 'Ремонт кухни',
    meta: 'Анна Ковалёва · вы исполнитель · этап 3/5',
    status: <ContractStatus status="in_progress" label="в работе" appearance="word" />,
    amount: '120 000 ₽',
    onOpen: () => {},
  },
  parameters: PHONE,
  render: (args) => (
    <Surface>
      <ListRow {...args} />
    </Surface>
  ),
};

/** Ключевая проверка §9: ~6 договоров на экран телефона. */
export const СписокНаТелефоне: Story = {
  parameters: PHONE,
  render: () => (
    <Surface>
      {DEALS.map((d) => (
        <ListRow
          key={`${d.title}-${d.who}-${d.amount}`}
          avatarName={d.who}
          title={d.title}
          meta={`${d.who} · ${d.role}`}
          status={<ContractStatus status={d.status} label={d.label} appearance="word" />}
          amount={d.amount}
          onOpen={() => {}}
        />
      ))}
    </Surface>
  ),
};

/** Та же плотность и те же строки на десктопе (§9): ширина добирается раскладкой, не воздухом. */
export const СписокНаДесктопе: Story = {
  ...СписокНаТелефоне,
  parameters: DESKTOP,
};

export const СостоянияСтроки: Story = {
  parameters: { viewport: { defaultViewport: 'w768' } },
  render: () => (
    <Surface>
      <ListRow
        avatarName="Анна Ковалёва"
        title="Выбрана (master-detail)"
        meta="Анна Ковалёва · вы исполнитель"
        status={<ContractStatus status="in_progress" label="в работе" appearance="word" />}
        amount="120 000 ₽"
        selected
        onOpen={() => {}}
      />
      <ListRow
        avatarName="Дмитрий Волков"
        title="Непрочитанное"
        titleAside={<span>12:40</span>}
        meta="Логотип для кафе · Скинул варианты"
        metaAside={<Badge tone="amber" size="sm">2</Badge>}
        unread
        unreadAriaLabel="Непрочитано"
        onOpen={() => {}}
      />
      <ListRow
        avatarName="Кирилл Носов"
        title="Приглушённая (терминальный статус)"
        meta="Кирилл Носов · вы исполнитель"
        status={<ContractStatus status="terminated_by_customer" label="закрыт" appearance="word" />}
        amount="7 000 ₽"
        muted
        onOpen={() => {}}
      />
    </Surface>
  ),
};
