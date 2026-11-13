import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { TextField, TextArea, SelectField, OtpField, MoneyField } from './Field';

const meta: Meta = {
  title: 'Компоненты/Поля',
};
export default meta;
type Story = StoryObj;

export const Text: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 420 }}>
      <TextField label="Номер телефона" placeholder="+7 900 000-00-00" />
      <TextField label="С подсказкой" hint="Хендл — это не подтверждённая личность" defaultValue="@masterremont" />
      <TextField label="С ошибкой" error="Неверный код. Проверьте и попробуйте снова." defaultValue="000" />
      <TextField label="Неактивное" disabled defaultValue="нельзя менять" />
    </div>
  ),
};

export const Otp: Story = {
  render: () => {
    const [v, setV] = useState('');
    return (
      <div style={{ maxWidth: 260 }}>
        <OtpField label="Код подтверждения" value={v} onChange={(e) => setV(e.target.value)} />
      </div>
    );
  },
};

export const Textarea: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <TextArea label="Описание" placeholder="Опишите объём работ…" />
    </div>
  ),
};

export const Select: Story = {
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <SelectField label="Сфера" defaultValue="repair">
        <option value="repair">Ремонт</option>
        <option value="build">Строительство</option>
      </SelectField>
    </div>
  ),
};

export const Money: Story = {
  render: () => {
    const [amount, setAmount] = useState('15000.00');
    const [currency, setCurrency] = useState('RUB');
    return (
      <div style={{ maxWidth: 360 }}>
        <MoneyField
          label="Сумма этапа"
          hint="Валюты по умолчанию нет — выберите явно"
          amount={amount}
          currency={currency}
          onAmountChange={setAmount}
          onCurrencyChange={setCurrency}
          amountAriaLabel="Сумма"
          currencyAriaLabel="Валюта"
          currencyPlaceholder="валюта"
        />
      </div>
    );
  },
};

export const MoneyEmptyCurrency: Story = {
  render: () => {
    const [amount, setAmount] = useState('');
    const [currency, setCurrency] = useState('');
    return (
      <div style={{ maxWidth: 360 }}>
        <MoneyField
          label="Сумма (валюта не выбрана)"
          amount={amount}
          currency={currency}
          onAmountChange={setAmount}
          onCurrencyChange={setCurrency}
          amountAriaLabel="Сумма"
          currencyAriaLabel="Валюта"
          currencyPlaceholder="валюта"
        />
      </div>
    );
  },
};
