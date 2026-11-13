import type { TFunction } from 'i18next';
import type { PublicPageSlug } from './pages';

/**
 * `<title>` и описание публичной страницы (ADR-195) — ОДНА функция на два
 * применения: страница ставит их эффектом в браузере (`usePublicMeta`), а
 * скрипт пререндера печатает те же строки в статический HTML при сборке.
 *
 * Отдельных строк под мету нет и заводить их не нужно: заголовок страницы и
 * первый абзац её текста — ровно то, что должно стоять в выдаче и в превью
 * ссылки. Два разных текста («для людей» и «для поисковика») разошлись бы.
 */
export function publicMeta(t: TFunction, slug?: PublicPageSlug): { title: string; description: string } {
  switch (slug) {
    case 'about':
      return { title: t('help.aboutTitle'), description: t('help.aboutLead') };
    case 'how-it-works':
      return { title: t('help.howTitle'), description: t('site.stagesText') };
    case 'trust':
      return { title: t('site.evidenceTitle'), description: t('site.evidenceText') };
    case 'faq':
      return { title: t('help.faqTitle'), description: t('help.aboutLead') };
    default:
      // Лендинг: заголовок — тот же, что на экране входа, описание — хук витрины.
      return { title: t('auth.welcomeTitle'), description: t('site.hook') };
  }
}
