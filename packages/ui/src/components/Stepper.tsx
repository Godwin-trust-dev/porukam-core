import { Fragment } from 'react';
import { Icon } from './Icon';
import styles from './Stepper.module.css';

export interface StepperProps {
  steps: string[];
  current: number;
  /** Полная строка `t('common.stepAriaLabel', { current, total })` — ui не хардкодит копирайт. */
  ariaLabel: string;
  /** Клик по ПРОЙДЕННОМУ шагу (index < current) — возврат назад по конвейеру
   * (отсмотр 2026-08-19: шаги сверху должны быть кликабельны). Будущие шаги
   * не кликаются — их гейт («Далее») ещё не пройден. */
  onStepClick?: (index: number) => void;
  /** Индекс шага с ошибкой — красный кружок (отсмотр 2026-08-19). */
  errorStep?: number;
}

/**
 * Индикатор шагов мастера (создание договора). Пройденные — зелёные с галкой.
 *
 * Две раскладки, переключает CSS (тот же приём, что сайдбар/нижняя навигация
 * оболочки). Узкий экран — компакт (DEV-20_2 §6): точки + «Шаг N из M ·
 * Название» ОДНОЙ строкой; семь кружков с подписями иначе переносились в три
 * ряда и съедали пол-экрана мастера. Широкий — полный ряд шагов, как был.
 */
export function Stepper({ steps, current, ariaLabel, onStepClick, errorStep }: StepperProps): JSX.Element {
  return (
    <>
      <div className={styles.compact} data-testid="stepper-compact">
        <span className={styles.compactDots} aria-hidden="true">
          {steps.map((label, i) => (
            <span
              key={label}
              className={`${styles.compactDot} ${i < current ? styles.compactDotDone : ''} ${i === current ? styles.compactDotCurrent : ''} ${errorStep === i ? styles.compactDotError : ''}`}
            />
          ))}
        </span>
        <span className={styles.compactLabel}>
          {ariaLabel}
          {steps[current] ? ` · ${steps[current]}` : null}
        </span>
      </div>
      <div className={styles.stepper} aria-label={ariaLabel}>
      {steps.map((label, i) => {
        const isError = errorStep === i;
        const state = `${i < current ? styles.done : i === current ? styles.current : ''} ${isError ? styles.error : ''}`;
        const clickable = !!onStepClick && i < current;
        const content = (
          <>
            <span className={styles.dot}>{i < current && !isError ? <Icon name="sealed" size={16} /> : i + 1}</span>
            {label}
          </>
        );
        return (
          <Fragment key={label}>
            {i > 0 ? <span className={styles.sep} aria-hidden="true" /> : null}
            {clickable ? (
              <button
                type="button"
                className={`${styles.step} ${styles.clickable} ${state}`}
                onClick={() => onStepClick(i)}
                data-testid={`stepper-step-${i}`}
              >
                {content}
              </button>
            ) : (
              <span className={`${styles.step} ${state}`} aria-current={i === current ? 'step' : undefined}>
                {content}
              </span>
            )}
          </Fragment>
        );
      })}
      </div>
    </>
  );
}
