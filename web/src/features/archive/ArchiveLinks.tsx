import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type ArchiveLink } from '@porukam/core';
import { Badge, Button, Icon, Modal, Toast } from '@porukam/ui';
import { copyToClipboard } from '../../shared/clipboard';
import { useFormatters } from '../../shared/formatters';
import { useRevokeArchiveLink } from './archiveApi';
import styles from './archive.module.css';

export interface ArchiveLinksProps {
  contractId: string;
  links: ArchiveLink[];
}

/**
 * Ссылки сторон на артефакты (ADR-139 §7): свои — с адресом, копированием,
 * счётчиком обращений и отзывом (подтверждение); чужой стороны — без адреса
 * (`url: null`, токен виден только ей); отозванные — с датой.
 * Своя ссылка = есть `url`; отозванная = `revoked_at`; иначе — другой стороны.
 */
export function ArchiveLinks({ contractId, links }: ArchiveLinksProps): JSX.Element | null {
  const { t } = useTranslation();
  const { formatDateTime } = useFormatters();
  const revoke = useRevokeArchiveLink(contractId);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<ArchiveLink | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  if (links.length === 0) return null;

  async function copy(url: string): Promise<void> {
    if (await copyToClipboard(url)) setCopied(true);
  }

  async function confirmRevoke(): Promise<void> {
    if (!toRevoke) return;
    setErr(null);
    try {
      await revoke.mutateAsync(toRevoke.id);
      setToRevoke(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  const roleLabel = (role: ArchiveLink['party_role']): string => (role === 'customer' ? t('contract.roleCustomer') : t('contract.roleContractor'));

  return (
    <div data-testid="archive-links">
      <p className={styles.artifactText}>{t('archive.linksText')}</p>
      <ul className={styles.links}>
        {links.map((l) => {
          const mine = l.url !== null;
          const revoked = l.revoked_at !== null;
          return (
            <li key={l.id} className={styles.linkRow} data-testid="archive-link" data-kind={l.kind} data-role={l.party_role} data-mine={mine} data-revoked={revoked}>
              <div className={styles.linkTop}>
                <p className={styles.linkKind}>{l.kind === 'package' ? t('archive.linkKindPackage') : t('archive.linkKindFiles')}</p>
                <Badge tone="neutral">{roleLabel(l.party_role)}</Badge>
                {revoked ? (
                  <Badge tone="red" dot>
                    {t('archive.linkRevoked', { time: formatDateTime(l.revoked_at!) })}
                  </Badge>
                ) : mine ? (
                  <Badge tone="teal">{t('archive.linkMine')}</Badge>
                ) : null}
              </div>
              {mine ? (
                <div className={styles.linkUrlRow}>
                  {/* Ссылка обязана быть КЛИКАБЕЛЬНОЙ (отсмотр 03.09: «ссылки
                      сторон не кликабельные»): раньше адрес выводился только
                      текстом в <code>, и единственным способом им воспользоваться
                      было копирование. `download` — тот же приём, что у кнопок
                      «Скачать пакет/файлы» (ExportArtifacts.tsx): ответ бэка несёт
                      Content-Disposition, а для service worker'а <a download> —
                      не навигация, поэтому запрос всегда уходит в сеть. */}
                  <a className={styles.linkUrl} href={l.url!} download data-testid="archive-link-url">
                    {l.url}
                  </a>
                  <button type="button" className={styles.iconBtn} aria-label={t('archive.copyLink')} onClick={() => void copy(l.url!)} data-testid="archive-link-copy">
                    <Icon name="copy" size={16} />
                  </button>
                </div>
              ) : !revoked ? (
                <p className={styles.exportMeta}>{t('archive.linkOther')}</p>
              ) : null}
              <p className={styles.exportMeta}>
                {t('archive.linkAccessCount', { count: l.access_count })}
                {l.last_access_at ? ` · ${t('archive.linkLastAccess', { time: formatDateTime(l.last_access_at) })}` : ''}
              </p>
              {mine ? (
                <div className={styles.linkActions}>
                  <Button variant="ghost" size="sm" onClick={() => setToRevoke(l)} data-testid="archive-link-revoke">
                    {t('archive.revokeLink')}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Modal
        open={!!toRevoke}
        title={t('archive.revokeConfirmTitle')}
        onClose={() => setToRevoke(null)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setToRevoke(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRevoke()} loading={revoke.isPending} data-testid="archive-link-revoke-confirm">
              {t('archive.revokeLink')}
            </Button>
          </>
        }
      >
        <p>{t('archive.revokeConfirmText')}</p>
        {err ? (
          <p role="alert">
            {t('archive.revokeError')}: {err}
          </p>
        ) : null}
      </Modal>
      {copied ? <Toast text={t('archive.linkCopied')} /> : null}
    </div>
  );
}
