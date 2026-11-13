import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../auth/authStore';
import { RequireAuth } from '../auth/RequireAuth';
import { RequireGlobalOnboarding } from '../auth/RequireGlobalOnboarding';
import { isAppWrapper } from '../pwa/appWrapper';
import { ShellLayout } from '../../pages/ShellLayout';
import { LandingPage } from '../../pages/public/LandingPage';
import { PublicLayout } from '../../pages/public/PublicLayout';

/**
 * Что показать на `/` (ADR-195) — ТРИ разных ответа на один адрес:
 *
 * 1. Залогинен → рабочий стол, как и раньше (`RequireAuth` + онбординг-гард +
 *    `ShellLayout`; дочерние маршруты оболочки по-прежнему проходят через этот
 *    же элемент, поэтому для них ничего не меняется).
 * 2. Гость в УСТАНОВЛЕННОМ приложении (TWA из Play, PWA с домашнего экрана) →
 *    экран входа. Приложение, открывающееся маркетинговой страницей, — ровно
 *    та претензия «обёртка над сайтом», по которой RuStore отказал в публикации
 *    (`docs/backlog.md`, 21.09); `start_url` установленного приложения — `/`,
 *    так что без этой развилки лендинг стал бы первым экраном приложения.
 * 3. Гость в браузере → лендинг.
 *
 * Пререндер (`web/scripts/prerender.mjs`) печатает в `dist/landing.html` ровно
 * случай 3; nginx отдаёт этот файл на `location = /`. Решение «какой из трёх»
 * всё равно принимается ЗДЕСЬ, в одном месте и под тестом, а статика лишь
 * избавляет краулер от необходимости исполнять JS.
 */
export function ShellOrLanding(): JSX.Element {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { pathname } = useLocation();

  // Лендинг подменяет собой ТОЛЬКО сам корень. На любом вложенном адресе
  // оболочки (`/contracts`, `/me`, …) гость обязан получить прежнее поведение —
  // редирект на вход из `RequireAuth`, а не маркетинговую страницу вместо
  // запрошенного экрана.
  if (isAuthenticated || pathname !== '/') {
    return (
      <RequireAuth>
        <RequireGlobalOnboarding>
          <ShellLayout />
        </RequireGlobalOnboarding>
      </RequireAuth>
    );
  }

  if (isAppWrapper()) return <Navigate to="/welcome" replace />;

  return (
    <PublicLayout>
      <LandingPage />
    </PublicLayout>
  );
}
