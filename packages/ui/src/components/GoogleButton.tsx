import { Button } from './Button';
import styles from './GoogleButton.module.css';

export interface GoogleButtonProps {
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

/** Официальная марка Google — фиксированные фирменные цвета самого Google. */
function GoogleMark(): JSX.Element {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true" className={styles.mark}>
      <path
        fill="#4285F4"
        d="M19.6 10.23c0-.68-.06-1.36-.18-2H10v3.79h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.75 2.97-4.32 2.97-7.31Z"
      />
      <path
        fill="#34A853"
        d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.23-2.5c-.9.6-2.05.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H1.06v2.59A10 10 0 0 0 10 20Z"
      />
      <path fill="#FBBC05" d="M4.41 11.92A6 6 0 0 1 4.09 10c0-.67.11-1.32.32-1.92V5.49H1.06a10 10 0 0 0 0 9.02l3.35-2.6Z" />
      <path
        fill="#EA4335"
        d="M10 3.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87C14.95.98 12.7 0 10 0A10 10 0 0 0 1.06 5.49l3.35 2.6C5.2 5.72 7.4 3.96 10 3.96Z"
      />
    </svg>
  );
}

/**
 * Вход через Google (GLOBAL У1, DEV-auth-onboarding §3).
 *
 * Это НЕ самостоятельная кнопка, а `Button variant="outline" block` с марко́й
 * Google в `leftIcon` (замечание владельца 08.09: «шрифты и размер разный у
 * гугл регистрации и у нашей по почте, хочется единый стиль страницы»). Раньше
 * у компонента была своя раскладка — Inter 500 против Onest 700 у соседней
 * «Войти по почте», рамка 1.5px против 1px, поля 20px против 24px, — и две
 * кнопки подряд на экране входа читались как из разных наборов. Теперь
 * геометрия и типографика приходят из `Button.module.css`, здесь остаётся
 * только логотип.
 *
 * Фирменные цвета самой марки — единственное оправданное исключение из «только
 * токены»: перекрашивать чужой логотип под `--pr-*` нельзя (гайдлайны бренда
 * Google), см. [Ф-решение] в отчёте по задаче.
 *
 * Пока идёт запрос, марка не рисуется: `Button` в состоянии `loading` гасит
 * подпись и кладёт поверх спиннер, и цветной логотип рядом с ним читался бы
 * как заминка отрисовки, а не как ожидание.
 */
export function GoogleButton({ label, onClick, loading, disabled }: GoogleButtonProps): JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      block
      onClick={onClick}
      loading={loading}
      disabled={disabled}
      leftIcon={loading ? undefined : <GoogleMark />}
    >
      {label}
    </Button>
  );
}
