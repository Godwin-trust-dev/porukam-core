import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { Logo } from '@porukam/ui';
import { bundledLocaleInfos } from '../../features/locale/bundledLocales';
import { parsePublicPath, publicPath } from '../../features/publicSite/pages';
import {
  SITE_SHOTS,
  SITE_SHOT_SIZE,
  siteShotLang,
  siteShotSrc,
} from '../../features/publicSite/shots';
import { publicMeta } from '../../features/publicSite/meta';
import { usePublicMeta } from '../../features/publicSite/usePublicMeta';
import styles from './PublicSite.module.css';

/**
 * Лендинг (ADR-195) — главная страница публичного контура.
 *
 * Весь текст, кроме заголовка героя, взят из НЕЙМСПЕЙСА `site`, который
 * сгенерирован из утверждённой витрины Google Play
 * (`docs/ops/store-listing/*.txt` → `scripts/l10n/import-store-listing.mjs`).
 * Это сознательно: тексты витрины владелец утвердил, они переведены на все 29
 * языков и прошли проверку терминологической красной линии (`check.py`).
 * Писать для лендинга второй, «свой» текст означало бы завести второе описание
 * продукта, которое неизбежно разойдётся с магазином.
 *
 * Заголовок героя — `auth.welcomeTitle`, тот же, что на экране входа: человек,
 * пришедший с лендинга, должен увидеть ту же фразу и понять, что попал туда же.
 */
export function LandingPage(): JSX.Element {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  // Язык берём из адреса, а не из состояния i18n: ссылки внизу страницы должны
  // вести на ТУ ЖЕ языковую версию, иначе человек с /ru/ уезжает на английскую.
  const locale = (parsePublicPath(pathname) ?? { locale: 'en' }).locale;
  usePublicMeta(publicMeta(t));
  // Подпись дорожки субтитров — самоназвание языка из реестра сборки (то же,
  // что в переключателе языков): в меню плеера человек ищет «Русский», а не
  // «Russian» и тем более не код.
  const captionsLabel =
    bundledLocaleInfos().find((l) => l.code === locale)?.self_name ?? locale;
  // Кадры интерфейса: русская версия страницы показывает русские снимки,
  // остальные 28 — английские (единственные два набора, которые сняты).
  const shotLang = siteShotLang(locale);
  const shotSize = SITE_SHOT_SIZE[shotLang];

  const blocks = [
    { key: 'contract', title: t('site.contractTitle'), text: t('site.contractText') },
    { key: 'stages', title: t('site.stagesTitle'), text: t('site.stagesText') },
    { key: 'payment', title: t('site.paymentTitle'), text: t('site.paymentText') },
    { key: 'evidence', title: t('site.evidenceTitle'), text: t('site.evidenceText') },
    { key: 'reputation', title: t('site.reputationTitle'), text: t('site.reputationText') },
  ];

  return (
    <div className={`${styles.page} ${styles.pageWide}`}>
      <section className={styles.hero}>
        <div className={styles.heroGlow} />
        <Logo variant="mark" size={64} className={styles.heroMark} />
        <h1 className={styles.heroTitle}>{t('auth.welcomeTitle')}</h1>
        <p className={styles.heroLead}>{t('site.hook')}</p>
        <p className={styles.heroText}>{t('site.problem')}</p>
        {/* Ролик «как это работает» (решение владельца 29.10: «только английский,
            остальное субтитры»). Интерфейс в кадре английский, субтитры — на
            языке страницы, включены сразу (`default`): для 28 языков из 29 они
            и есть объяснение, а не вспомогательная дорожка.

            `preload="none"` обязателен: иначе полтора мегабайта качаются у
            каждого, кто просто открыл лендинг. До нажатия виден только постер —
            один кадр из ролика. Подпись плеера берём из существующего ключа
            `help.howTitle`: заводить ради ролика новую строку и переводить её
            на 29 языков значило бы создать текст, которого владелец не видел. */}
        <figure className={styles.heroVideo}>
          <video
            className={styles.heroVideoPlayer}
            controls
            preload="none"
            playsInline
            poster="/media/tour-poster.png"
            aria-label={t('help.howTitle')}
          >
            <source src="/media/tour-en.webm" type="video/webm" />
            <track
              default
              kind="captions"
              srcLang={locale}
              label={captionsLabel}
              src={`/media/captions/${locale}.vtt`}
            />
          </video>
        </figure>
        <a className={styles.heroCta} href="/welcome">
          {t('auth.googleButton')}
        </a>
      </section>

      {/* Полоса кадров интерфейса — то же, что в карточке магазина: человек
          видит продукт до того, как решит, читать ли про него. Горизонтальная
          прокрутка с прилипанием (`scroll-snap`), подпись под каждым кадром —
          название экрана из самого интерфейса (`features/publicSite/shots.ts`).

          `loading="lazy"` обязателен: кадров восемь, на экран помещается два-три,
          и грузить остальные до прокрутки означает тратить трафик посетителя
          впустую. Размер проставлен атрибутами — пока кадр не пришёл, место
          под него уже занято и страница не прыгает. */}
      <section className={styles.shots} aria-label={t('help.howTitle')}>
        <ul className={styles.shotStrip}>
          {SITE_SHOTS.map((shot) => (
            <li key={shot.file} className={styles.shot}>
              <img
                className={styles.shotImage}
                src={siteShotSrc(shotLang, shot.file)}
                width={shotSize.width}
                height={shotSize.height}
                loading="lazy"
                decoding="async"
                alt={t(shot.captionKey)}
              />
              <span className={styles.shotCaption}>{t(shot.captionKey)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.blocks}>
        {blocks.map((b) => (
          <article key={b.key} className={styles.block}>
            <h2 className={styles.blockTitle}>{b.title}</h2>
            <p className={styles.blockText}>{b.text}</p>
          </article>
        ))}
      </section>

      <section className={styles.cta}>
        <h2 className={styles.ctaTitle}>{t('help.aboutTitle')}</h2>
        <p className={styles.blockText}>{t('help.aboutLead')}</p>
        <div className={styles.ctaLinks}>
          <Link to={publicPath(locale, 'how-it-works')} className={styles.ctaLink}>
            {t('help.howTitle')}
          </Link>
          <Link to={publicPath(locale, 'faq')} className={styles.ctaLink}>
            {t('help.faqTitle')}
          </Link>
        </div>
      </section>
    </div>
  );
}
