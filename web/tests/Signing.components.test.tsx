import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AiSummaryCard,
  CommissionSection,
  EditContractLink,
  FeePaymentSbp,
  FrozenVersion,
  PaymentPolicyLine,
  SignatureRow,
} from '@porukam/ui';

describe('AiSummaryCard (DEV-05 §2) — одинаковый у обеих сторон', () => {
  it('рендерит все пункты резюме и вызывает onFullText', async () => {
    const onFullText = vi.fn();
    render(
      <AiSummaryCard
        badgeLabel="резюме"
        title="Проверьте перед подписанием"
        items={[
          { label: 'Что делаем', value: 'Ремонт кухни' },
          { label: 'Сумма', value: '120 000.00 RUB' },
        ]}
        fullTextLabel="Читать полный текст"
        onFullText={onFullText}
        disclaimer="Резюме не заменяет полный текст"
      />,
    );
    expect(screen.getByText('Ремонт кухни')).toBeInTheDocument();
    expect(screen.getByText('120 000.00 RUB')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Читать полный текст' }));
    expect(onFullText).toHaveBeenCalledOnce();
  });
});

describe('PaymentPolicyLine (DEV-05-PATCH §2) — тон и текст из paymentPolicy, без литералов', () => {
  it('free-политика (platformTakesCommission: false) → «без комиссии» с зелёным акцентом', () => {
    render(
      <PaymentPolicyLine title="Платежи — без комиссии" note="Комиссия за перевод не взимается платформой" positive />,
    );
    const title = screen.getByText('Платежи — без комиссии');
    expect(title).toBeInTheDocument();
    expect(title.closest('[data-tone]')).toHaveAttribute('data-tone', 'positive');
  });

  it('платная политика (platformTakesCommission: true) → нейтральная строка без зелёного акцента', () => {
    render(
      <PaymentPolicyLine
        title="Платежи — с комиссией за перевод"
        note="Тариф оператора списывается с плательщика"
        positive={false}
      />,
    );
    const title = screen.getByText('Платежи — с комиссией за перевод');
    expect(title.closest('[data-tone]')).toHaveAttribute('data-tone', 'neutral');
  });
});

describe('FrozenVersion (DEV-05 §2) — версия + hash укорочены, ссылки на состав', () => {
  it('показывает укороченный хеш и вызывает ссылки', async () => {
    const onStages = vi.fn();
    render(
      <FrozenVersion
        title="Что вы подписываете"
        version="Версия от 31 июля 2026"
        hashShort="a1b2c3d4e5f6a1b2…"
        hashLabel="Хеш целостности"
        tsaTime="2026-07-31T10:00:00.000Z"
        tsaLabel="Метка времени"
        links={{
          stagesLabel: 'Этапы',
          onStages,
          checklistsLabel: 'Чек-листы',
          onChecklists: () => {},
          materialsLabel: 'Материалы',
          onMaterials: () => {},
        }}
      />,
    );
    expect(screen.getByTestId('frozen-version-hash')).toHaveTextContent('a1b2c3d4e5f6a1b2…');
    await userEvent.click(screen.getByRole('button', { name: 'Этапы' }));
    expect(onStages).toHaveBeenCalledOnce();
  });

  // DEV-16c §2 ⭐ — LTR-островки: hash и TSA-время (дата подписания, юрзначимая — DEV-16 §5)
  // не должны зеркалиться в RTL-интерфейсе — независимо от общего dir экрана.
  it('hash и TSA-время — LTR-островки (dir="ltr"), не зависят от направления экрана', () => {
    render(
      <FrozenVersion
        title="Что вы подписываете"
        version="Версия от 31 июля 2026"
        hashShort="a1b2c3d4e5f6a1b2…"
        hashLabel="Хеш целостности"
        tsaTime="2026-07-31T10:00:00.000Z"
        tsaLabel="Метка времени"
        links={{
          stagesLabel: 'Этапы',
          onStages: () => {},
          checklistsLabel: 'Чек-листы',
          onChecklists: () => {},
          materialsLabel: 'Материалы',
          onMaterials: () => {},
        }}
      />,
    );
    expect(screen.getByTestId('frozen-version-hash')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('frozen-version-tsa')).toHaveAttribute('dir', 'ltr');
  });
});

describe('CommissionSection (DEV-05 §3, ADR-054; DEV-05-PATCH) — принимает готовые подписи из paymentPolicy', () => {
  it('показывает сумму, «кто платит» и невозвратность', () => {
    render(
      <CommissionSection
        title="Комиссия за заключение"
        amountLabel="1 020 ₽"
        percentLabel="≈0.85 %"
        paidBy="ИП Мастер Ремонт"
        paidByLabel="Платит"
        payAtSigningNote="Оплачивается при подписании"
        nonRefundableNote="Комиссия невозвратная"
      />,
    );
    expect(screen.getByText('1 020 ₽')).toBeInTheDocument();
    expect(screen.getByText('ИП Мастер Ремонт')).toBeInTheDocument();
    expect(screen.getByText('Комиссия невозвратная')).toBeInTheDocument();
  });
});

describe('SignatureRow (DEV-05 §3) — 3 состояния', () => {
  const LABELS = { youLabel: 'Ваша подпись', waitingLabel: 'Ждём подпись', signedLabel: 'Подписано' };

  it('you — своя ещё не подписанная строка', () => {
    render(<SignatureRow name="Годвин" role="Заказчик" state="you" {...LABELS} />);
    expect(screen.getByText('Ваша подпись')).toBeInTheDocument();
  });

  it('waiting — сторона ещё не подписала', () => {
    render(<SignatureRow name="Мастер Ремонт" role="Исполнитель" state="waiting" {...LABELS} />);
    expect(screen.getByText('Ждём подпись')).toBeInTheDocument();
  });

  it('signed — показывает дату подписи и право подписи, если есть', () => {
    render(
      <SignatureRow
        name="Мастер Ремонт"
        role="Исполнитель"
        state="signed"
        signedAt="2026-07-31T10:05:00.000Z"
        signerNote="Подписывает Дмитрий Мастеров — по доверенности"
        {...LABELS}
      />,
    );
    expect(screen.getByText('Подписано')).toBeInTheDocument();
    expect(screen.getByText(/по доверенности/)).toBeInTheDocument();
  });
});

describe('EditContractLink (DEV-05 §3) — enabled/disabled + предупреждение', () => {
  it('enabled: доступна и показывает предупреждение об аннулировании подписей', async () => {
    const onEdit = vi.fn();
    render(<EditContractLink label="Редактировать договор" warning="Аннулирует подписи" enabled onEdit={onEdit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Редактировать договор' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.getByText('Аннулирует подписи')).toBeInTheDocument();
  });

  it('disabled: недоступна после подписания обеими сторонами', () => {
    render(<EditContractLink label="Редактировать договор" warning="Аннулирует подписи" enabled={false} onEdit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Редактировать договор' })).toBeDisabled();
  });
});

describe('FeePaymentSbp (DEV-05 §3) — QR-плейсхолдер + шаги + невозвратность', () => {
  it('рендерит сумму, шаги и вызывает onPay', async () => {
    const onPay = vi.fn();
    render(
      <FeePaymentSbp
        title="Оплата комиссии за заключение"
        amountLabel="1 020 ₽"
        contractNo="c-3002"
        contractNoLabel="Договор №"
        steps={['Откройте банк', 'Отсканируйте QR', 'Подтвердите']}
        nonRefundableNote="Комиссия невозвратная"
        payLabel="Оплатить"
        onPay={onPay}
        qrHint="QR-код для оплаты через СБП"
      />,
    );
    expect(screen.getByText('1 020 ₽')).toBeInTheDocument();
    expect(screen.getByText('Отсканируйте QR')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Оплатить' }));
    expect(onPay).toHaveBeenCalledOnce();
  });
});
