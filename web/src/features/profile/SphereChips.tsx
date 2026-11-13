import { useTranslation } from 'react-i18next';
import { Badge } from '@porukam/ui';
import { useSpheres } from '../contractNew/api';

/** Чипы заявленных сфер (ADR-122) — имена из каталога `GET /spheres`
 * (как у сфер сделок на карточке); код без имени показывается как есть. */
export function SphereChips({ codes, testId = 'sphere-chips' }: { codes: string[]; testId?: string }): JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useSpheres('');
  if (codes.length === 0) return null;
  const nameOf = (code: string): string =>
    [...(data?.results ?? []), ...(data?.popular ?? [])].find((s) => s.code === code)?.name ?? code;
  return (
    <div data-testid={testId} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--pr-sp-2)', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--pr-fs-sm)', color: 'var(--pr-text-2)' }}>{t('profile.spheresTitle')}:</span>
      {codes.map((code) => (
        <Badge key={code} tone="ink">
          {nameOf(code)}
        </Badge>
      ))}
    </div>
  );
}
