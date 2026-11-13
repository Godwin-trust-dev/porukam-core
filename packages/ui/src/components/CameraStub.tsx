import { Icon } from './Icon';
import styles from './CameraStub.module.css';

export interface CameraStubProps {
  text: string;
}

/**
 * Заглушка камеры (DEV-11 §3/§0): сдержанно сообщает, что точная съёмка с метками —
 * в приложении (скоро); НЕ блокирует веб-загрузку — просто информационная строка рядом
 * с зоной загрузки.
 */
export function CameraStub({ text }: CameraStubProps): JSX.Element {
  return (
    <p className={styles.stub} data-testid="camera-stub">
      <Icon name="camera" size={16} className={styles.icon} />
      {text}
    </p>
  );
}
