import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@porukam/core';
import { Button, EmptyState, ErrorState, Icon, ListRow, ScreenHeader, Skeleton, Surface } from '@porukam/ui';
import { useRemoveContact, useSavedContacts } from '../features/contacts/api';
import { copyToClipboard } from '../shared/clipboard';
import styles from './ContactsPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/me/contacts` — справочник сохранённых контактов (отсмотр 2026-08-22:
 * «не сохраняются контакты, пустой справочник»). Источник — `GET /v1/users/me/
 * contacts` (apps.social): контрагент попадает сюда с черновика договора
 * (ADR-106, source=deal) либо вручную с карточки репутации (source=manual).
 * Строка кликабельна → карточка репутации; хендл копируется одним нажатием.
 *
 * Раскладка — строка доски A (ADR-152). Замечание владельца 03.09:
 * «сохранённые контакты — не красиво на телефоне, с рамкой, комкано».
 * Своей рамки у контакта больше нет: `Surface bleed` даёт одну белую
 * плоскость во всю ширину телефона с hairline между строками, `ListRow` —
 * аватар-лид, имя первой строкой, «@хендл · откуда» второй, действия справа.
 */
export function ContactsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = useSavedContacts();
  const remove = useRemoveContact();

  const sourceLabel = (source: string): string => {
    if (source === 'deal') return t('profile.contactsSourceDeal');
    if (source === 'phonebook') return t('profile.contactsSourcePhonebook');
    return t('profile.contactsSourceManual');
  };

  /** Кнопки внутри строки — свои интерактивные элементы: клик по ним карточку не открывает. */
  function stop(e: MouseEvent): void {
    e.stopPropagation();
  }

  let body: JSX.Element;
  if (isPending) {
    body = (
      <div className={styles.loading} aria-busy="true">
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
      </div>
    );
  } else if (error) {
    body = (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(error)}
        code={error instanceof ApiError ? error.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => void refetch()}
      />
    );
  } else if (!data || data.length === 0) {
    body = <EmptyState icon="profile" title={t('profile.contactsEmptyTitle')} text={t('profile.contactsEmptyText')} />;
  } else {
    body = (
      <Surface bleed data-testid="contacts-list">
        {data.map((c) => {
          const name = c.display_name || c.target_display_name || c.target_handle || t('profile.contactsNoHandle');
          const cardPath = c.target_handle
            ? `/${c.target_handle}`
            : c.target_profile_id
              ? `/reputation/profiles/${c.target_profile_id}`
              : null;
          return (
            <ListRow
              key={c.id}
              avatarName={name}
              avatarHandle={c.target_handle ?? undefined}
              /* ADR-173: фото контакта; null — инициалы на цветном круге. */
              avatarSrc={c.target_avatar_url ?? undefined}
              title={name}
              // «@хендл · откуда контакт» — второй строкой, а не бейджем рядом
              // с именем: на 390px бейдж «Из договора» наезжал на хендл.
              meta={
                <>
                  {c.target_handle ? <span className={styles.handle}>{c.target_handle}</span> : null}
                  {c.target_handle ? ' · ' : null}
                  {sourceLabel(c.source)}
                </>
              }
              ariaLabel={cardPath ? t('profile.contactsOpenCard') : name}
              onOpen={() => {
                if (cardPath) navigate(cardPath);
              }}
              trailing={
                <span className={styles.actions} onClick={stop}>
                  {c.target_handle ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('common.copyHandle')}
                      onClick={() => void copyToClipboard(c.target_handle || '')}
                    >
                      <Icon name="copy" size={16} />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('profile.contactsRemove')}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  >
                    <Icon name="close" size={16} />
                  </Button>
                </span>
              }
            />
          );
        })}
      </Surface>
    );
  }

  return (
    <div className={styles.page}>
      <ScreenHeader
        title={t('profile.contactsTitle')}
        back={
          <button type="button" className={styles.back} onClick={() => navigate('/me')} aria-label={t('profile.title')}>
            <Icon name="back" size={20} directional />
          </button>
        }
      />
      {body}
    </div>
  );
}
