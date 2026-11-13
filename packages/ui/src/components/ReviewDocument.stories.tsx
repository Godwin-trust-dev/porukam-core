import type { Meta, StoryObj } from '@storybook/react';
import { ReviewDocument } from './ReviewDocument';

const meta: Meta<typeof ReviewDocument> = {
  title: 'Компоненты/ReviewDocument',
  component: ReviewDocument,
};
export default meta;
type Story = StoryObj<typeof ReviewDocument>;

export const Default: Story = {
  args: {
    sectionTitles: {
      parties: 'Стороны',
      essence: 'Суть',
      stages: 'Этапы',
      terms: 'Условия',
      requisites: 'Реквизиты',
    },
    parties: [
      { id: 'p1', name: 'Годвин', roleLabel: 'Заказчик', handle: '@godwin' },
      { id: 'p2', name: 'Мастер Ремонт', roleLabel: 'Исполнитель', handle: '@masterremont' },
    ],
    essenceText: 'Ремонт кухни · Ремонт. 3 оплачиваемых этапа, общая сумма 120 000 ₽.',
    stages: [
      { id: 'ms-1', itemRef: 'milestone:ms-1:amount', label: 'Демонтаж', amountLabel: '20 000 ₽', proposable: true },
      { id: 'ms-2', itemRef: 'milestone:ms-2:amount', label: 'Черновые работы', amountLabel: '50 000 ₽', proposable: true },
      { id: 'ms-3', itemRef: 'milestone:ms-3:amount', label: 'Чистовая отделка', amountLabel: '50 000 ₽', proposable: true },
    ],
    stagesSumLabel: 'Сумма этапов',
    stagesSum: '120 000 ₽',
    terms: [
      { itemRef: 'term:warranty', label: 'Гарантия', value: '12 мес.', proposable: true },
      { itemRef: 'term:acceptance_window', label: 'Окно приёмки', value: '3 дн.', proposable: true },
    ],
    requisitesText: undefined,
    proposeLabel: 'Предложить правку',
    onPropose: () => {},
  },
};
