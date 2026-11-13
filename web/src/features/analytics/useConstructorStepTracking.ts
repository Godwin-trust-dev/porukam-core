import { useEffect, useRef } from 'react';
import { trackConstructorStep } from './constructorSteps';

/**
 * Отмечает вход и уход с каждого шага мастера договора (ADR-145).
 *
 * Живёт ОДНИМ хуком в обёртке визарда, а не в каждой странице шага: так
 * гарантировано, что у любого входа есть парный уход, и добавление нового
 * шага не требует не забыть про трекинг. Уход с последнего шага
 * отправляется при размонтировании — это и есть момент, когда человек ушёл
 * из конструктора, не дойдя до конца.
 */
export function useConstructorStepTracking(stepCode: string | undefined, draftId?: string | null): void {
  // Ref, а не state: смена шага не должна вызывать лишнюю перерисовку мастера.
  const previous = useRef<{ step: string; draftId?: string | null } | null>(null);

  useEffect(() => {
    if (!stepCode) return;
    const before = previous.current;
    if (before?.step === stepCode) {
      previous.current = { step: stepCode, draftId };
      return;
    }
    if (before) trackConstructorStep(before.step, 'left', before.draftId);
    trackConstructorStep(stepCode, 'entered', draftId);
    previous.current = { step: stepCode, draftId };
  }, [stepCode, draftId]);

  useEffect(
    () => () => {
      const last = previous.current;
      // Уход из мастера целиком: именно этот сигнал отвечает на вопрос
      // «на каком шаге теряются люди» (§10, строка 12).
      if (last) trackConstructorStep(last.step, 'left', last.draftId);
      previous.current = null;
    },
    [],
  );
}
