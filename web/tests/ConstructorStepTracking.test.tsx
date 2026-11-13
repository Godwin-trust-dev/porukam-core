import { describe, expect, it, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useConstructorStepTracking } from '../src/features/analytics/useConstructorStepTracking';
import { trackConstructorStep } from '../src/features/analytics/constructorSteps';
import {
  recordedConstructorSteps,
  resetRecordedConstructorSteps,
} from '../src/mocks/analyticsHandlers';
import { useAuthStore } from '../src/features/auth/authStore';

/**
 * ADR-145 (док метрик §8.1): единственный поведенческий слой продукта — шаги
 * конструктора договора. Он существует ровно потому, что брошенный черновик
 * иначе неизмерим: доменного события «бросил на шаге 3» нет и быть не должно.
 *
 * Проверяем два свойства. Первое: у КАЖДОГО входа есть парный уход, включая
 * уход из мастера целиком — именно этот сигнал отвечает на вопрос «на каком
 * шаге теряются люди» (§10, строка 12). Второе: в аналитику не уходит ничего,
 * кроме шага, действия и черновика.
 *
 * Тесты идут через настоящую отправку и MSW, а не через подмену модуля:
 * форма тела здесь важнее факта вызова — она и есть граница приватности.
 */

function Harness({ step, draftId }: { step?: string; draftId?: string | null }): JSX.Element {
  useConstructorStepTracking(step, draftId);
  return <div />;
}

function sent(): Array<{ step_code: string; action: string; contract_id?: string }> {
  return recordedConstructorSteps;
}

beforeEach(async () => {
  // Размонтирование предыдущего теста (cleanup в afterEach) шлёт «left»
  // асинхронно — даём ему долететь ДО сброса, иначе он приземлится уже в
  // следующий тест. Заодно каждый тест ниже пользуется своими кодами шагов.
  await new Promise((resolve) => setTimeout(resolve, 60));
  resetRecordedConstructorSteps();
  useAuthStore.getState().setTokens({ access: 'test-access', refresh: 'test-refresh' });
});

describe('Трекинг шагов конструктора', () => {
  it('отмечает вход на шаг', async () => {
    render(<Harness step="type" />);
    await waitFor(() => expect(sent()).toEqual([{ step_code: 'type', action: 'entered' }]));
  });

  it('на смене шага закрывает предыдущий и открывает новый', async () => {
    const { rerender } = render(<Harness step="type" draftId="c-1" />);
    await waitFor(() => expect(sent()).toHaveLength(1));

    rerender(<Harness step="parties" draftId="c-1" />);
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent().slice(1)).toEqual([
      { step_code: 'type', action: 'left', contract_id: 'c-1' },
      { step_code: 'parties', action: 'entered', contract_id: 'c-1' },
    ]);
  });

  it('уход из мастера закрывает последний шаг', async () => {
    const { unmount } = render(<Harness step="stages" draftId="c-2" />);
    await waitFor(() => expect(sent()).toHaveLength(1));

    unmount();
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({ step_code: 'stages', action: 'left', contract_id: 'c-2' });
  });

  it('повторный рендер того же шага не плодит событий', async () => {
    const { rerender } = render(<Harness step="details" />);
    await waitFor(() => expect(sent()).toHaveLength(1));
    rerender(<Harness step="details" />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent()).toHaveLength(1);
  });

  it('без шага не отправляет ничего', async () => {
    render(<Harness step={undefined} />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent()).toHaveLength(0);
  });
});

describe('Граница приватности события', () => {
  it('шлёт только шаг, действие и черновик', async () => {
    trackConstructorStep('parties', 'left', 'c-42');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ step_code: 'parties', action: 'left', contract_id: 'c-42' });
  });

  it('без черновика поле contract_id не отправляется вовсе', async () => {
    trackConstructorStep('type', 'entered');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ step_code: 'type', action: 'entered' });
    expect(sent()[0]).not.toHaveProperty('contract_id');
  });

  it('пустой код шага не отправляется', async () => {
    trackConstructorStep('', 'entered');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent()).toHaveLength(0);
  });
});
