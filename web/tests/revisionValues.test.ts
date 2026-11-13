import { describe, it, expect } from 'vitest';
import { ApiError } from '@porukam/core';
import { createI18n } from '@porukam/i18n';
import {
  REVISION_NO_VALUE,
  coerceRevisionValueForOption,
  isAddressableRevisionRef,
  revisionErrorText,
  revisionInputFromOption,
  type RevisionItemOption,
} from '../src/features/contracts/contractFields';

/**
 * Значения и ошибки структурных правок (ADR-157). Раньше «Стало» уходило
 * строкой по типу поля для ЛЮБОГО адреса: сумма — без валюты, «нет
 * предшественника» — никак (пустое значение не отправлялось вовсе), а 422 бэка
 * показывалась служебным русским текстом сервера. Здесь закреплено, что
 * значение собирается ПО АДРЕСУ, а ошибка читается по КОДУ поля.
 */

const t = createI18n('ru').t;

function option(patch: Partial<RevisionItemOption>): RevisionItemOption {
  return { ref: 'x', label: 'X', type: 'string', choices: null, current: null, currentText: '', ...patch };
}

function problem(codes: string[]): ApiError {
  return new ApiError(422, {
    code: 'revision_value_invalid',
    detail: 'служебное сообщение бэка',
    context: { errors: codes.map((code) => ({ field: 'milestone.m1.amount', code, message: 'служебно' })) },
  });
}

describe('coerceRevisionValueForOption — значение по адресу правки', () => {
  it('сумма этапа уходит парой {amount, currency}: валюты по умолчанию нет нигде', () => {
    expect(coerceRevisionValueForOption(option({ type: 'decimal', currency: 'KZT' }), '20000,50')).toEqual({
      amount: '20000.50',
      currency: 'KZT',
    });
  });

  it('«нет предшественника» уходит пустой строкой, а не служебным кодом', () => {
    expect(coerceRevisionValueForOption(option({ type: 'choice' }), REVISION_NO_VALUE)).toBe('');
  });

  it('остальные адреса — как раньше, по типу поля', () => {
    expect(coerceRevisionValueForOption(option({ type: 'integer' }), '7')).toBe(7);
    expect(coerceRevisionValueForOption(option({ type: 'choice' }), 'cat-tile')).toBe('cat-tile');
  });
});

/**
 * Предзаполнение «Стало» текущим значением (находка 04.09: функция была
 * написана, но никуда не подключена). Правка — почти всегда СДВИГ от того, что
 * уже в договоре, поэтому виджет стартует от текущего значения; но подставить
 * его можно только в том виде, который примет сам виджет, иначе человек видит
 * пустоту, а в состоянии лежит старое значение.
 */
