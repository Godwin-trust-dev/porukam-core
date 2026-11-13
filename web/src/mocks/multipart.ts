/**
 * Мини-парсер `multipart/form-data` — ТОЛЬКО мок-слой (ADR-088 Фаза 5,
 * реальная загрузка evidence). Реальный бэк парсит multipart сам
 * (`EvidenceUploadSerializer`, DRF) — этот файл его не касается.
 *
 * Обходит `Request.formData()`: в vitest+jsdom окружении jsdom подменяет
 * глобальный `File` СВОИМ классом (нужен `@testing-library/user-event`'s
 * `upload()` для `<input type=file>`), а встроенный в Node/undici парсер
 * multipart при разборе КОНСТРУИРУЕТ `File` тоже через `globalThis.File` —
 * получает подменённый (jsdom-шный) класс — и затем сверяет внутренний
 * WebIDL-бренд СВОЕГО класса; бренды не совпадают, парсер падает ассертом.
 * Только тестовое окружение (в браузере один realm — реальный
 * `Request.formData()` работает как положено, здесь не участвует вообще).
 * Разбирает ровно то, что шлёт `useUploadRealEvidence`
 * (`features/stageExecution/realApi.ts`): поле `file` (обязательное,
 * бинарное) + опционально `checklist_item_id` (текстовое). Байт-точный
 * (не текстовый) разбор — бинарные файлы не портит.
 */
export interface ParsedMultipartFile {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, ParsedMultipartFile>;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** `null` — тело не multipart (другой Content-Type, парсить нечего). */
export async function parseMultipart(request: Request): Promise<ParsedMultipart | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const boundaryMatch = /multipart\/form-data;\s*boundary=(.+)$/i.exec(contentType);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1]!.replace(/^"|"$/g, '');

  const bytes = new Uint8Array(await request.arrayBuffer());
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: false });
  const delimiter = enc.encode(`--${boundary}`);
  const headerEndMarker = enc.encode('\r\n\r\n');

  const fields: Record<string, string> = {};
  const files: Record<string, ParsedMultipartFile> = {};

  let pos = indexOfBytes(bytes, delimiter, 0);
  while (pos !== -1) {
    let contentStart = pos + delimiter.length;
    if (bytes[contentStart] === 0x2d && bytes[contentStart + 1] === 0x2d) break; // "--boundary--" — конец.
    if (bytes[contentStart] === 0x0d && bytes[contentStart + 1] === 0x0a) contentStart += 2; // \r\n после разделителя.

    const nextPos = indexOfBytes(bytes, delimiter, contentStart);
    if (nextPos === -1) break;

    const headerEnd = indexOfBytes(bytes, headerEndMarker, contentStart);
    if (headerEnd === -1 || headerEnd >= nextPos) {
      pos = nextPos;
      continue;
    }
    const headerBlock = dec.decode(bytes.slice(contentStart, headerEnd));
    let contentEnd = nextPos;
    if (bytes[contentEnd - 2] === 0x0d && bytes[contentEnd - 1] === 0x0a) contentEnd -= 2; // финальный \r\n части.
    const content = bytes.slice(headerEnd + headerEndMarker.length, contentEnd);

    const nameMatch = /name="([^"]*)"/.exec(headerBlock);
    if (nameMatch) {
      const name = nameMatch[1]!;
      const filenameMatch = /filename="([^"]*)"/.exec(headerBlock);
      if (filenameMatch) {
        const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock);
        files[name] = {
          name: filenameMatch[1]!,
          type: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
          size: content.length,
          bytes: content,
        };
      } else {
        fields[name] = dec.decode(content);
      }
    }
    pos = nextPos;
  }

  return { fields, files };
}
