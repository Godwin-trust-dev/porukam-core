/**
 * Черновик доказательств этапа — файлы, которые исполнитель приложил, но ещё
 * НЕ сдал (ADR-160, решение владельца 05.09).
 *
 * Почему вообще нужен: `POST /milestones/{id}/evidence` хеширует файл сразу,
 * складывает в WORM и уведомляет вторую сторону — удаления Evidence на
 * сервере нет и не будет (CLAUDE.md: «мягкого удаления юрзначимых сущностей
 * нет»). Значит «убрать не то фото» может существовать только ДО отправки, на
 * устройстве. Все черновики уезжают одним заходом при «Сдать этап».
 *
 * Почему IndexedDB, а не React-state/localStorage:
 *  - на Android вкладка после камеры часто перезагружается — state теряется;
 *  - Blob'ы в localStorage не лезут (только строки, лимит ~5 МБ на origin).
 * IndexedDB переживает перезагрузку и хранит бинарь как есть.
 *
 * Хранилище вынесено за интерфейс `EvidenceDraftStorage`: в jsdom (vitest)
 * IndexedDB нет вовсе, там же и в приватных окнах/при заблокированных данных
 * сайта подставляется in-memory реализация. Черновик тогда не переживает
 * перезагрузку — но выбор и удаление файлов работают, а сдача (единственное,
 * что юридически значимо) не зависит от хранилища вообще.
 */

/** Запись черновика — ровно то, что лежит в IndexedDB (структурный клон). */
export interface StoredEvidenceDraft {
  id: string;
  /** `${ownerId}::${milestoneId}` — черновик ЧУЖОГО актёра на том же этапе не виден. */
  scope: string;
  milestoneId: string;
  ownerId: string;
  /** Байты файла. Blob, а не File: File в structuredClone поддержан не везде. */
  blob: Blob;
  fileName: string;
  fileType: string;
  fileSize: number;
  /** Привязка к пункту чек-листа; пусто — «этап целиком». */
  checklistItemId?: string;
  checklistItemLabel?: string;
  createdAt: number;
  /** Текст последней неудачной отправки — файл остался в черновике (§3). */
  errorText?: string;
}

export interface EvidenceDraftStorage {
  list(scope: string): Promise<StoredEvidenceDraft[]>;
  get(id: string): Promise<StoredEvidenceDraft | undefined>;
  put(record: StoredEvidenceDraft): Promise<void>;
  remove(id: string): Promise<void>;
  clear(scope: string): Promise<void>;
}

const DB_NAME = 'porukam-evidence-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';
const SCOPE_INDEX = 'scope';

/** Ключ черновиков: свой у каждой пары (актёр, этап). */
export function draftScope(ownerId: string | null | undefined, milestoneId: string): string {
  return `${ownerId ?? 'anon'}::${milestoneId}`;
}

