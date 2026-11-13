import { useTranslation } from 'react-i18next';
import { EmptyState, type IconName } from '@porukam/ui';

/**
 * Заглушка раздела Ф1 (§3.4 п.2): все разделы кроме «Сделок» и «Профиля» —
 * пустое состояние с иконкой (§9.9). Текст — СВОЙ у каждого раздела
 * (`emptySection.<section>`, отсмотр прода 2026-08-18 №6): человек должен
 * понять, что это за раздел и что здесь появится; общий `emptySection.text` —
 * фолбэк для раздела без описания.
 */
export function SectionEmptyPage({ section, icon }: { section: string; icon: IconName }): JSX.Element {
  const { t } = useTranslation();
  const name = t(`nav.${section}`);
  return (
    <EmptyState
      icon={icon}
      title={t('emptySection.title', { name })}
      text={t([`emptySection.${section}`, 'emptySection.text'])}
    />
  );
}
