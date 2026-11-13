import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from '../src/mocks/server';
import { resetContracts, resetPayouts } from '../src/mocks/contractsDb';
import { resetRealContractsDb } from '../src/mocks/realContractsDb';
import { resetProfile } from '../src/mocks/profileDb';
import { resetProfilesDb } from '../src/mocks/profilesDb';
import { resetWorkAreasDb } from '../src/mocks/workAreasDb';
import { resetAcceptance } from '../src/mocks/acceptanceDb';
import { resetPayments } from '../src/mocks/paymentsDb';
import { resetAuthGlobal } from '../src/mocks/authGlobalDb';
import { resetArchive } from '../src/mocks/archiveDb';
import { resetStageExecution } from '../src/mocks/stageExecutionDb';
import { resetNotifications } from '../src/mocks/notificationsDb';
import { resetDisputes } from '../src/mocks/disputesDb';
import { resetDeviceTokens } from '../src/mocks/deviceTokenHandlers';
import { createMemoryEvidenceDraftStorage, setEvidenceDraftStorage } from '../src/features/stageExecution/evidenceDraftStore';

// Общий предел ожидания `findBy*`/`waitFor` (по умолчанию 1000 мс): под
// полным прогоном в WSL (jsdom + MSW + i18n на холодном старте) вторые
// запросы страниц в секунду не укладывались — тайм-аут «плавал». Задаём
// один раз здесь, а не точечно в тестах; общий `testTimeout` — в
// `vitest.workspace.ts`.
configure({ asyncUtilTimeout: 5000 });

/**
 * jsdom/vitest + Node fetch gotcha (ADR-088 Фаза 5, реальная multipart-
 * загрузка evidence): jsdom подменяет глобальные `FormData`/`File` СВОИМИ
 * классами (нужны `userEvent.upload` для `<input type=file>`) — а MSW-
 * перехватчик `fetch` строит `Request` по СВОЕМУ внутреннему классу
 * `FormData` (Node/undici); jsdom-шный объект эту проверку не проходит,
 * тело улетает без `boundary` (`Content-Type: text/plain`), сервер не
 * может распарсить multipart. В браузере такого разъезда нет (один realm) —
 * это только тестовое окружение. Чиним ПОСЛЕ `server.listen()` (важен
 * порядок — MSW уже подменил `globalThis.fetch` своим перехватчиком, наша
 * обёртка встаёт ПЕРЕД ним, а не наоборот): FormData-тело руками
 * сериализуем в настоящие multipart-байты + сами ставим `Content-Type`
 * с границей — дальше это обычный бинарный body, класс-проверки не нужны.
 */
function isFormDataLike(x: unknown): x is FormData {
  return !!x && typeof x === 'object' && typeof (x as FormData).entries === 'function' && Object.prototype.toString.call(x) === '[object FormData]';
}

/** jsdom's `Blob`/`File` НЕ реализуют `.arrayBuffer()`/`.text()`/`.stream()`
 * (только `.slice()`, урезанный полифилл этой версии jsdom) — читаем байты
 * через `FileReader` (старый, но полностью реализованный в jsdom API). */
function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function encodeMultipart(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const boundary = `----vitest-formdata-${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [key, value] of form.entries()) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if (value instanceof Blob) {
      const file = value as File;
      const bytes = new Uint8Array(await readAsArrayBuffer(file));
      const filename = typeof file.name === 'string' ? file.name : 'blob';
      chunks.push(enc.encode(`Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
      chunks.push(bytes);
    } else {
      chunks.push(enc.encode(`Content-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}`));
    }
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function patchFetchForFormData(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && isFormDataLike(init.body)) {
      const { body, contentType } = await encodeMultipart(init.body as FormData);
      const headers = new Headers(init.headers);
      headers.set('Content-Type', contentType);
      return inner(input, { ...init, body, headers });
    }
    return inner(input, init);
  }) as typeof fetch;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  patchFetchForFormData();
  // Черновик доказательств (ADR-160) живёт в IndexedDB, которой в jsdom нет
  // вовсе — подставляем in-memory реализацию и обнуляем её между тестами.
  setEvidenceDraftStorage(createMemoryEvidenceDraftStorage());
});
afterEach(() => {
  setEvidenceDraftStorage(createMemoryEvidenceDraftStorage());
  cleanup();
  server.resetHandlers();
  resetContracts();
  resetPayouts();
  resetRealContractsDb();
  resetProfile();
  resetProfilesDb();
  resetWorkAreasDb();
  resetAcceptance();
  resetPayments();
  resetAuthGlobal();
  resetArchive();
  resetStageExecution();
  resetNotifications();
  resetDisputes();
  resetDeviceTokens();
});
afterAll(() => server.close());