/** In-memory реализация — тесты и окружения без IndexedDB. */
export function createMemoryEvidenceDraftStorage(): EvidenceDraftStorage {
  const rows = new Map<string, StoredEvidenceDraft>();
  return {
    list: (scope) => Promise.resolve([...rows.values()].filter((r) => r.scope === scope).sort((a, b) => a.createdAt - b.createdAt)),
    get: (id) => Promise.resolve(rows.get(id)),
    put: (record) => {
      rows.set(record.id, record);
      return Promise.resolve();
    },
    remove: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
    clear: (scope) => {
      for (const [id, r] of rows) if (r.scope === scope) rows.delete(id);
      return Promise.resolve();
    },
  };
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(SCOPE_INDEX, 'scope', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export function createIndexedDbEvidenceDraftStorage(factory: IDBFactory): EvidenceDraftStorage {
  let db: Promise<IDBDatabase> | null = null;
  const conn = (): Promise<IDBDatabase> => (db ??= openDb(factory));

  async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const database = await conn();
    const transaction = database.transaction(STORE, mode);
    const result = await fn(transaction.objectStore(STORE));
    // Ждём именно коммита: у записи `put`-запрос успевает раньше транзакции,
    // и без этого следующее чтение могло бы не увидеть только что добавленный
    // черновик (перезагрузка страницы сразу после выбора файла).
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
    return result;
  }

  return {
    list: (scope) =>
      tx('readonly', async (store) => {
        const rows = await promisify<StoredEvidenceDraft[]>(store.index(SCOPE_INDEX).getAll(scope) as IDBRequest<StoredEvidenceDraft[]>);
        return rows.sort((a, b) => a.createdAt - b.createdAt);
      }),
    get: (id) => tx('readonly', (store) => promisify<StoredEvidenceDraft | undefined>(store.get(id) as IDBRequest<StoredEvidenceDraft | undefined>)),
    put: (record) =>
      tx('readwrite', async (store) => {
        await promisify(store.put(record));
      }),
    remove: (id) =>
      tx('readwrite', async (store) => {
        await promisify(store.delete(id));
      }),
    clear: (scope) =>
      tx('readwrite', async (store) => {
        const keys = await promisify<IDBValidKey[]>(store.index(SCOPE_INDEX).getAllKeys(scope) as IDBRequest<IDBValidKey[]>);
        for (const key of keys) await promisify(store.delete(key));
      }),
  };
}

let storage: EvidenceDraftStorage | null = null;

function activeStorage(): EvidenceDraftStorage {
  if (storage) return storage;
  const factory = typeof globalThis !== 'undefined' ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : undefined;
  storage = factory ? createIndexedDbEvidenceDraftStorage(factory) : createMemoryEvidenceDraftStorage();
  return storage;
}

/** Подменить хранилище (тесты, окружение без IndexedDB). */
export function setEvidenceDraftStorage(next: EvidenceDraftStorage | null): void {
  storage = next;
}

let draftSeq = 0;

function nextDraftId(): string {
  draftSeq += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `draft-${draftSeq}-${random}`;
}

export interface AddEvidenceDraftInput {
  milestoneId: string;
  ownerId: string | null | undefined;
  file: File;
  checklistItemId?: string;
  checklistItemLabel?: string;
}

export async function addEvidenceDraft(input: AddEvidenceDraftInput): Promise<StoredEvidenceDraft> {
  const record: StoredEvidenceDraft = {
    id: nextDraftId(),
    scope: draftScope(input.ownerId, input.milestoneId),
    milestoneId: input.milestoneId,
    ownerId: input.ownerId ?? 'anon',
    // `slice()` без аргументов — самый переносимый способ получить Blob из File
    // (jsdom-овский File не реализует `arrayBuffer()`), тип сохраняем явно.
    blob: input.file.slice(0, input.file.size, input.file.type),
    fileName: input.file.name,
    fileType: input.file.type,
    fileSize: input.file.size,
    ...(input.checklistItemId ? { checklistItemId: input.checklistItemId } : {}),
    ...(input.checklistItemLabel ? { checklistItemLabel: input.checklistItemLabel } : {}),
    createdAt: Date.now(),
  };
  await activeStorage().put(record);
  return record;
}

export function listEvidenceDrafts(scope: string): Promise<StoredEvidenceDraft[]> {
  return activeStorage().list(scope);
}

export function removeEvidenceDraft(id: string): Promise<void> {
  return activeStorage().remove(id);
}

export function clearEvidenceDrafts(scope: string): Promise<void> {
  return activeStorage().clear(scope);
}

/** Пометить черновик неудачей отправки (или снять пометку перед повтором). */
export async function setEvidenceDraftError(id: string, errorText: string | undefined): Promise<void> {
  const store = activeStorage();
  const record = await store.get(id);
  if (!record) return;
  const next: StoredEvidenceDraft = { ...record };
  if (errorText) next.errorText = errorText;
  else delete next.errorText;
  await store.put(next);
}

/** Черновик → `File` для multipart-загрузки (имя и MIME восстанавливаем сами). */
export function evidenceDraftFile(record: StoredEvidenceDraft): File {
  return new File([record.blob], record.fileName, { type: record.fileType || 'application/octet-stream' });
}

/**
 * Описание партии («Отправить приложенное», расширение ADR-160 от 05.09).
 *
 * Хранится ОТДЕЛЬНО от файлов и в `localStorage`, а не в IndexedDB: это
 * короткая строка, а не байты, и главный довод ADR-160 против localStorage
 * («Blob'ы туда не лезут») к ней не относится. Пережить перезагрузку она
 * обязана по той же причине, что и сами фотографии: на Android вкладка после
 * камеры перезагружается, и текст, набранный до съёмки, иначе пропадал бы
 * молча — ровно та потеря, ради которой черновик и появился.
 *
 * Ключ — тот же scope `<ownerId>::<milestoneId>`: описание заказчика не
 * подмешивается в отправку исполнителя и наоборот.
 *
 * Всё в try/catch: в приватном окне и при запрете данных сайта обращение к
 * `localStorage` бросает исключение — экран от этого не должен ломаться,
 * описание просто не переживёт перезагрузку.
 */
const NOTE_PREFIX = 'porukam-evidence-draft-note::';

function noteStore(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' ? ((globalThis as { localStorage?: Storage }).localStorage ?? null) : null;
  } catch {
    return null;
  }
}

export function readEvidenceDraftNote(scope: string): string {
  try {
    return noteStore()?.getItem(NOTE_PREFIX + scope) ?? '';
  } catch {
    return '';
  }
}

export function writeEvidenceDraftNote(scope: string, text: string): void {
  try {
    const store = noteStore();
    if (!store) return;
    if (text) store.setItem(NOTE_PREFIX + scope, text);
    else store.removeItem(NOTE_PREFIX + scope);
  } catch {
    // Квота/приватное окно — описание живёт только в состоянии страницы.
  }
}
