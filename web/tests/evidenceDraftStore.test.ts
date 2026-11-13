import { describe, it, expect, beforeEach } from 'vitest';
import {
  addEvidenceDraft,
  clearEvidenceDrafts,
  createMemoryEvidenceDraftStorage,
  draftScope,
  evidenceDraftFile,
  listEvidenceDrafts,
  readEvidenceDraftNote,
  removeEvidenceDraft,
  setEvidenceDraftError,
  setEvidenceDraftStorage,
  writeEvidenceDraftNote,
} from '../src/features/stageExecution/evidenceDraftStore';

/**
 * Черновик доказательств этапа (ADR-160): до «Сдать этап» файлы живут только
 * на устройстве и удаляются одним касанием. Здесь проверяется САМО хранилище —
 * без React и без браузера: в jsdom IndexedDB нет вовсе, поэтому берём
 * in-memory реализацию того же интерфейса (`setup.ts` подставляет её глобально,
 * здесь ставим свою явно — тест не должен зависеть от порядка файлов).
 */
describe('evidenceDraftStore (ADR-160)', () => {
  const scope = draftScope('pf-1', 'ms-1');

  beforeEach(() => {
    setEvidenceDraftStorage(createMemoryEvidenceDraftStorage());
  });

  function photo(name: string, bytes = 'jpeg-bytes'): File {
    return new File([bytes], name, { type: 'image/jpeg' });
  }

  it('добавить → черновик виден в своём scope с именем, типом и привязкой', async () => {
    const added = await addEvidenceDraft({
      milestoneId: 'ms-1',
      ownerId: 'pf-1',
      file: photo('шов.jpg'),
      checklistItemId: 'ci-1',
      checklistItemLabel: 'Швы затёрты ровно',
    });

    const list = await listEvidenceDrafts(scope);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(added.id);
    expect(list[0]!.fileName).toBe('шов.jpg');
    expect(list[0]!.fileType).toBe('image/jpeg');
    expect(list[0]!.checklistItemId).toBe('ci-1');
    expect(list[0]!.checklistItemLabel).toBe('Швы затёрты ровно');
    expect(list[0]!.scope).toBe(scope);
  });

  it('без привязки к пункту — «этап целиком» (поля привязки отсутствуют, а не пустые строки)', async () => {
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('общий-вид.jpg') });
    const [draft] = await listEvidenceDrafts(scope);
    expect(draft!.checklistItemId).toBeUndefined();
    expect(draft!.checklistItemLabel).toBeUndefined();
  });

  it('удалить → исчезает только один, остальные остаются (это и есть смысл черновика)', async () => {
    const first = await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('смазанное.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('хорошее.jpg') });

    await removeEvidenceDraft(first.id);

    const list = await listEvidenceDrafts(scope);
    expect(list.map((d) => d.fileName)).toEqual(['хорошее.jpg']);
  });

  it('восстановление: черновик читается по scope и после «перезагрузки» (нового чтения)', async () => {
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('первое.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('второе.jpg') });

    // Повторное чтение — ровно то, что делает страница этапа после reload.
    const list = await listEvidenceDrafts(scope);
    expect(list.map((d) => d.fileName)).toEqual(['первое.jpg', 'второе.jpg']);
    // Байты дожили: из записи собирается настоящий File для multipart-загрузки.
    const file = evidenceDraftFile(list[0]!);
    expect(file.name).toBe('первое.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBeGreaterThan(0);
  });

  it('чужой scope не виден: другой актёр и другой этап — свои черновики', async () => {
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('моё.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-2', file: photo('чужое.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-2', ownerId: 'pf-1', file: photo('другой-этап.jpg') });

    expect((await listEvidenceDrafts(scope)).map((d) => d.fileName)).toEqual(['моё.jpg']);
    expect((await listEvidenceDrafts(draftScope('pf-2', 'ms-1'))).map((d) => d.fileName)).toEqual(['чужое.jpg']);
    expect((await listEvidenceDrafts(draftScope('pf-1', 'ms-2'))).map((d) => d.fileName)).toEqual(['другой-этап.jpg']);
  });

  it('очистить → пусто в своём scope, чужой не тронут (сдача чистит только свой)', async () => {
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('a.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('b.jpg') });
    await addEvidenceDraft({ milestoneId: 'ms-2', ownerId: 'pf-1', file: photo('c.jpg') });

    await clearEvidenceDrafts(scope);

    expect(await listEvidenceDrafts(scope)).toEqual([]);
    expect(await listEvidenceDrafts(draftScope('pf-1', 'ms-2'))).toHaveLength(1);
  });

  it('пометка ошибки: текст ложится на запись и снимается перед повтором', async () => {
    const draft = await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('упавшее.jpg') });

    await setEvidenceDraftError(draft.id, 'Не удалось загрузить «упавшее.jpg»');
    expect((await listEvidenceDrafts(scope))[0]!.errorText).toBe('Не удалось загрузить «упавшее.jpg»');

    await setEvidenceDraftError(draft.id, undefined);
    expect((await listEvidenceDrafts(scope))[0]!.errorText).toBeUndefined();
  });

  it('пометка ошибки на исчезнувшей записи не воскрешает её', async () => {
    const draft = await addEvidenceDraft({ milestoneId: 'ms-1', ownerId: 'pf-1', file: photo('ушедшее.jpg') });
    await removeEvidenceDraft(draft.id);

    await setEvidenceDraftError(draft.id, 'ошибка');

    expect(await listEvidenceDrafts(scope)).toEqual([]);
  });

  it('описание партии переживает «перезагрузку» и живёт в своём scope (расширение 05.09)', () => {
    const mine = draftScope('pf-1', 'ms-1');
    const theirs = draftScope('pf-2', 'ms-1');

    writeEvidenceDraftNote(mine, 'Скол на левом углу подоконника');

    // Новое чтение = страница после перезагрузки вкладки: описание, набранное
    // до съёмки, не должно пропадать вместе с состоянием React.
    expect(readEvidenceDraftNote(mine)).toBe('Скол на левом углу подоконника');
    // Второй актёр того же этапа своего описания не получает.
    expect(readEvidenceDraftNote(theirs)).toBe('');

    // Пустая строка = стереть: после отправки поле обязано быть чистым, иначе
    // следующая партия молча подписалась бы чужим текстом.
    writeEvidenceDraftNote(mine, '');
    expect(readEvidenceDraftNote(mine)).toBe('');
  });

  it('scope без актёра (профиль ещё не выбран) — свой отдельный ключ, не сваливается в чужой', () => {
    expect(draftScope(null, 'ms-1')).toBe('anon::ms-1');
    expect(draftScope(undefined, 'ms-1')).toBe('anon::ms-1');
    expect(draftScope('pf-1', 'ms-1')).not.toBe(draftScope(null, 'ms-1'));
  });
});
