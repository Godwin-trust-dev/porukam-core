import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupGeoScope, GroupKind, GroupLink } from '@porukam/core';
import { Button, FieldHelp, Icon, SelectField, SpherePicker, TextArea, TextField } from '@porukam/ui';
import { useSpheres } from '../contractNew/api';
import { useDebounced } from '../../shared/useDebounced';
import type { GroupFormInput } from './api';
import { useSphereName } from './useSphereName';
import {
  COUNTRY_CODES,
  GROUP_GEO_SCOPES,
  GROUP_KINDS,
  countryName,
  groupGeoLabelKey,
  groupKindHintKey,
  groupKindLabelKey,
} from './groupLabels';
import styles from './GroupForm.module.css';

export const MAX_GROUP_LINKS = 10;

export const EMPTY_GROUP_FORM: GroupFormInput = {
  kind: 'clan',
  name: '',
  description: '',
  sphere_code: '',
  geo_scope: 'world',
  country_code: '',
  city_name: '',
  links: [],
  is_public: true,
  join_policy: 'open',
};

export interface GroupFormErrors {
  name?: string;
  sphere?: string;
  geo?: string;
}

/** Клиентская проверка инвариантов бэка (ADR-117 §§2–3): сфера обязательна,
 * `country` требует страну, `city` — страну и город. Сообщения — ключи i18n. */
export function validateGroupForm(v: GroupFormInput): GroupFormErrors {
  const errors: GroupFormErrors = {};
  if (!v.name.trim()) errors.name = 'dashboard.groupNameRequired';
  if (!v.sphere_code) errors.sphere = 'dashboard.groupSphereRequired';
  if ((v.geo_scope === 'country' && !v.country_code) || (v.geo_scope === 'city' && (!v.country_code || !v.city_name.trim()))) {
    errors.geo = 'dashboard.groupGeoInvalid';
  }
  return errors;
}

/** Ссылки без адреса — не отправляем (пустая строка в форме ≠ ошибка). */
export function normalizeLinks(links: GroupLink[]): GroupLink[] {
  return links.map((l) => ({ url: l.url.trim(), label: l.label.trim() })).filter((l) => l.url.length > 0);
}

/**
 * Поля витрины объединения (ADR-117 §§1–4) — одна форма для создания
 * (GroupsPage) и настроек (GroupDetailPage). Хендл здесь НЕ живёт: при создании
 * он рядом с формой (обязателен, §5), в настройках — отдельный блок смены.
 * Состояние — у родителя (value/onChange), компонент без сети, кроме
 * каталога сфер (`useSpheres`, та же выдача, что в мастере договора).
 */
