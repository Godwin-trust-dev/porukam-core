import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { matchBundledLocale } from '@porukam/i18n';
import { LtrText } from '@porukam/ui';
import { applyLocale } from '../features/locale/applyLocale';
// Обёртка и типографика — ТЕ ЖЕ, что у публичного юр-документа (`/legal/terms`,
// `/legal/privacy`): один и тот же CSS-модуль, а не его копия. Страница стоит
// в том же ряду и обязана выглядеть одинаково с ним.
import sheet from './LegalDocumentPage.module.css';
import styles from './AccountDeletionPage.module.css';

/**
 * Адрес для запроса удаления у того, кто НЕ МОЖЕТ войти. Тот же, что в
 * Политике конфиденциальности (`l10n/packs/<code>.json` → `legal.privacy`,
 * раздел «Изменения и контакт») и в ответах помощи (`help.json`) — второго
 * контактного адреса у сервиса нет.
 */
export const ACCOUNT_DELETION_CONTACT_EMAIL = 'hello@trust-dev.com';

const STEP_KEYS = [
  'legal.accountDeletion.step1',
  'legal.accountDeletion.step2',
  'legal.accountDeletion.step3',
  'legal.accountDeletion.step4',
] as const;

/**
 * ПУБЛИЧНАЯ страница «Удаление аккаунта» — `/legal/account-deletion` (ADR-169).
 *
 * Зачем отдельная страница, если удаление и так есть в настройках: Google Play
 * требует от приложений с аккаунтами ССЫЛКУ на страницу, которая открывается у
 * постороннего человека без входа и по шагам объясняет, как удалить аккаунт,
 * что удаляется, что сохраняется и на какой срок, — с названием приложения на
 * ней. Экран внутри личного кабинета таким адресом быть не может: проверяющий
 * до него не дойдёт.
 *
 * Почему НЕ через общий `/legal/:doc` (`LegalDocumentPage`): тот тянет документ
 * с бэкенда (`GET /v1/legal/<doc>`, языковые пакеты `l10n/packs`), а здесь текст
 * описывает поведение КЛИЕНТА (пункты меню, кнопки, поле подтверждения) и обязан
 * меняться вместе с ним, в одном коммите. Поэтому — статический компонент на
 * ключах интерфейса; маршрут зарегистрирован ДО `/legal/:doc`.
 *
 * `?lang=` — как у юр-документов: проверяющему из Google нужен английский
 * независимо от языка его браузера, и сослаться на конкретный язык иначе нечем.
 */
export function AccountDeletionPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();

  const requestedLang = matchBundledLocale(searchParams.get('lang'));
  useEffect(() => {
    if (requestedLang) void applyLocale(i18n, requestedLang);
  }, [requestedLang, i18n]);

  const title = t('legal.accountDeletion.title');
  useEffect(() => {
    document.title = `${title} — Porukam`;
  }, [title]);

  // Адрес внутри предложения делаем НАСТОЯЩЕЙ ссылкой: человек, который не
  // может войти, должен попасть в почтовый клиент одним касанием, а не
  // переписывать адрес руками. Режем уже подставленную строку по самому
  // адресу — если переводчик потерял плейсхолдер, остаётся обычный абзац.
  const noAccessText = t('legal.accountDeletion.noAccessText', { email: ACCOUNT_DELETION_CONTACT_EMAIL });
  const [beforeEmail, afterEmail] = noAccessText.split(ACCOUNT_DELETION_CONTACT_EMAIL);

  return (
    <main className={sheet.page}>
      <article className={sheet.sheet}>
        <header className={sheet.head}>
          <p className={sheet.brand}>Porukam</p>
          <h1 className={sheet.title}>{title}</h1>
        </header>

        <p className={styles.lead}>{t('legal.accountDeletion.lead')}</p>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('legal.accountDeletion.stepsTitle')}</h2>
          <ol className={styles.steps}>
            {STEP_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('legal.accountDeletion.deletedTitle')}</h2>
          <p className={styles.text}>{t('legal.accountDeletion.deletedText')}</p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('legal.accountDeletion.keptTitle')}</h2>
          <p className={styles.text}>{t('legal.accountDeletion.keptText')}</p>
          <p className={styles.text}>{t('legal.accountDeletion.keptAnon')}</p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('legal.accountDeletion.blockedTitle')}</h2>
          <p className={styles.text}>{t('legal.accountDeletion.blockedText')}</p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('legal.accountDeletion.noAccessTitle')}</h2>
          <p className={styles.text} data-testid="account-deletion-contact">
            {afterEmail === undefined ? (
              noAccessText
            ) : (
              <>
                {beforeEmail}
                <LtrText>
                  {/* Адрес — технический идентификатор: в RTL-локалях он обязан
                      остаться слева направо, поэтому обёрнут в LtrText. */}
                  <a href={`mailto:${ACCOUNT_DELETION_CONTACT_EMAIL}`} className={styles.mail}>
                    {ACCOUNT_DELETION_CONTACT_EMAIL}
                  </a>
                </LtrText>
                {afterEmail}
              </>
            )}
          </p>
        </section>
      </article>
    </main>
  );
}
