import type { HandleEntry, RevisionAuthorRole } from '@porukam/core';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { TextField } from './Field';
import { IdentityCard, type IdentityCardProps } from './IdentityCard';
import { SearchResultRow } from './SearchResultRow';
import { Segmented } from './Segmented';
import { Surface } from './Surface';
import styles from './PartiesStep.module.css';

export interface PartiesStepCounterparty {
  query: string;
  onQueryChange: (q: string) => void;
  /** undefined — запрос ещё не вводился; [] — контрагент не найден (инвайт). */
  results?: HandleEntry[];
  selected: HandleEntry | null;
  onPick: (h: HandleEntry) => void;
  /** Не передан — инвайтов нет (реальный контур, ADR-088 Фаза 2): при «не найдено» показывается только подсказка. */
  onInvite?: (displayName: string) => void;
  /** Открыть книгу контактов. Не передан — кнопки «Из контактов» нет. */
  onOpenContacts?: () => void;
  /** Хендлы справочника в каноничном виде «@хендл» в нижнем регистре — пометка «в контактах». */
  savedHandles?: ReadonlySet<string>;
  /** Сохранить выбранного контрагента в справочник. Не передан — ссылки нет. */
  onSaveContact?: () => void;
  contactSavePending?: boolean;
}

export interface PartiesStepProps {
  role: RevisionAuthorRole;
  onRoleChange: (role: RevisionAuthorRole) => void;
  viewerIdentity: IdentityCardProps;
  counterparty: PartiesStepCounterparty;
  /** Короткая заметка про способ расчёта — готовый текст из paymentPolicy (без денежных литералов в компоненте). */
  paymentPolicyNote?: string;
  roleLabel: string;
  roleCustomerLabel: string;
  roleContractorLabel: string;
  counterpartyLabel: string;
  counterpartySearchPlaceholder: string;
  inviteLabel: string;
  inviteHint: string;
  businessLabel: string;
  personLabel: string;
  /** Подпись кнопки «Из контактов» (она же доступное имя). */
  contactsLabel?: string;
  /** Пометка «в контактах» у находки, которая уже в справочнике. */
  savedContactLabel?: string;
  /** «Сохранить в контакты» — необязательная ссылка под выбранным контрагентом. */
  saveContactLabel?: string;
  /** «Контакт сохранён» — та же строка после сохранения. */
  contactSavedLabel?: string;
  /** Роль зафиксирована (черновик уже создан — `my_role` не патчится, ADR-088 Фаза 2). */
  roleLocked?: boolean;
}

