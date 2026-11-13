import { describe, it, expect } from 'vitest';
import { isGlobalOnboardingComplete } from '../src/onboarding';

describe('isGlobalOnboardingComplete', () => {
  it('false — нет me/consents вовсе', () => {
    expect(isGlobalOnboardingComplete(undefined, undefined)).toBe(false);
    expect(isGlobalOnboardingComplete({ handle: '@a' }, undefined)).toBe(false);
  });

  it('false — согласия не завершены, даже если handle уже занят', () => {
    expect(isGlobalOnboardingComplete({ handle: '@a' }, { completed: false })).toBe(false);
  });

  it('false — согласия завершены, но @handle ещё не заявлен (свежий Google-вход)', () => {
    expect(isGlobalOnboardingComplete({ handle: '' }, { completed: true })).toBe(false);
  });

  it('true — согласия завершены и @handle заявлен', () => {
    expect(isGlobalOnboardingComplete({ handle: '@godwin' }, { completed: true })).toBe(true);
  });

  it('бэкап Drive не участвует в условии — необязательный шаг (§6 «Позже» не блокирует)', () => {
    // Подразумевается сигнатурой: функция не принимает состояние бэкапа вовсе.
    expect(isGlobalOnboardingComplete({ handle: '@godwin' }, { completed: true })).toBe(true);
  });
});
