import type { ChatMessage } from '@porukam/core';
import { useAuthStore } from '../auth/authStore';

/**
 * WebSocket чата (ADR-113) — УСКОРЕНИЕ доставки поверх поллинга, не замена:
 * при любом сбое сокета тред продолжает жить на refetchInterval (api.ts).
 *
 * Протокол (зеркало apps.messaging.consumers.ChatConsumer):
 *   → {type:'auth', token}  ← {type:'auth_ok'}
 *   → {type:'subscribe', contract_id}  ← {type:'subscribed', ...}
 *   ← {type:'message', contract_id, message}
 * Токен — первым кадром, не в query string (JWT не оседает в логах прокси).
 * Reconnect — экспоненциальный (1с → 30с), пока не вызван cleanup.
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type ChatSocketFactory = (url: string) => WebSocket;

export function chatSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/chat`;
}

export function openChatSocket(
  contractId: string,
  onMessage: (message: ChatMessage) => void,
  factory?: ChatSocketFactory,
): () => void {
  // В мок-контуре WS-сервера нет — молча не подключаемся (поллинг работает).
  // Явная factory (тесты) обходит гейт.
  if (!factory && import.meta.env.VITE_API_MODE === 'mock') return () => undefined;
  if (typeof WebSocket === 'undefined' && !factory) return () => undefined;

  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    try {
      socket = (factory ?? ((url: string) => new WebSocket(url)))(chatSocketUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      const token = useAuthStore.getState().access ?? '';
      socket?.send(JSON.stringify({ type: 'auth', token }));
      socket?.send(JSON.stringify({ type: 'subscribe', contract_id: contractId }));
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          contract_id?: string;
          message?: ChatMessage;
        };
        if (frame.type === 'message' && frame.contract_id === contractId && frame.message) {
          onMessage(frame.message);
        }
      } catch {
        // Не-JSON кадр — игнорируем (страховка, сервер таких не шлёт).
      }
    };
    socket.onclose = () => {
      socket = null;
      scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose придёт следом — reconnect планирует он.
    };
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    timer = setTimeout(connect, delay);
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
