'use client';
import { useEffect, useState } from 'react';

export type BrowserType = 'ios-safari' | 'ios-chrome' | 'android' | 'non-native' | 'other';

export function usePWAInstall() {
  const [browserType, setBrowserType] = useState<BrowserType>('other');
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      !!(window.navigator as unknown as Record<string, unknown>)['standalone'];
    setIsStandalone(standalone);

    if (/Line\//i.test(ua)) { setBrowserType('non-native'); return; }
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    if (isIOS && /CriOS/.test(ua)) { setBrowserType('ios-chrome'); return; }
    if (isIOS) { setBrowserType('ios-safari'); return; }
    if (/Android/.test(ua)) { setBrowserType('android'); return; }
  }, []);

  return { browserType, isStandalone };
}