/** Стороны договора (DEV-09 §2/§3): роль, идентификация, контрагент (или инвайт). */
export function PartiesStep({
  role,
  onRoleChange,
  viewerIdentity,
  counterparty,
  paymentPolicyNote,
  roleLabel,
  roleCustomerLabel,
  roleContractorLabel,
  counterpartyLabel,
  counterpartySearchPlaceholder,
  inviteLabel,
  inviteHint,
  businessLabel,
  personLabel,
  contactsLabel,
  savedContactLabel,
  saveContactLabel,
  contactSavedLabel,
  roleLocked,
}: PartiesStepProps): JSX.Element {
  const searching = counterparty.query.trim().length > 0;
  const notFound = searching && counterparty.results !== undefined && counterparty.results.length === 0 && !counterparty.selected;
  const saved = counterparty.savedHandles;
  const isSaved = (handle: string | null | undefined): boolean => !!handle && !!saved?.has(handle.toLowerCase());
  const selectedSaved = isSaved(counterparty.selected?.handle);

  return (
    <div className={styles.wrap}>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{roleLabel}</span>
        {/* Роли — общий `Segmented` в тёмном тоне (доска B, PR #368): тот же
            язык сегмента, что на шаге «Тип», вместо собственных светлых кнопок. */}
        <Segmented
          className={styles.roleSegmented}
          ariaLabel={roleLabel}
          tone="dark"
          value={role}
          onChange={onRoleChange}
          disabled={roleLocked}
          items={[
            { value: 'customer' as const, label: roleCustomerLabel },
            { value: 'contractor' as const, label: roleContractorLabel },
          ]}
        />
      </div>

      <IdentityCard {...viewerIdentity} />

      <div className={styles.field}>
        {/* Подпись поля и книга контактов — в одной строке: справочник открывается
            прямо от «Второй стороны» (решение владельца 05.09), а не прячется
            в подсказке под полем. */}
        <span className={styles.fieldLabelRow}>
          <span className={styles.fieldLabel}>{counterpartyLabel}</span>
          {counterparty.onOpenContacts && contactsLabel ? (
            <button
              type="button"
              className={styles.contactsBtn}
              onClick={counterparty.onOpenContacts}
              aria-label={contactsLabel}
              data-testid="open-contacts"
            >
              <Icon name="contacts" size={16} />
              <span className={styles.contactsBtnText}>{contactsLabel}</span>
            </button>
          ) : null}
        </span>
        <TextField
          placeholder={counterpartySearchPlaceholder}
          value={counterparty.query}
          onChange={(e) => counterparty.onQueryChange(e.target.value)}
          data-testid="counterparty-search"
        />
        {searching && !counterparty.selected && counterparty.results && counterparty.results.length > 0 ? (
          /* Результат поиска — общая строка со списком `/search` (ADR-152,
             замечание владельца 03.09): имя первой строкой, @хендл — второй,
             «Компания/Человек» словом-цветом в её конце. Раньше имя и хендл
             стояли в одной строке-обёртке и на 390px наезжали друг на друга. */
          <Surface data-testid="counterparty-results">
            {counterparty.results.map((h) => (
              <SearchResultRow
                key={h.handle}
                data-testid={`handle-${h.handle}`}
                name={h.display_name}
                handle={h.handle}
                /* «в контактах» — второй строкой после хендла: контрагент, с
                   которым уже работали, узнаётся до открытия справочника. */
                meta={savedContactLabel && isSaved(h.handle) ? savedContactLabel : undefined}
                statusLabel={h.kind === 'business' ? businessLabel : personLabel}
                statusTone={h.kind === 'business' ? 'amber' : 'neutral'}
                onOpen={() => counterparty.onPick(h)}
              />
            ))}
          </Surface>
        ) : null}
        {notFound ? (
          <div className={styles.invite}>
            <p className={styles.inviteHint}>{inviteHint}</p>
            {counterparty.onInvite ? (
              <button
                type="button"
                className={styles.inviteBtn}
                onClick={() => counterparty.onInvite?.(counterparty.query.trim())}
                data-testid="invite-counterparty"
              >
                <Icon name="plus" size={16} /> {inviteLabel} «{counterparty.query.trim()}»
              </button>
            ) : null}
          </div>
        ) : null}
        {counterparty.selected ? (
          <>
            <div className={styles.selected}>
              <Badge tone="teal">{counterparty.selected.display_name}</Badge>
              <span className={styles.handle}>{counterparty.selected.handle || inviteLabel}</span>
              <Badge tone={counterparty.selected.kind === 'business' ? 'amber' : 'neutral'}>
                {counterparty.selected.kind === 'business' ? businessLabel : personLabel}
              </Badge>
            </div>
            {/* Выбрали не из справочника — предлагаем положить туда. Строго
                необязательно: договор создаётся и без сохранения контакта. */}
            {counterparty.onSaveContact && saveContactLabel && contactSavedLabel && counterparty.selected.handle ? (
              selectedSaved ? (
                <span className={styles.savedNote} data-testid="counterparty-saved">
                  {contactSavedLabel}
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.saveContactBtn}
                  onClick={counterparty.onSaveContact}
                  disabled={counterparty.contactSavePending}
                  data-testid="save-counterparty-contact"
                >
                  {saveContactLabel}
                </button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      {paymentPolicyNote ? <p className={styles.policyNote}>{paymentPolicyNote}</p> : null}
    </div>
  );
}
