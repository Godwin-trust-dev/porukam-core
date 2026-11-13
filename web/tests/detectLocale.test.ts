import { describe, it, expect } from 'vitest';
import { detectGuestLocale } from '../src/features/locale/detectLocale';

const ENABLED = ['en', 'ru', 'es', 'de', 'uk'];

describe('detectGuestLocale (DEV-16a §3/§7) — navigator.language → срез региона → матч/фолбэк en', () => {
  it('точное совпадение языка без региона', () => {
    expect(detectGuestLocale('ru', ENABLED)).toBe('ru');
  });

  it('срезает регион перед матчем (es-419 → es)', () => {
    expect(detectGuestLocale('es-419', ENABLED)).toBe('es');
  });

  it('регистронезависимо (RU-ru → ru)', () => {
    expect(detectGuestLocale('RU-ru', ENABLED)).toBe('ru');
  });

  it('нет матча в списке включённых → en', () => {
    expect(detectGuestLocale('fr-FR', ENABLED)).toBe('en');
  });

  it('пусто/undefined/null → en', () => {
    expect(detectGuestLocale(undefined, ENABLED)).toBe('en');
    expect(detectGuestLocale(null, ENABLED)).toBe('en');
    expect(detectGuestLocale('', ENABLED)).toBe('en');
  });

  it('язык не входит в enabled (отключённая локаль) → en, а не сам код', () => {
    expect(detectGuestLocale('ar', ENABLED)).toBe('en');
  });
});
