import { http, HttpResponse } from 'msw';
import type { ChatMessage, ChatMessagesResponse, ChatThread } from '@porukam/core';
import { getContract } from './realContractsDb';
import { demoLang } from './demoEn';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/**
 * Мок apps.messaging (ADR-112): in-memory переписка поверх договоров
 * realContractsDb. Актёр — X-Acting-Profile (фолбэк pf-person-1, как в
 * sectionsHandlers); «моё/чужое» и unread считаются относительно него.
 */
interface MessageRecord extends ChatMessage {
  contract_id: string;
}

let seq = 0;
const store: MessageRecord[] = [];

export function resetChat(): void {
  store.length = 0;
  seq = 0;
  seedChat();
}

/**
 * Английская переписка для витрины сторов (`demoEn.ts`, флаг `porukam.mockData`).
 * Здесь — СВОЙ сид, а не перевод русского: витрине нужен живой диалог из шести
 * реплик («переписка становится договором»), а в русском сиде их две — переводить
 * было бы нечего. Русский сид остаётся дефолтом и продолжает держать e2e.
 */
function seedChatEn(): void {
  const contractor = 'pf-mock-contractor-1';
  const me = 'pf-person-1';
  const lines: [string, string, string, string | null][] = [
    [contractor, 'Hi! Tiling started this morning, I will send photos tonight.', '2026-08-22T09:10:00Z', '2026-08-22T09:12:00Z'],
    [me, 'Great. Please keep the grout line under 2 mm as agreed.', '2026-08-22T09:14:00Z', '2026-08-22T09:15:00Z'],
    [contractor, 'Sure. The tile arrived, 12 m², one box is a spare.', '2026-08-22T11:02:00Z', '2026-08-22T11:05:00Z'],
    [me, 'Perfect. Can we add the shower screen to the same stage?', '2026-08-22T11:40:00Z', '2026-08-22T11:44:00Z'],
    [contractor, 'Yes — that is about 120 € extra, I will put it in the contract.', '2026-08-22T12:01:00Z', '2026-08-22T12:03:00Z'],
    [me, 'Agreed. Send it over and I will sign today.', '2026-08-22T12:06:00Z', null],
  ];
  lines.forEach(([sender, body, createdAt, readAt], i) => {
    store.push({
      contract_id: 'rc-progress-1',
      id: `msg-seed-en-${i + 1}`,
      sender_profile_id: sender,
      body,
      created_at: createdAt,
      read_at: readAt,
    });
  });
}

/** Русская переписка витрины (RuStore) — тот же сценарий, что `seedChatEn`. */
function seedChatRu(): void {
  const contractor = 'pf-mock-contractor-1';
  const me = 'pf-person-1';
  const lines: [string, string, string, string | null][] = [
    [contractor, 'Добрый день! Плитку начали класть с утра, вечером пришлю фото.', '2026-08-22T09:10:00Z', '2026-08-22T09:12:00Z'],
    [me, 'Отлично. Шов, как договаривались, не больше 2 мм.', '2026-08-22T09:14:00Z', '2026-08-22T09:15:00Z'],
    [contractor, 'Конечно. Плитка приехала, 12 м², одна коробка в запас.', '2026-08-22T11:02:00Z', '2026-08-22T11:05:00Z'],
    [me, 'Можно в этот же этап добавить стеклянную шторку для душа?', '2026-08-22T11:40:00Z', '2026-08-22T11:44:00Z'],
    [contractor, 'Да, это плюс 12 000 ₽ — внесу в договор допсоглашением.', '2026-08-22T12:01:00Z', '2026-08-22T12:03:00Z'],
    [me, 'Договорились. Присылайте, сегодня подпишу.', '2026-08-22T12:06:00Z', null],
  ];
  lines.forEach(([sender, body, createdAt, readAt], i) => {
    store.push({
      contract_id: 'rc-progress-1',
      id: `msg-seed-ru-${i + 1}`,
      sender_profile_id: sender,
      body,
      created_at: createdAt,
      read_at: readAt,
    });
  });
}