describe('revisionInputFromOption — «Стало» стартует от текущего значения', () => {
  it('сумма этапа лежит парой — в поле идёт только число, валюта уже в адресе', () => {
    const money = option({ type: 'decimal', currency: 'RUB', current: { amount: '18000.00', currency: 'RUB' } });
    expect(revisionInputFromOption(money)).toBe('18000.00');
    // Обратная к `coerceRevisionValueForOption`: предзаполнить и отправить
    // как есть = то же значение, что в договоре.
    expect(coerceRevisionValueForOption(money, revisionInputFromOption(money))).toEqual({
      amount: '18000.00',
      currency: 'RUB',
    });
    // У договора ещё нет ни одной суммы — предзаполнять нечем (валюты по
    // умолчанию нет нигде).
    expect(revisionInputFromOption(option({ type: 'decimal', currency: 'RUB', current: null }))).toBe('');
  });

  it('срок этапа приходит датой-временем, а виджет — input[type=date]', () => {
    expect(revisionInputFromOption(option({ type: 'date', current: '2026-09-12T09:00:00Z' }))).toBe('2026-09-12');
    // Поле формы уже в формате даты — остаётся собой.
    expect(revisionInputFromOption(option({ type: 'date', current: '2026-09-05' }))).toBe('2026-09-05');
  });

  it('«предшественника нет» — законное текущее значение, у него свой код', () => {
    const gate = option({
      type: 'choice',
      choices: [{ value: REVISION_NO_VALUE, label: 'Без этапа-предшественника' }, { value: 'ms-1', label: 'Шкаф' }],
      current: null,
    });
    expect(revisionInputFromOption(gate)).toBe(REVISION_NO_VALUE);
    expect(revisionInputFromOption({ ...gate, current: 'ms-1' })).toBe('ms-1');
  });

  it('значения вне справочника не предзаполняем: select показал бы пустоту, а отправилось бы старое', () => {
    const choices = [{ value: 'cat-tile', label: 'Плитка' }];
    expect(revisionInputFromOption(option({ type: 'choice', choices, current: 'cat-tile' }))).toBe('cat-tile');
    expect(revisionInputFromOption(option({ type: 'choice', choices, current: 'cat-gone' }))).toBe('');
  });

  it('«Другое» — свободное условие без адреса, предзаполнять нечем', () => {
    expect(revisionInputFromOption(option({ ref: 'other', type: 'text', current: null }))).toBe('');
  });

  it('булево — кодами виджета, список строк — через запятую, структурный список — пусто', () => {
    expect(revisionInputFromOption(option({ type: 'boolean', current: true }))).toBe('true');
    expect(revisionInputFromOption(option({ type: 'boolean', current: false }))).toBe('false');
    expect(revisionInputFromOption(option({ type: 'list_str', current: ['фото', 'акт'] }))).toBe('фото, акт');
    // График платежей займа — строки-объекты, «Стало» их не редактирует.
    expect(revisionInputFromOption(option({ type: 'list', current: [{ due_date: '2026-09-01' }] }))).toBe('');
  });
});

describe('isAddressableRevisionRef — зеркало is_addressable_item_ref бэка', () => {
  const uuid = '0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

  it('оплата, этапы и материалы теперь применяются бэком (ADR-157)', () => {
    for (const ref of [
      'title',
      'other',
      'form.warranty_period_days',
      'payment.method',
      'payment.order',
      `milestone.${uuid}.amount`,
      `milestone.${uuid}.start_gate`,
      `material.${uuid}.type`,
    ]) {
      expect(isAddressableRevisionRef(ref), ref).toBe(true);
    }
  });

  it('неизвестное поле и битый идентификатор остаются свободной правкой', () => {
    expect(isAddressableRevisionRef(`milestone.${uuid}.color`)).toBe(false);
    expect(isAddressableRevisionRef('milestone.abc.amount')).toBe(false);
    expect(isAddressableRevisionRef('Цвет фасадов')).toBe(false);
  });
});

describe('revisionErrorText — 422 читается по коду поля, а не по тексту сервера', () => {
  it.each([
    ['not_a_leaf', 'Сумма задаётся на конечном этапе: у этапа с подэтапами своей суммы нет.'],
    ['unknown_catalog_item', 'Такой позиции нет в каталоге материалов.'],
    ['currency_mismatch', 'Валюта не совпадает с валютой договора.'],
    ['self_reference', 'Этап не может зависеть сам от себя.'],
    ['not_positive', 'Значение должно быть больше нуля.'],
  ])('%s → своя фраза на языке интерфейса', (code, text) => {
    expect(revisionErrorText(problem([code]), t)).toBe(text);
  });

  it('чужой этап (`revision_item_unknown`) — не полевая ошибка, а «пункта уже нет»', () => {
    const e = new ApiError(422, { code: 'revision_item_unknown', detail: 'этап не принадлежит договору' });
    expect(revisionErrorText(e, t)).toBe('Этого пункта уже нет в договоре — обновите страницу.');
  });

  it('незнакомый код — общий разбор `context.errors`, а не пустая строка', () => {
    const e = new ApiError(422, {
      code: 'revision_value_invalid',
      detail: 'Значение правки не проходит проверку',
      context: { errors: [{ field: 'form.x', code: 'unheard_of', message: 'что-то своё' }] },
    });
    expect(revisionErrorText(e, t)).toContain('что-то своё');
  });
});
