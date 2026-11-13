import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PassportHeader, PhotoViewer, RoleSwitch, SphereRow, TrustNumber, zoneOf } from '@porukam/ui';

describe('RoleSwitch (DEV-01)', () => {
  it('клик по неактивному табу вызывает onChange', async () => {
    const onChange = vi.fn();
    render(
      <RoleSwitch value="contractor" onChange={onChange} contractorLabel="Исполнитель" customerLabel="Заказчик" />,
    );
    await userEvent.click(screen.getByTestId('role-switch-customer'));
    expect(onChange).toHaveBeenCalledWith('customer');
  });

  it('roving tabindex: активный таб — 0, остальные — -1; стрелка меняет выбор', async () => {
    const onChange = vi.fn();
    render(
      <RoleSwitch value="contractor" onChange={onChange} contractorLabel="Исполнитель" customerLabel="Заказчик" />,
    );
    expect(screen.getByTestId('role-switch-contractor')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('role-switch-customer')).toHaveAttribute('tabindex', '-1');

    screen.getByTestId('role-switch-contractor').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('customer');
  });
});

describe('SphereRow (ADR-163)', () => {
  it('доля продублирована ТЕКСТОМ, а не только цветом полосы', () => {
    render(
      <SphereRow
        name="Ремонт"
        onTime={{ done: 141, total: 156 }}
        onTimeLabel="141 из 156 сделано в срок"
        progressAriaLabel="Сделано в срок: 141 из 156"
        firstTimeLabel="150 из 156 принято с первого раза"
        notes={['1 спор · решён скидкой']}
      />,
    );
    expect(screen.getByText('Ремонт')).toBeInTheDocument();
    expect(screen.getByText('141 из 156 сделано в срок')).toBeInTheDocument();
    expect(screen.getByText('150 из 156 принято с первого раза')).toBeInTheDocument();
    expect(screen.getByText('1 спор · решён скидкой')).toBeInTheDocument();
    // Процент — тоже словом (90 %), а не только шириной заливки.
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('объёма в строке НЕТ: он считается, но публично не показывается (ADR-163 §4)', () => {
    const { container } = render(
      <SphereRow
        name="Ремонт"
        onTime={{ done: 141, total: 156 }}
        onTimeLabel="141 из 156 сделано в срок"
        progressAriaLabel="Сделано в срок: 141 из 156"
      />,
    );
    expect(container.textContent).not.toMatch(/₽|RUB/);
  });

  it('total=0 — полосы нет вовсе, это не красная зона', () => {
    render(
      <SphereRow
        name="Репетиторство"
        onTime={{ done: 0, total: 0 }}
        onTimeLabel=""
        progressAriaLabel=""
        firstTimeLabel="3 из 3 принято с первого раза"
      />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('клик по строке вызывает onClick', async () => {
    const onClick = vi.fn();
    render(
      <SphereRow
        name="Электрика"
        onTime={{ done: 20, total: 21 }}
        onTimeLabel="20 из 21 сделано в срок"
        progressAriaLabel="Сделано в срок: 20 из 21"
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Электрика/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('zoneOf (ADR-163 §3)', () => {
  it('до трети — красная, до двух третей — оранжевая, выше — зелёная', () => {
    expect(zoneOf({ done: 32, total: 100 })).toBe('red');
    expect(zoneOf({ done: 50, total: 100 })).toBe('amber');
    expect(zoneOf({ done: 66, total: 100 })).toBe('green');
  });

  it('нечего мерить — зоны нет (null), а не красная', () => {
    expect(zoneOf({ done: 0, total: 0 })).toBeNull();
  });
});

describe('TrustNumber (DEV-01)', () => {
  it('форматирует число и объём (сумма+валюта)', () => {
    render(
      <TrustNumber
        count={198}
        volume={{ amount: '57300000.00', currency: 'RUB' }}
        completedLabel="завершённых договоров"
        volumeLabel="объём"
        sinceLabel="С 2019 года"
      />,
    );
    expect(screen.getByText('198')).toBeInTheDocument();
    expect(screen.getByText('завершённых договоров')).toBeInTheDocument();
    expect(screen.getByText(/57\s?300\s?000\s?₽/)).toBeInTheDocument();
    expect(screen.getByText('С 2019 года')).toBeInTheDocument();
  });
});

describe('PhotoViewer (DEV-01)', () => {
  it('открывается, Esc закрывает', async () => {
    const onClose = vi.fn();
    render(<PhotoViewer open src="/x.jpg" name="Артём Ковалёв" onClose={onClose} closeLabel="Закрыть просмотр фото" />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('крестик закрывает', async () => {
    const onClose = vi.fn();
    render(<PhotoViewer open src="/x.jpg" onClose={onClose} closeLabel="Закрыть просмотр фото" />);
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть просмотр фото' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closed=false ничего не рендерит', () => {
    const { container } = render(<PhotoViewer open={false} onClose={() => {}} closeLabel="Закрыть просмотр фото" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PassportHeader (DEV-01)', () => {
  it('поверхность on-ink: показывает бейдж верификации и «из любого города»', () => {
    render(
      <PassportHeader
        surface="on-ink"
        name="Артём Ковалёв"
        handle="@akovalev"
        verification="id"
        verificationLabel="Личность подтверждена"
        city="Москва"
        remote
        remoteLabel="Из любого города"
        expandLabel="Развернуть фото профиля"
        actions={<button type="button">Написать</button>}
      />,
    );
    expect(screen.getByText('Артём Ковалёв')).toBeInTheDocument();
    expect(screen.getByText('@akovalev')).toBeInTheDocument();
    expect(screen.getByText('Личность подтверждена')).toBeInTheDocument();
    expect(screen.getByText('Из любого города')).toBeInTheDocument();
  });

  it('поверхность light: рендерится без ошибок, действия переданы снаружи', () => {
    const { container } = render(
      <PassportHeader
        surface="light"
        handle="@newuser"
        verification="none"
        verificationLabel="Не подтверждён"
        expandLabel="Развернуть фото профиля"
        actions={<button type="button">Скачать приложение</button>}
      />,
    );
    expect(within(container).getByText('Не подтверждён')).toBeInTheDocument();
    expect(within(container).getByText('Скачать приложение')).toBeInTheDocument();
  });
});
