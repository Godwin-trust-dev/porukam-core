import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AcceptAllModal,
  FreezeCta,
  ProposeSheet,
  RejectSheet,
  RevisionCard,
  VariantPicker,
} from '@porukam/ui';

const variants = [
  { id: 'v1', label: '60 000 ₽' },
  { id: 'v2', label: '65 000 ₽', note: 'с доставкой' },
];

describe('VariantPicker (DEV-10 §10)', () => {
  it('рендерит 1..N вариантов', () => {
    render(
      <VariantPicker fromLabel="Было" fromValue="50 000 ₽" variants={variants} ariaLabel="Варианты" pickLabel="Выбрать" onPick={() => {}} />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('50 000 ₽')).toBeInTheDocument();
  });

  it('выбор одного варианта → onPick(variantId)', async () => {
    const onPick = vi.fn();
    render(
      <VariantPicker fromLabel="Было" fromValue="50 000 ₽" variants={variants} ariaLabel="Варианты" pickLabel="Выбрать" onPick={onPick} />,
    );
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    expect(onPick).toHaveBeenCalledWith('v2');
  });

  it('disabled — варианты не кликабельны', async () => {
    const onPick = vi.fn();
    render(
      <VariantPicker fromLabel="Было" fromValue="50 000 ₽" variants={variants} ariaLabel="Варианты" pickLabel="Выбрать" onPick={onPick} disabled />,
    );
    await userEvent.click(screen.getAllByRole('radio')[0]!);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('ProposeSheet / CounterSheet (DEV-10 §10) — мультивариант', () => {
  it('submit недоступен без вариантов, доступен после ввода; «+ добавить вариант» добавляет строку', async () => {
    const onSubmit = vi.fn();
    render(
      <ProposeSheet
        open
        title="Предложить правку"
        itemLabel="Этап 3 · сумма"
        onClose={() => {}}
        onSubmit={onSubmit}
        closeLabel="Закрыть"
        cancelLabel="Отмена"
        submitLabel="Предложить"
        variantValueLabel="Новое значение"
        variantNoteLabel="Пояснение"
        addVariantLabel="+ добавить вариант"
        removeVariantLabel="Убрать вариант"
        commentLabel="Комментарий"
        variantRequiredHint="Укажите хотя бы один вариант"
      />,
    );
    expect(screen.getByTestId('revision-sheet-submit')).toBeDisabled();

    await userEvent.type(screen.getByTestId('variant-value-0'), '55 000 ₽');
    expect(screen.getByTestId('revision-sheet-submit')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('add-variant'));
    expect(screen.getByTestId('variant-value-1')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('variant-value-1'), '58 000 ₽');

    await userEvent.click(screen.getByTestId('revision-sheet-submit'));
    expect(onSubmit).toHaveBeenCalledWith({
      variants: [
        { value: '55 000 ₽', note: undefined },
        { value: '58 000 ₽', note: undefined },
      ],
      comment: undefined,
    });
  });
});

describe('RejectSheet (DEV-10 §10)', () => {
  it('коммент необязателен; кнопка «Предложить свою редакцию» открывает встречную', async () => {
    const onReject = vi.fn();
    const onProposeCounter = vi.fn();
    render(
      <RejectSheet
        open
        title="Отклонить"
        itemLabel="Этап 3 · сумма"
        onClose={() => {}}
        onReject={onReject}
        onProposeCounter={onProposeCounter}
        closeLabel="Закрыть"
        cancelLabel="Отмена"
        rejectLabel="Отклонить"
        commentLabel="Комментарий"
        counterHintTitle="Может, предложите свою редакцию?"
        counterHintCta="Предложить свою редакцию"
      />,
    );
    await userEvent.click(screen.getByTestId('reject-submit'));
    expect(onReject).toHaveBeenCalledWith(undefined);

    await userEvent.click(screen.getByTestId('reject-propose-counter'));
    expect(onProposeCounter).toHaveBeenCalled();
  });
});

describe('AcceptAllModal (DEV-10 §10)', () => {
  it('многовариантные исключены — показывает только однозначные + сводку было→стало+итог', () => {
    render(
      <AcceptAllModal
        open
        title="Подтвердите раскладку правок"
        text="Есть финансово значимые изменения"
        onClose={() => {}}
        closeLabel="Закрыть"
        cancelLabel="Отмена"
        confirmLabel="Подтвердить и принять все"
        onConfirm={() => {}}
        changes={[{ id: 'r1', itemLabel: 'Этап 1 · сумма', fromValue: '20 000 ₽', toValue: '22 000 ₽' }]}
        totalBeforeLabel="Сумма сейчас"
        totalBefore="120 000 ₽"
        totalAfterLabel="Сумма после"
        totalAfter="122 000 ₽"
        excludedHint="Многовариантные правки выбираются отдельно"
      />,
    );
    expect(screen.getByText('Этап 1 · сумма')).toBeInTheDocument();
    expect(screen.getByText('120 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('122 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('Многовариантные правки выбираются отдельно')).toBeInTheDocument();
  });
});

describe('FreezeCta (DEV-10 §10)', () => {
  it('активна только при 0 открытых правок', () => {
    const { rerender } = render(
      <FreezeCta active={false} label="Заморозить и подписать" hint="hint" blockedHint="blocked" onFreeze={() => {}} />,
    );
    expect(screen.getByTestId('freeze')).toBeDisabled();

    rerender(<FreezeCta active label="Заморозить и подписать" hint="hint" blockedHint="blocked" onFreeze={() => {}} />);
    expect(screen.getByTestId('freeze')).not.toBeDisabled();
  });
});

describe('Симметрия (DEV-10 §4/§10)', () => {
  it('своя правка → «Отозвать»; чужая → выбор/отклонить/встречная', () => {
    const { rerender } = render(
      <RevisionCard
        itemLabel="Этап 3 · сумма"
        fromLabel="Было"
        fromValue="50 000 ₽"
        variants={variants}
        ariaLabel="Варианты"
        pickLabel="Выбрать"
        statusLabel="открыта"
        statusTone="amber"
        isMine
        open
        waitingLabel="Ожидает выбора контрагента"
        withdrawLabel="Отозвать"
        onWithdraw={() => {}}
      />,
    );
    expect(screen.getByTestId('revision-withdraw')).toBeInTheDocument();
    expect(screen.queryByTestId('revision-reject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('revision-counter')).not.toBeInTheDocument();

    rerender(
      <RevisionCard
        itemLabel="Этап 3 · сумма"
        fromLabel="Было"
        fromValue="50 000 ₽"
        variants={variants}
        ariaLabel="Варианты"
        pickLabel="Выбрать"
        statusLabel="открыта"
        statusTone="amber"
        isMine={false}
        open
        onPick={() => {}}
        rejectLabel="Отклонить"
        onReject={() => {}}
        counterLabel="Встречная"
        onCounter={() => {}}
      />,
    );
    expect(screen.getByTestId('revision-reject')).toBeInTheDocument();
    expect(screen.getByTestId('revision-counter')).toBeInTheDocument();
    expect(screen.queryByTestId('revision-withdraw')).not.toBeInTheDocument();
  });
});
