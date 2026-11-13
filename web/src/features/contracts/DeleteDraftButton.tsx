import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { Button, Modal } from '@porukam/ui';
import { useDeleteRealContract } from './realApi';

/**
 * «Удалить черновик» с подтверждением (ADR-104). Одна кнопка для панели
 * master-detail и полной карточки — после 204 вызывающий решает, куда уйти
 * (`onDeleted`): со страницы карточки — в список, из панели — снять `?sel=`.
 */
export function DeleteDraftButton({
  contractId,
  onDeleted,
  block,
}: {
  contractId: string;
  onDeleted: () => void;
  block?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = useDeleteRealContract();

  async function confirm(): Promise<void> {
    setErr(null);
    try {
      await del.mutateAsync(contractId);
      setOpen(false);
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      <Button variant="destructive" block={block} onClick={() => setOpen(true)} data-testid="delete-draft">
        {t('contracts.draftDelete')}
      </Button>
      <Modal
        open={open}
        title={t('contracts.draftDeleteConfirmTitle')}
        onClose={() => setOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirm()}
              loading={del.isPending}
              data-testid="delete-draft-confirm"
            >
              {t('contracts.draftDelete')}
            </Button>
          </>
        }
      >
        <p>{t('contracts.draftDeleteConfirmText')}</p>
        {err ? <p role="alert">{err}</p> : null}
      </Modal>
    </>
  );
}
