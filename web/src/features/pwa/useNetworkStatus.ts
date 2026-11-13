import { useEffect, useState } from 'react';

/** `navigator.onLine` + события `online`/`offline` (DEV-15 §3) — для `NetworkBanner`. */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    function onOnline(): void {
      setOnline(true);
    }
    function onOffline(): void {
      setOnline(false);
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}
