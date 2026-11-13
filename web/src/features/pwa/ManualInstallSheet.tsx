import { useTranslation } from 'react-i18next';
import { InstallHowToSheet } from '@porukam/ui';

export interface ManualInstallSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Шторка «как поставить приложение руками» для НЕ-iOS браузеров (DEV-15 §2).
 *
 * Нужна там, где системного промпта нет: браузер вообще не шлёт `beforeinstallprompt`
 * (Samsung Internet ставит через собственное меню, Firefox — тоже) либо Chrome уже
 * потратил своё единственное событие и до истечения таймаута его не повторит. Раньше в
 * этих случаях и строка настроек, и кнопка баннера молчали — человек считал, что установка
 * сломана (жалоба владельца 05.09, Samsung S22 Ultra).
 *
 * Отдельный компонент, а не два вызова `InstallHowToSheet`: шторку показывают две точки
 * входа (настройки и install-баннер), и набор шагов у них обязан быть один и тот же.
 */
export function ManualInstallSheet({ open, onClose }: ManualInstallSheetProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <InstallHowToSheet
      open={open}
      onClose={onClose}
      titleLabel={t('pwa.manualSheetTitle')}
      // Не последовательность шагов, а ВАРИАНТЫ по браузерам — отсюда `ul` (ordered не задан).
      steps={[
        { icon: 'more', label: t('pwa.manualSheetChrome') },
        { icon: 'home', label: t('pwa.manualSheetSamsung') },
        { icon: 'install', label: t('pwa.manualSheetDesktop') },
      ]}
      closeLabel={t('pwa.iosSheetClose')}
    />
  );
}
