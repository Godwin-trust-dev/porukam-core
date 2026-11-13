import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, MoneyField } from '@porukam/ui';

describe('Button (состояния)', () => {
  it('loading → aria-busy и disabled, клик не проходит', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        По рукам
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disabled не кликается', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Неактивная
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('обычная кнопка кликается', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Обычная</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('MoneyField (сумма + валюта, без дефолтной валюты)', () => {
  it('рендерит сумму и селектор валюты; пустая валюта — плейсхолдер', () => {
    render(<MoneyField label="Сумма" amount="15000.00" currency="" amountAriaLabel="Сумма" currencyAriaLabel="Валюта" currencyPlaceholder="валюта" />);
    expect(screen.getByLabelText('Сумма')).toHaveValue('15000.00');
    // Валюта не выбрана по умолчанию — селект в пустом состоянии.
    expect(screen.getByLabelText('Валюта')).toHaveValue('');
  });
});
