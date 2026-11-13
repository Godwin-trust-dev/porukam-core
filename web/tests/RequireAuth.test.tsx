import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireAuth } from '../src/features/auth/RequireAuth';
import { useAuthStore } from '../src/features/auth/authStore';

// docs/tasks/Задача_feat_web-global-entry.md §1 — GLOBAL-волна: гость без
// сессии уходит на /welcome (Google), не на /login (телефон, спрятан за
// PHONE_LOGIN_ENABLED на время волны).
describe('RequireAuth — неавторизованный гость', () => {
  afterEach(() => useAuthStore.getState().logout());

  it('редиректит на /welcome, не /login', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>Protected</div>
              </RequireAuth>
            }
          />
          <Route path="/welcome" element={<div>Welcome screen</div>} />
          <Route path="/login" element={<div>Login screen</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Welcome screen')).toBeInTheDocument();
    expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
  });

  it('авторизован — рендерит защищённый контент, никуда не редиректит', () => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>Protected</div>
              </RequireAuth>
            }
          />
          <Route path="/welcome" element={<div>Welcome screen</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Protected')).toBeInTheDocument();
  });
});
