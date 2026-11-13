/**
 * Одноразовое уведомление «Аккаунт удалён» на `/welcome` (ADR-169).
 *
 * Почему sessionStorage, а не `navigate(..., { state })`: удаление ЧИСТИТ
 * авторизацию, и до нашего перехода успевает сработать реактивный `RequireAuth`
 * — он уводит на `/welcome` своим `<Navigate>` со своим `state`, и переданный
 * нами флаг пропал бы. Флаг переживает и это, и обычную перезагрузку вкладки;
 * читается ровно один раз (`take*` сразу удаляет ключ), поэтому уведомление не
 * возвращается при следующем заходе на экран входа.
 */
const KEY = 'porukam.accountDeleted';

export function markAccountDeleted(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Приватный режим/заблокированное хранилище — уведомление не критично.
  }
}

export function takeAccountDeletedNotice(): boolean {
  try {
    const had = sessionStorage.getItem(KEY) === '1';
    if (had) sessionStorage.removeItem(KEY);
    return had;
  } catch {
    return false;
  }
}