export function GroupForm({
  value,
  onChange,
  errors,
}: {
  value: GroupFormInput;
  onChange: (patch: Partial<GroupFormInput>) => void;
  errors?: GroupFormErrors;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [sphereOpen, setSphereOpen] = useState(!value.sphere_code);
  const [sphereQuery, setSphereQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const debouncedQuery = useDebounced(sphereQuery, 250);
  const { data: spheres } = useSpheres(debouncedQuery);
  const sphereName = useSphereName(value.sphere_code);
  const lang = i18n.language;
  const countries = COUNTRY_CODES.map((code) => ({ code, name: countryName(code, lang) })).sort((a, b) =>
    a.name.localeCompare(b.name, lang),
  );

  const setLink = (index: number, patch: Partial<GroupLink>): void =>
    onChange({ links: value.links.map((l, i) => (i === index ? { ...l, ...patch } : l)) });

  return (
    <div className={styles.form} data-testid="group-form">
      <TextField
        label={t('dashboard.groupNameLabel')}
        help={t('hints.group.name')}
        helpLabel={t('hints.helpButton')}
        required
        value={value.name}
        error={errors?.name ? t(errors.name) : undefined}
        onChange={(e) => onChange({ name: e.target.value })}
        data-testid="group-name"
      />

      <SelectField
        label={t('dashboard.groupKindLabel')}
        value={value.kind}
        help={t(groupKindHintKey(value.kind))}
        helpLabel={t('dashboard.groupKindHelpLabel')}
        onChange={(e) => onChange({ kind: e.target.value as GroupKind })}
        data-testid="group-kind"
      >
        {GROUP_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(groupKindLabelKey(k))}
          </option>
        ))}
      </SelectField>

      <div className={styles.sphere} data-testid="group-sphere">
        <span className={styles.sphereLabel}>
          {t('dashboard.groupSphereLabel')} *
          <FieldHelp label={t('hints.helpButton')}>{t('hints.group.sphere')}</FieldHelp>
        </span>
        {value.sphere_code && !sphereOpen ? (
          <div className={styles.sphereChosen}>
            <span className={styles.sphereName} data-testid="group-sphere-name">
              {sphereName}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSphereOpen(true)}>
              {t('dashboard.groupSphereChange')}
            </Button>
          </div>
        ) : (
          <SpherePicker
            query={sphereQuery}
            onQueryChange={setSphereQuery}
            results={spheres?.results}
            popular={spheres?.popular ?? []}
            selectedCode={value.sphere_code || undefined}
            showAll={showAll}
            onToggleShowAll={() => setShowAll((v) => !v)}
            searchLabel={t('contractNew.sphereSearchLabel')}
            hideSearchLabel
            searchPlaceholder={t('contractNew.sphereSearchPlaceholder')}
            popularLabel={t('contractNew.spherePopular')}
            browseAllLabel={t('contractNew.sphereBrowseAll')}
            emptyHint={t('contractNew.sphereEmptyHint')}
            onPick={(s) => {
              onChange({ sphere_code: s.code });
              setSphereQuery('');
              setShowAll(false);
              setSphereOpen(false);
            }}
          />
        )}
        {errors?.sphere ? <p className={styles.error} role="alert">{t(errors.sphere)}</p> : null}
      </div>

      <div className={styles.row}>
        <SelectField
          label={t('dashboard.groupGeoLabel')}
          help={t('hints.group.geo')}
          helpLabel={t('hints.helpButton')}
          value={value.geo_scope}
          onChange={(e) => onChange({ geo_scope: e.target.value as GroupGeoScope })}
          data-testid="group-geo"
        >
          {GROUP_GEO_SCOPES.map((s) => (
            <option key={s} value={s}>
              {t(groupGeoLabelKey(s))}
            </option>
          ))}
        </SelectField>
        {value.geo_scope !== 'world' ? (
          <SelectField
            label={t('dashboard.groupCountryLabel')}
            help={t('hints.group.country')}
            helpLabel={t('hints.helpButton')}
            required
            value={value.country_code}
            onChange={(e) => onChange({ country_code: e.target.value })}
            data-testid="group-country"
          >
            <option value="">—</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
      {value.geo_scope === 'city' ? (
        <TextField
          label={t('dashboard.groupCityLabel')}
          help={t('hints.group.city')}
          helpLabel={t('hints.helpButton')}
          required
          value={value.city_name}
          onChange={(e) => onChange({ city_name: e.target.value })}
          data-testid="group-city"
        />
      ) : null}
      {errors?.geo ? <p className={styles.error} role="alert">{t(errors.geo)}</p> : null}

      <TextArea
        label={t('dashboard.groupDescriptionLabel')}
        help={t('hints.group.description')}
        helpLabel={t('hints.helpButton')}
        rows={4}
        value={value.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />

      <div className={styles.row}>
        <SelectField
          label={t('dashboard.groupPublicLabel')}
          help={t('hints.group.visibility')}
          helpLabel={t('hints.helpButton')}
          value={value.is_public ? 'public' : 'private'}
          onChange={(e) => onChange({ is_public: e.target.value === 'public' })}
          data-testid="group-visibility"
        >
          <option value="public">{t('dashboard.groupPublicOn')}</option>
          <option value="private">{t('dashboard.groupPublicOff')}</option>
        </SelectField>
        <SelectField
          label={t('dashboard.groupJoinPolicyLabel')}
          help={t('hints.group.joinPolicy')}
          helpLabel={t('hints.helpButton')}
          value={value.join_policy}
          onChange={(e) => onChange({ join_policy: e.target.value as GroupFormInput['join_policy'] })}
          data-testid="group-policy"
        >
          <option value="open">{t('dashboard.groupPolicyOpen')}</option>
          <option value="approval">{t('dashboard.groupPolicyApproval')}</option>
        </SelectField>
      </div>

      <div className={styles.links} data-testid="group-links">
        <span className={styles.sphereLabel}>
          {t('dashboard.groupLinksLabel')}
          <FieldHelp label={t('hints.helpButton')}>{t('hints.group.links')}</FieldHelp>
        </span>
        {value.links.map((link, i) => (
          <div key={i} className={styles.linkRow}>
            <TextField
              label={t('dashboard.groupLinkUrlLabel')}
              type="url"
              value={link.url}
              onChange={(e) => setLink(i, { url: e.target.value })}
            />
            <TextField
              label={t('dashboard.groupLinkTitleLabel')}
              maxLength={50}
              value={link.label}
              onChange={(e) => setLink(i, { label: e.target.value })}
            />
            <Button
              variant="ghost"
              aria-label={t('dashboard.groupLinkRemove')}
              onClick={() => onChange({ links: value.links.filter((_, j) => j !== i) })}
            >
              <Icon name="close" size={16} />
            </Button>
          </div>
        ))}
        {value.links.length < MAX_GROUP_LINKS ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Icon name="plus" size={16} />}
              onClick={() => onChange({ links: [...value.links, { url: '', label: '' }] })}
              data-testid="group-link-add"
            >
              {t('dashboard.groupLinkAdd')}
            </Button>
          </div>
        ) : (
          <p className={styles.hint}>{t('dashboard.groupLinksMax')}</p>
        )}
      </div>
    </div>
  );
}
