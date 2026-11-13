import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type HandleEntry } from '@porukam/core';
import { ContactPickerSheet, PartiesStep, type ContactPickerEntry } from '@porukam/ui';
import { useCurrentUser } from '../../features/auth/useAuth';
import { useHandleSearch } from '../../features/contracts/api';
import { useSaveContact, useSavedContacts } from '../../features/contacts/api';
import { handleKey, normalizeCounterpartyInput } from '../../features/contacts/handleInput';
import { useCreateRealContract, usePatchRealContract } from '../../features/contracts/realApi';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { useRealContract } from '../../features/contracts/realApi';
import { useReputationCard } from '../../features/reputation/api';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';

/**
 * Шаг «Стороны» (ADR-088 Фаза 2) — роль, идентификация по аккаунту, контрагент по
 * реальному префикс-поиску хендлов (ADR-092). ИМЕННО ЗДЕСЬ создаётся черновик:
 * `POST /v1/contracts` требует контрагента (`ContractCreateSerializer.validate`).
 * Инвайтов на бэке нет — контрагент только из найденных хендлов. Реквизиты сторон
 * (`party_details` мок-версии) на реальном контракте отсутствуют — блок убран
 * («не показываем то, чего нет»).
 */
export function PartiesStepPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const draftId = useContractNewStore((s) => s.draftId);
  const clientOption = useContractNewStore((s) => s.clientOption);
  const contractTypeCode = useContractNewStore((s) => s.contractTypeCode);
  const myRole = useContractNewStore((s) => s.myRole);
  const setRole = useContractNewStore((s) => s.setRole);
  const actingAs = useContractNewStore((s) => s.actingAs);
  const selected = useContractNewStore((s) => s.counterparty);
  const setSelected = useContractNewStore((s) => s.setCounterparty);
  const counterpartyPrefill = useContractNewStore((s) => s.counterpartyPrefill);
  const setDraftId = useContractNewStore((s) => s.setDraftId);
  const setSaving = useContractNewStore((s) => s.setSaving);
  const { data: me } = useCurrentUser();

  const [query, setQuery] = useState(selected?.display_name ?? '');
  // Возврат в черновик (замечание владельца 06.09: «договор из чата не подтянул
  // даже контрагента»). Контрагент уже стоит на договоре, но стор после
  // ремаунта пуст, и шаг выглядел так, будто контрагента нет. Сторона в API —
  // только profile_id; имя и хендл берём из карточки репутации (тот же
  // источник, что у CounterpartyLink в чате). Подставляем ОДИН раз на
  // черновик: очистка поля пользователем — это замена контрагента, а не повод
  // вернуть прежнего.
  const { data: draft } = useRealContract(draftId ?? undefined);
  const myProfileIds = useMemo(() => new Set((me?.profiles ?? []).map((p) => p.id)), [me]);
  const draftCounterparty = draft?.parties.find((p) => !myProfileIds.has(p.profile_id));
  const keptSeededFor = useRef<string | null>(null);
  const needKept = !!draftId && !selected && keptSeededFor.current !== draftId;
  const { data: keptCard } = useReputationCard(needKept && draftCounterparty ? draftCounterparty.profile_id : undefined);
  const keptHandleRef = useRef<string | null>(null);
  useEffect(() => {
    if (!needKept || !draftCounterparty || !keptCard) return;
    // Карточка репутации отдаёт хендл без «@», справочник и поиск — с ним.
    const raw = (keptCard.handle ?? '').trim();
    const handle = raw ? (raw.startsWith('@') ? raw : `@${raw}`) : '';
    const kept: HandleEntry = {
      handle,
      display_name: keptCard.display_name ?? handle,
      kind: draftCounterparty.acting_as,
      verification_level: 'basic',
    };
    keptSeededFor.current = draftId;
    keptHandleRef.current = handle || null;
    setSelected(kept);
    setQuery(kept.display_name || kept.handle);
  }, [needKept, draftCounterparty, keptCard, draftId, setSelected]);
  const [serverError, setServerError] = useState<string | null>(null);
  const { data: results } = useHandleSearch(query);
  const create = useCreateRealContract();
  const patch = usePatchRealContract(draftId ?? undefined);

  // ── Книга контактов (решение владельца 05.09) ──
  // Справочник грузится вместе с шагом, а не только при открытии шита: пометка
  // «в контактах» нужна и в обычной выдаче поиска по хендлу.
  const { data: contacts } = useSavedContacts();
  const saveContact = useSaveContact();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  // Поиск по платформе внутри шита — только по явному «Искать … на платформе»
  // (`null` = не запускали): книга контактов не должна сама ходить в сеть.
  const [platformQuery, setPlatformQuery] = useState<string | null>(null);
  const { data: platformResults, isFetching: platformPending } = useHandleSearch(
    platformQuery ?? '',
    platformQuery !== null,
  );

  const savedHandles = useMemo(
    () => new Set((contacts ?? []).map((c) => `@${handleKey(c.target_handle)}`).filter((h) => h !== '@')),
    [contacts],
  );

  /** Фильтр справочника — по имени и @хендлу, с первого символа, без задержки. */
  const pickerContacts = useMemo<ContactPickerEntry[]>(() => {
    const rows = (contacts ?? []).map((c) => ({
      id: c.id,
      name: c.display_name || c.target_display_name || c.target_handle || '',
      handle: c.target_handle,
    }));
    const needle = pickerQuery.trim().replace(/^@+/, '').toLowerCase();
    const found = needle
      ? rows.filter((r) => r.name.toLowerCase().includes(needle) || handleKey(r.handle).includes(needle))
      : rows;
    // Контакты без @хендла выбрать нельзя — они уходят в конец списка
    // (решение владельца 05.09: приглушаем, но не прячем).
    return [...found.filter((r) => r.handle), ...found.filter((r) => !r.handle)];
  }, [contacts, pickerQuery]);

  const pickerPlatform = useMemo<ContactPickerEntry[] | undefined>(
    () =>
      platformResults?.map((h) => ({
        id: h.handle,
        name: h.display_name,
        handle: h.handle,
        saved: savedHandles.has(h.handle.toLowerCase()),
      })),
    [platformResults, savedHandles],
  );

  function closePicker(): void {
    setPickerOpen(false);
    setPickerQuery('');
    setPlatformQuery(null);
  }

  /** Выбор строки книги контактов. Контакт без хендла выбрать нельзя —
   * `POST /contracts` принимает только `counterparty_handle`. */
  function pickFromContacts(entry: ContactPickerEntry): void {
    if (!entry.handle) return;
    const fromSearch = platformResults?.find((h) => h.handle === entry.handle);
    const picked: HandleEntry = fromSearch ?? {
      handle: entry.handle,
      display_name: entry.name,
      kind: 'person',
      verification_level: 'basic',
    };
    setSelected(picked);
    setQuery(picked.display_name || picked.handle);
    closePicker();
  }

  // Без типа договора и без черновика создать нечего — `POST /v1/contracts`
  // ответит 400 «нужен client_option или contract_type_code» (отсмотр
  // 2026-08-23: стор обнулился, пользователь заполнил видимые поля и упёрся
  // в ошибку). Возвращаем на шаг «Тип», не давая дойти до обречённого запроса.
  const typeMissing = !draftId && !clientOption && !contractTypeCode;
  useEffect(() => {
    if (typeMissing) navigate('../type', { replace: true });
  }, [typeMissing, navigate]);

  // Предзаполнение из `?counterparty=@handle` (карточка репутации, ADR-093).
  useEffect(() => {
    if (counterpartyPrefill && !selected && !query) setQuery(counterpartyPrefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только первичное предзаполнение
  }, [counterpartyPrefill]);

  // Автовыбор контрагента из префилла (отсмотр 2026-08-24: «хендл должен
  // автоматически подтягиваться»): раньше префилл только вписывал текст в
  // поиск, и результат приходилось выбирать руками. Точное совпадение хендла
  // из результатов выбирается само; как только человек изменил текст поиска
  // (query ≠ префилл) — автовыбор больше не вмешивается.
  useEffect(() => {
    if (!counterpartyPrefill || selected) return;
    const norm = (s: string): string => s.trim().replace(/^@/, '').toLowerCase();
    if (norm(query) !== norm(counterpartyPrefill)) return;
    const match = results?.find((h) => norm(h.handle) === norm(counterpartyPrefill));
    if (match) {
      setSelected(match);
      setQuery(match.display_name);
    }
  }, [counterpartyPrefill, selected, query, results, setSelected]);

  // Возврат в черновик (ADR-104): контрагент уже на договоре, стор после
  // ремаунта пуст — «Далее» без повторного выбора; новый выбор = замена (PATCH).
  const counterpartyKept = !!draftId && !selected;

  async function next(): Promise<void> {
    if (counterpartyKept) {
      navigate('../details');
      return;
    }
    if (!selected?.handle) return;
    // Контрагент из черновика, подставленный выше, не менялся — PATCH не нужен.
    if (draftId && keptHandleRef.current && selected.handle === keptHandleRef.current) {
      navigate('../details');
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      if (!draftId) {
        const contract = await create.mutateAsync({
          ...(clientOption === 'service'
            ? { client_option: 'service' }
            : { contract_type_code: contractTypeCode ?? undefined }),
          my_role: myRole,
          my_acting_as: actingAs,
          counterparty_handle: selected.handle,
        });
        setDraftId(contract.id);
      } else {
        await patch.mutateAsync({ counterparty_handle: selected.handle });
      }
      navigate('../details');
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.partiesTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.partiesSub')}</p>

      <PartiesStep
        role={myRole}
        onRoleChange={setRole}
        roleLocked={!!draftId}
        roleLabel={t('contractNew.roleLabel')}
        roleCustomerLabel={t('contractNew.roleCustomer')}
        roleContractorLabel={t('contractNew.roleContractor')}
        viewerIdentity={{
          name: me?.display_name ?? '',
          maskedEmail: me?.identity?.masked_email ?? '',
          provider: 'google',
          verified: me?.identity?.verified ?? false,
          providerLabel: t('contractNew.identityProvider'),
          verifiedLabel: t('contractNew.identityVerified'),
          accountHint: t('contractNew.identityAccountHint'),
          escalationHint: t('contractNew.identityEscalationHint'),
        }}
        counterpartyLabel={t('contractNew.counterpartyLabel')}
        counterpartySearchPlaceholder={t('contractNew.counterpartySearch')}
        inviteLabel={t('contractNew.inviteCta')}
        inviteHint={t('contractNew.counterpartyNotFoundHint')}
        businessLabel={t('contractNew.businessLabel')}
        personLabel={t('contractNew.personLabel')}
        contactsLabel={t('contractNew.contactsCta')}
        savedContactLabel={t('contractNew.contactsSavedBadge')}
        saveContactLabel={t('contractNew.contactsSaveCta')}
        contactSavedLabel={t('contractNew.contactsSavedNote')}
        counterparty={{
          query,
          // Поле принимает и «@хендл», и ссылку на карточку — из ссылки хендл
          // вырезается прямо на вводе (вставка из чата — обычный путь).
          onQueryChange: (q) => {
            setQuery(normalizeCounterpartyInput(q));
            setSelected(null);
          },
          results,
          selected,
          onPick: (h) => {
            setSelected(h);
            setQuery(h.display_name);
          },
          onOpenContacts: () => setPickerOpen(true),
          savedHandles,
          onSaveContact: selected?.handle ? () => saveContact.mutate({ target_handle: selected.handle }) : undefined,
          contactSavePending: saveContact.isPending,
        }}
      />

      <ContactPickerSheet
        open={pickerOpen}
        onClose={closePicker}
        title={t('contractNew.contactsTitle')}
        closeLabel={t('common.close')}
        query={pickerQuery}
        onQueryChange={(q) => {
          setPickerQuery(normalizeCounterpartyInput(q));
          setPlatformQuery(null);
        }}
        searchLabel={t('contractNew.contactsSearchLabel')}
        searchPlaceholder={t('contractNew.contactsSearchPlaceholder')}
        contacts={pickerContacts}
        contactsEmpty={(contacts ?? []).length === 0}
        emptyTitle={t('contractNew.contactsEmptyTitle')}
        emptyText={t('contractNew.contactsEmptyText')}
        platformActive={platformQuery !== null}
        platformPending={platformPending}
        platformResults={pickerPlatform}
        onSearchPlatform={() => setPlatformQuery(pickerQuery.trim())}
        searchPlatformLabel={t('contractNew.contactsSearchPlatform', {
          query: pickerQuery.trim().replace(/^@+/, ''),
        })}
        platformEmptyText={t('contractNew.contactsPlatformEmpty')}
        platformPendingText={t('common.loading')}
        savedLabel={t('contractNew.contactsSavedBadge')}
        noHandleHint={t('contractNew.contactsNoHandleHint')}
        onPick={pickFromContacts}
      />

      {counterpartyKept ? <p className={wizardStyles.stepSub}>{t('contractNew.counterpartyKeptHint')}</p> : null}
      {draftId ? <p className={wizardStyles.stepSub}>{t('contractNew.typeLockedHint')}</p> : null}
      {serverError ? (
        <p role="alert" className={wizardStyles.stepError} data-testid="parties-error">
          {serverError}
        </p>
      ) : null}

      <WizardFooter
        onBack={() => navigate(clientOption === 'service' ? '../sphere' : '../type')}
        onNext={next}
        nextDisabled={!selected?.handle && !counterpartyKept}
        nextLoading={create.isPending || patch.isPending}
      />
    </>
  );
}
