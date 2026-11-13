import type { Meta, StoryObj } from '@storybook/react';
import { PreviewStep } from './PreviewStep';
import { previewStepFixtureLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof PreviewStep> = {
  title: 'Компоненты/PreviewStep',
  component: PreviewStep,
};
export default meta;
type Story = StoryObj<typeof PreviewStep>;

export const Ready: Story = {
  args: {
    title: 'Ремонт кухни «под ключ»',
    sphere: 'Ремонт',
    kindLabel: 'Услуга',
    parties: [
      { name: 'Годвин', role: 'Заказчик' },
      { name: 'Мастер Ремонт', role: 'Исполнитель', handle: '@masterremont' },
    ],
    bodySummary: 'Демонтаж старого гарнитура, черновая отделка, монтаж нового. Место: г. Москва, ул. Ленина, д. 5.',
    stages: [
      { id: '1', ix: 1, name: 'Демонтаж', sum: { amount: '20000.00', currency: 'RUB' }, status: 'waiting_gate', statusLabel: 'Этап' },
      { id: '2', ix: 2, name: 'Отделка', sum: { amount: '50000.00', currency: 'RUB' }, status: 'waiting_gate', statusLabel: 'Этап' },
    ],
    total: { amount: '70000.00', currency: 'RUB' },
    durationDaysTotal: 14,
    terms: [
      { label: 'Гарантия', value: '12 месяцев' },
      { label: 'Окно приёмки', value: '3 дня' },
    ],
    validationIssues: [],
    onSend: () => {},
    onBack: () => {},
    backLabel: 'Назад',
    ...previewStepFixtureLabels,
  },
};

export const Blocked: Story = {
  name: 'Заблокирована отправка',
  args: {
    ...Ready.args,
    stages: [],
    validationIssues: ['Добавьте хотя бы один этап', 'Укажите срок для каждого этапа'],
  },
};
