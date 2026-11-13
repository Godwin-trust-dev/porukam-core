import { Sheet } from './Sheet';
import { CompareColumns } from './CompareColumns';
import { useIsDesktop } from '../useIsDesktop';
import styles from './OfficialTextView.module.css';

export interface OfficialTextViewProps {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  sheetTitle: string;
  sheetSubtitle: string;
  footnote: string;
  officialText: string;
  viewerLabel: string;
  viewerText: string;
  officialLabel: string;
}

/**
 * «Показать» официальный текст (DEV-16b §3/§6) — mobile: `Sheet` со свёрстанным EN-текстом
 * + пояснением, что подписывается эта версия; desktop: вместо модалки — `CompareColumns`
 * инлайн (та же логика брейкпоинта, что у `LanguageSwitcher`, DEV-16a — mobile/desktop
 * структурно разные контейнеры, решает JS через `useIsDesktop`, не CSS-скрытие).
 * `officialText`/хеши внутри — вызывающая сторона оборачивает `dir="ltr"`, где уместно
 * (коды/хеши, не сам текст — целый абзац на английском в `dir="ltr"` не нуждается).
 */
export function OfficialTextView({
  open,
  onClose,
  closeLabel,
  sheetTitle,
  sheetSubtitle,
  footnote,
  officialText,
  viewerLabel,
  viewerText,
  officialLabel,
}: OfficialTextViewProps): JSX.Element | null {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    if (!open) return null;
    return <CompareColumns viewerLabel={viewerLabel} viewerText={viewerText} officialLabel={officialLabel} officialText={officialText} />;
  }

  return (
    <Sheet open={open} title={sheetTitle} onClose={onClose} closeLabel={closeLabel}>
      <p className={styles.subtitle}>{sheetSubtitle}</p>
      <p className={styles.text}>{officialText}</p>
      <p className={styles.footnote}>{footnote}</p>
    </Sheet>
  );
}
