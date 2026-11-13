import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Callout, Icon, TextField } from '@porukam/ui';
import { accountDeletionBlockedContext, useDeleteAccount } from '../../features/profile/api';
import { markAccountDeleted } from '../../features/auth/accountDeletedNotice';
import styles from './DeleteAccountPage.module.css';

/**
 * Сверка слова-подтверждения. Проверяем НАМЕРЕНИЕ, а не аккуратность набора:
 *  - краевые пробелы (мобильная клавиатура добавляет свой) — срезаем;
 *  - регистр — по правилам ЯЗЫКА, не по локали машины: турецкое/азербайджанское
 *    `SİL` наивным `toLowerCase()` даёт `si̇l`, а `sil` человека — `sil`, и
 *    совпадение не наступило бы никогда;
 *  - апострофы-модификаторы — выбрасываем: узбекское `OʻCHIRISH` пишется через
 *    U+02BB, которого нет на обычной клавиатуре, человек наберёт `O'CHIRISH`.
 */
export function normalizeConfirmWord(value: string, locale: string): string {
  return value
    .trim()
    .replace(/[\u02BB\u02BC\u2018\u2019'`\u00B4]/g, '')
    .toLocaleLowerCase(locale);
}

/**
 * Удаление аккаунта (ADR-169) — рабочий флоу, не заглушка.
 *
 * Два шага намеренно. Первый — честное предупреждение (что уничтожается, что
 * остаётся) со ссылкой на публичную страницу `/legal/account-deletion`, где то
 * же самое расписано подробно и куда может заглянуть человек, который ещё не
 * решил. Второй — ручной ввод слова подтверждения: кнопка «Удалить» рядом с
 * «Отмена» слишком дешёвая для действия, которое ничем не отменяется
 * (ПД уничтожаются вместе с ключами шифрования).
 *
 * 409 `account_deletion_blocked` — не ошибка, а состояние: материалы сделки
 * принадлежат ОБЕИМ сторонам, и уйти в одиночку из незакрытого договора нельзя.
 * Показываем числа и уводим в сделки, а не сухой текст ошибки.
 */
export function DeleteAccountPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const del = useDeleteAccount();
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState('');

  const confirmWord = t('profile.accDeleteWord');
  const wordMatches =
    normalizeConfirmWord(word, i18n.language) === normalizeConfirmWord(confirmWord, i18n.language);
  const blocked = accountDeletionBlockedContext(del.error);
  const failed = del.isError && !blocked;

  async function onDelete(): Promise<void> {
    try {
      await del.mutateAsync();
    } catch {
      // Ошибка уже в `del.error` — экран показывает её ниже (409 или общий текст).
      return;
    }
    // Сессия очищена в `useDeleteAccount`; флаг переживает и наш переход, и
    // опережающий редирект `RequireAuth` — уведомление увидит `WelcomePage`.
    markAccountDeleted();
    navigate('/welcome', { replace: true });
  }

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.backBtn} onClick={() => navigate('/me/settings/account')} aria-label={t('common.back')}>
        <Icon name="back" size={20} directional />
      </button>
      <h1 className={styles.title}>{t('profile.accDeleteFlowTitle')}</h1>
      <Callout tone="warn">{t('profile.accDeleteFlowText')}</Callout>

      <Link className={styles.docLink} to="/legal/account-deletion">
        {t('profile.accDeleteWhatLink')}
      </Link>

      {blocked ? (
        <Callout tone="info" title={t('profile.accDeleteBlockedTitle')}>
          <p className={styles.blockedText} data-testid="delete-blocked">
            {t('profile.accDeleteBlockedText', {
              contracts: blocked.active_contracts,
              disputes: blocked.open_disputes,
            })}
          </p>
          <Link className={styles.docLink} to="/contracts">
            {t('profile.accDeleteBlockedAction')}
          </Link>
        </Callout>
      ) : null}

      {failed ? (
        <p role="alert" className={styles.error}>
          {t('profile.accDeleteFailed')}
        </p>
      ) : null}

      {confirming ? (
        <TextField
          label={t('profile.accDeleteWordField')}
          hint={t('profile.accDeleteWordLabel', { word: confirmWord })}
          value={word}
          onChange={(e) => setWord(e.target.value)}
          autoComplete="off"
          data-testid="delete-word"
        />
      ) : null}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => navigate('/me/settings/account')}>
          {t('profile.accDeleteCancel')}
        </Button>
        {confirming ? (
          <Button
            variant="destructive"
            disabled={!wordMatches}
            loading={del.isPending}
            onClick={() => void onDelete()}
            data-testid="delete-submit"
          >
            {t('profile.accDeleteFinal')}
          </Button>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)} data-testid="delete-continue">
            {t('profile.accDeleteConfirm')}
          </Button>
        )}
      </div>
    </div>
  );
}
