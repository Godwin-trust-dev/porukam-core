/**
 * Контекст приглашения переживает уход из SPA на (мок-)Google и обратно
 * (`/welcome` → `/auth/google/mock` → `/auth/google/callback`) — `state`/`code`
 * возвращаются от «провайдера», но не app-специфичный контекст, поэтому
 * держим его в sessionStorage на стороне клиента (реальные приложения делают
 * то же самое: собственный контекст не кодируют в OAuth `state`).
 */
const KEY = 'porukam.pendingInvite';

export interface PendingInvite {
  token: string;
  contractId: string;
}

export function setPendingInvite(invite: PendingInvite): void {
  sessionStorage.setItem(KEY, JSON.stringify(invite));
}

export function takePendingInvite(): PendingInvite | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  sessionStorage.removeItem(KEY);
  try {
    return JSON.parse(raw) as PendingInvite;
  } catch {
    return null;
  }
}

export function peekPendingInvite(): PendingInvite | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingInvite;
  } catch {
    return null;
  }
}
