import { describe, expect, it, beforeEach } from 'vitest';
import { openChatSocket } from '../src/features/chat/ws';
import { useAuthStore } from '../src/features/auth/authStore';

/**
 * WebSocket чата (ADR-113): auth+subscribe после open, кадр message —
 * колбэк только по своему договору, cleanup закрывает сокет. Настоящий
 * WebSocket в jsdom не нужен — подставная фабрика.
 */

class FakeSocket {
  sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }
}

describe('openChatSocket', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'jwt-access', refresh: 'r' });
  });

  it('после open шлёт auth (токен первым кадром) и subscribe', () => {
    const sock = new FakeSocket();
    const stop = openChatSocket('rc-1', () => undefined, () => sock as unknown as WebSocket);
    sock.onopen?.();
    expect(sock.sent.map((f) => JSON.parse(f))).toEqual([
      { type: 'auth', token: 'jwt-access' },
      { type: 'subscribe', contract_id: 'rc-1' },
    ]);
    stop();
    expect(sock.closedByClient).toBe(true);
  });

  it('кадр message зовёт колбэк только по своему договору', () => {
    const sock = new FakeSocket();
    const got: string[] = [];
    openChatSocket('rc-1', (m) => got.push(m.body), () => sock as unknown as WebSocket);
    sock.onopen?.();
    sock.onmessage?.({
      data: JSON.stringify({ type: 'message', contract_id: 'rc-1', message: { id: 'm1', sender_profile_id: 'p', body: 'привет', created_at: '2026-08-23T12:00:00Z', read_at: null } }),
    });
    sock.onmessage?.({
      data: JSON.stringify({ type: 'message', contract_id: 'rc-OTHER', message: { id: 'm2', sender_profile_id: 'p', body: 'чужое', created_at: '2026-08-23T12:00:00Z', read_at: null } }),
    });
    sock.onmessage?.({ data: 'не-json' });
    expect(got).toEqual(['привет']);
  });
});
