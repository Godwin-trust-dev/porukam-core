import { describe, it, expect } from 'vitest';
import { ApiError } from '@porukam/core';
import { formDataErrorText } from '../src/features/contractNew/serviceFormData';

describe('formDataErrorText — полевые ошибки 422 form_data_invalid видны в тексте (отсмотр 2026-08-19)', () => {
  it('склеивает messages из problem.context.errors после заголовка', () => {
    const e = new ApiError(422, {
      title: 'form_data не соответствует схеме',
      code: 'form_data_invalid',
      context: {
        errors: [
          { field: 'sphere_code', code: 'invalid_choice', message: "'sphere_code': недопустимое значение 'beauty'" },
          { field: 'start_date', code: 'required', message: "поле 'start_date' обязательно" },
        ],
      },
    });
    expect(formDataErrorText(e)).toBe(
      "form_data не соответствует схеме: 'sphere_code': недопустимое значение 'beauty'; поле 'start_date' обязательно",
    );
  });

  it('без context.errors — просто message ошибки', () => {
    const e = new ApiError(409, { title: 'Конфликт', code: 'invalid_state_transition' });
    expect(formDataErrorText(e)).toBe('Конфликт');
  });

  it('не-ApiError → null (вызывающий падает в String(e))', () => {
    expect(formDataErrorText(new Error('boom'))).toBeNull();
  });
});