function seedChat(): void {
  const lang = demoLang();
  if (lang === 'en') {
    seedChatEn();
    return;
  }
  if (lang === 'ru') {
    seedChatRu();
    return;
  }
  store.push(
    {
      contract_id: 'rc-progress-1',
      id: 'msg-seed-1',
      sender_profile_id: 'pf-mock-contractor-1',
      body: 'Добрый день! Плитку начали класть, фото пришлю вечером.',
      created_at: '2026-08-22T15:00:00Z',
      read_at: null,
    },
    {
      contract_id: 'rc-progress-1',
      id: 'msg-seed-2',
      sender_profile_id: 'pf-person-1',
      body: 'Отлично, жду!',
      created_at: '2026-08-22T15:05:00Z',
      read_at: '2026-08-22T15:06:00Z',
    },
  );
}

seedChat();

function acting(request: Request): string {
  return request.headers.get('X-Acting-Profile') ?? 'pf-person-1';
}

function unreadFor(contractId: string, profileId: string): number {
  return store.filter(
    (m) => m.contract_id === contractId && m.read_at === null && m.sender_profile_id !== profileId,
  ).length;
}

export const chatHandlers = [
  http.get(`${BASE}/contracts/:id/messages`, ({ request, params }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const contractId = String(params.id);
    const me = acting(request);
    const items = store
      .filter((m) => m.contract_id === contractId)
      .map(({ contract_id: _c, ...m }) => m);
    const data: ChatMessagesResponse = { items, unread_count: unreadFor(contractId, me) };
    return HttpResponse.json(data);
  }),
  http.post(`${BASE}/contracts/:id/messages`, async ({ request, params }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const body = (await request.json()) as { body?: string };
    const text = (body.body ?? '').trim();
    if (!text) return problem(400, 'invalid_request', 'body: Обязательное поле.');
    seq += 1;
    const record: MessageRecord = {
      contract_id: String(params.id),
      id: `msg-n-${seq}`,
      sender_profile_id: acting(request),
      body: text,
      created_at: new Date().toISOString(),
      read_at: null,
    };
    store.push(record);
    const { contract_id: _c, ...message } = record;
    return HttpResponse.json(message, { status: 201 });
  }),
  http.post(`${BASE}/contracts/:id/messages/read`, ({ request, params }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const contractId = String(params.id);
    const me = acting(request);
    const now = new Date().toISOString();
    for (const m of store) {
      if (m.contract_id === contractId && m.sender_profile_id !== me && m.read_at === null) {
        m.read_at = now;
      }
    }
    const items = store
      .filter((m) => m.contract_id === contractId)
      .map(({ contract_id: _c, ...m }) => m);
    return HttpResponse.json({ items, unread_count: 0 } satisfies ChatMessagesResponse);
  }),
  http.get(`${BASE}/messages/threads`, ({ request }) => {
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return problem(401, 'unauthorized', 'Нужен вход.');
    }
    const me = acting(request);
    const byContract = new Map<string, MessageRecord[]>();
    for (const m of store) {
      const list = byContract.get(m.contract_id) ?? [];
      list.push(m);
      byContract.set(m.contract_id, list);
    }
    const threads: ChatThread[] = [];
    for (const [contractId, messages] of byContract) {
      let title = contractId;
      let counterparty = '';
      try {
        const contract = getContract(contractId);
        title = contract.title;
        counterparty = contract.parties.find((p) => p.profile_id !== me)?.profile_id ?? '';
      } catch {
        continue; // договора нет в реестре — тред не показываем
      }
      const last = messages[messages.length - 1]!;
      threads.push({
        contract_id: contractId,
        contract_title: title,
        counterparty_profile_id: counterparty,
        last_message: {
          body: last.body,
          created_at: last.created_at,
          sender_profile_id: last.sender_profile_id,
        },
        unread_count: unreadFor(contractId, me),
      });
    }
    threads.sort((a, b) => (a.last_message.created_at < b.last_message.created_at ? 1 : -1));
    return HttpResponse.json(threads);
  }),
];
