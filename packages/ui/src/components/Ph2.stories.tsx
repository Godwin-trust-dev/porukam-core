import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ScreenTabs } from './ScreenTabs';
import { Modal } from './Modal';
import { Callout } from './Callout';
import { MoneyBreakdown } from './MoneyBreakdown';
import { Stepper } from './Stepper';
import { Button } from './Button';

const meta: Meta = { title: 'Компоненты/Договорный контур (Ф2)' };
export default meta;
type Story = StoryObj;

export const TabsStory: Story = {
  name: 'ScreenTabs',
  render: () => {
    const [a, setA] = useState('overview');
    return (
      <ScreenTabs
        active={a}
        onChange={setA}
        allowExtra
        items={[
          { key: 'overview', label: 'Обзор' },
          { key: 'stages', label: 'Этапы', count: 3 },
          { key: 'nego', label: 'Согласование', count: 2 },
          { key: 'sign', label: 'Подписание' },
        ]}
      />
    );
  },
};

export const Breakdown: Story = {
  name: 'MoneyBreakdown',
  render: () => (
    <MoneyBreakdown
      rows={[
        { label: 'Сумма договора', money: { amount: '120000.00', currency: 'RUB' } },
        { label: 'Комиссия за заключение (по шкале)', money: { amount: '1020.00', currency: 'RUB' } },
      ]}
      total={{ label: 'Итого к подписанию', money: { amount: '121020.00', currency: 'RUB' } }}
      caption="Раскладка показана до подписания (§9.4). Платежи — 0% комиссии платформы."
    />
  ),
};

export const Callouts: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
      <Callout tone="operator" title="Платформа — оператор, а не сторона сделки">
        Договор заключается между вами и контрагентом. Платформа обеспечивает процесс и доказательства.
      </Callout>
      <Callout tone="warn" title="Нестандартный бланк">
        Вы используете свободную редакцию текста. Проверьте формулировки — платформенный шаблон надёжнее.
      </Callout>
      <Callout tone="neutral">Без усиленной доказательной защиты — веб-загрузка файлов.</Callout>
    </div>
  ),
};

export const StepperStory: Story = {
  name: 'Stepper',
  render: () => <Stepper steps={['Тип', 'Стороны', 'Защита', 'Готово']} current={2} ariaLabel="Шаг 3 из 4" />,
};

export const ModalStory: Story = {
  name: 'Modal',
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Открыть</Button>
        <Modal
          open={open}
          title="Принять все правки?"
          onClose={() => setOpen(false)}
          closeLabel="Закрыть"
          actions={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Подтвердить
              </Button>
            </>
          }
        >
          <p>Сумма: 4 000 ₽ → 4 500 ₽</p>
        </Modal>
      </>
    );
  },
};
