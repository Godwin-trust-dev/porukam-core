import type { Meta, StoryObj } from '@storybook/react';
import { Callout } from './Callout';
import { Disclosure } from './Disclosure';

const meta: Meta<typeof Disclosure> = {
  title: 'Компоненты/Disclosure',
  component: Disclosure,
};
export default meta;
type Story = StoryObj<typeof Disclosure>;

const PHONE = { viewport: { defaultViewport: 'w360' } };

/** Текстовый триггер в потоке — прежнее поведение (управляемый режим). */
export const Ссылкой: Story = {
  args: { open: false, onToggle: () => {}, label: 'Как это работает', children: 'Содержимое' },
};

export const СсылкойРаскрыта: Story = {
  args: { open: true, onToggle: () => {}, label: 'Как это работает', children: 'Содержимое раскрыто' },
};

/**
 * Приёмка DEV-20_2 §12: вторичные и юр-блоки СВЁРНУТЫ по умолчанию, счётчик
 * стоит в заголовке, раскрытие идёт на всю ширину блока.
 */
export const ВторичныеБлокиЭкрана: Story = {
  parameters: PHONE,
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      <Callout tone="operator" collapsible title="Платформа — оператор, а не сторона сделки">
        Мы фиксируем факты и храним доказательства. Стороны договора — вы и контрагент.
      </Callout>
      <Disclosure variant="row" tone="attention" label="Замечания" count={3}>
        <ul style={{ margin: 0, paddingInlineStart: 16, display: 'grid', gap: 8 }}>
          <li>Сумма этапов не совпадает с суммой договора</li>
          <li>Не указан срок последнего этапа</li>
          <li>Способ расчёта — вне платформы</li>
        </ul>
      </Disclosure>
      <Disclosure variant="row" label="Детали расчёта">
        Сумма этапа · срок оплаты · что происходит после приёмки.
      </Disclosure>
      <Disclosure variant="row" label="Как решаются споры">
        Разногласие открывается по этапу, у сторон есть два раунда исправлений.
      </Disclosure>
    </div>
  ),
};
