import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './authStore';

/**
 * Guard: неавторизованных отправляем на вход (ТЗ §3.4). `/welcome` (Google),
 * не `/login` (телефон) — GLOBAL-волна, docs/tasks/Задача_feat_web-global-entry.md §1.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
