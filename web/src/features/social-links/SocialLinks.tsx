import { isFeatureEnabled } from '../../shared/features';
import styles from './SocialLinks.module.css';

/**
 * Иконки соцсетей (отсмотр 2026-08-22: instagram, telegram, facebook, linkedin —
 * «пока без ссылок, их дам отдельно позже, иконки пока спрячь»). Ссылки — из
 * env (`VITE_SOCIAL_*`); блок показывается только при флаге `socialLinks` И
 * хотя бы одной заданной ссылке. Иконки — инлайн-SVG, без внешних запросов.
 */
const LINKS: Array<{ key: string; label: string; href: string | undefined; path: string }> = [
  {
    key: 'instagram',
    label: 'Instagram',
    href: import.meta.env.VITE_SOCIAL_INSTAGRAM,
    path: 'M12 2.2c3.2 0 3.6 0 4.8.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.7 4.8-4.9 4.9-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-3.3-.1-4.8-1.7-4.9-4.9C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8C2.4 3.9 4 2.4 7.2 2.3 8.4 2.2 8.8 2.2 12 2.2zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zm5.2-9.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  },
  {
    key: 'telegram',
    label: 'Telegram',
    href: import.meta.env.VITE_SOCIAL_TELEGRAM,
    path: 'M21.9 4.6 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.2L6 13.6l-4.9-1.5c-1.1-.3-1.1-1.1.2-1.6L20.5 3.1c.9-.3 1.7.2 1.4 1.5z',
  },
  {
    key: 'facebook',
    label: 'Facebook',
    href: import.meta.env.VITE_SOCIAL_FACEBOOK,
    path: 'M13.5 22v-8.2h2.8l.4-3.2h-3.2V8.5c0-.9.3-1.6 1.6-1.6h1.7V4.1c-.3 0-1.3-.1-2.5-.1-2.5 0-4.1 1.5-4.1 4.2v2.4H7.4v3.2h2.8V22h3.3z',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    href: import.meta.env.VITE_SOCIAL_LINKEDIN,
    path: 'M6.9 8.5H3.6V21h3.3V8.5zM5.3 3a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8zM21 13.3c0-3.6-1.9-5.2-4.5-5.2-2 0-2.9 1.1-3.4 1.9V8.5H9.8V21h3.3v-6.9c0-1.8.3-3.6 2.6-3.6 2.2 0 2.2 2.1 2.2 3.7V21H21v-7.7z',
  },
];

export function SocialLinks({ title }: { title: string }): JSX.Element | null {
  if (!isFeatureEnabled('socialLinks')) return null;
  const active = LINKS.filter((l) => !!l.href);
  if (active.length === 0) return null;
  return (
    <nav className={styles.wrap} aria-label={title}>
      <span className={styles.title}>{title}</span>
      <ul className={styles.list}>
        {active.map((l) => (
          <li key={l.key}>
            <a href={l.href} target="_blank" rel="noopener noreferrer" className={styles.link} aria-label={l.label}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
                <path d={l.path} />
              </svg>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
