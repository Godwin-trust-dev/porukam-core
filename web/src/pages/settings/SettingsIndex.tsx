import { Navigate } from 'react-router-dom';
import { useDesktopLayout } from '@porukam/ui';
import { SettingsHubPage } from './SettingsHubPage';

/**
 * Что показать на самом `/me/settings` (замечание владельца 01.09).
 *
 * Узкий экран — ХАБ строками: разделы видны списком, «Язык» первой строкой.
 * Десктоп — сразу первый раздел, как было: там разделы и так всегда на глазах
 * липким рейлом слева, и хаб был бы лишним экраном перед каждым заходом.
 *
 * Ширина решается здесь, а не двумя маршрутами: адрес у настроек один, и
 * deep-link `/me/settings` обязан работать на любом устройстве одинаково.
 */
export function SettingsIndex(): JSX.Element {
  const isDesktop = useDesktopLayout();
  if (isDesktop) return <Navigate to="profile" replace />;
  return <SettingsHubPage />;
}
