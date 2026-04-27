'use client';

import 'driver.js/dist/driver.css';
import { driver } from 'driver.js';
import type { DriveStep } from 'driver.js';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import {
  HOME_TOUR_KEY,
  ITINERARY_TOUR_KEY,
  ITINERARY_TOUR_KEY_V3,
  homeSteps,
  itinerarySteps,
} from '@/lib/tourConfig';

const LEGACY_TOUR_KEYS = ['cultrRoute_homeTour_v1', 'cultrRoute_itineraryTour_v1', 'cultrRoute_itineraryTour_v2'];

function buildTour(steps: DriveStep[], tourKey: string) {
  let d: ReturnType<typeof driver>;
  d = driver({
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: '下一步 →',
    prevBtnText: '← 上一步',
    doneBtnText: '完成 ✓',
    smoothScroll: true,
    overlayColor: 'rgba(0,0,0,0.8)',
    steps,
    onDestroyStarted: () => {
      localStorage.setItem(tourKey, 'true');
      window.dispatchEvent(new CustomEvent('cultrRoute:tourDestroyed'));
      d.destroy();
    },
  });
  return d;
}

export default function TourGuide() {
  const pathname = usePathname();
  const isHome      = pathname === '/';
  const isItinerary = pathname === '/itinerary';
  const hasTour     = isHome || isItinerary;

  const steps   = isItinerary ? itinerarySteps : homeSteps;
  const tourKey = isItinerary ? ITINERARY_TOUR_KEY : HOME_TOUR_KEY;

  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDesktop(window.innerWidth >= 768);
    const handler = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const getFilteredSteps = useCallback(() => {
    if (isItinerary) {
      const hasEvents = document.querySelector('.planned-event-card') !== null;
      return steps.filter((s) => {
        if ((s as DriveStep & { element?: string }).element === '#tour-itinerary-events' && !hasEvents) return false;
        return true;
      });
    }
    return steps;
  }, [isItinerary, steps]);

  // 清除舊版 v1/v2 快取，確保使用者能看到最新導引
  useEffect(() => {
    LEGACY_TOUR_KEYS.forEach(k => localStorage.removeItem(k));
  }, []);

  // Auto-start on first visit, only on desktop pages with a defined tour
  useEffect(() => {
    if (!hasTour) return;
    if (isDesktop === null || !isDesktop) return;
    // 行程頁改用 v3 key；首頁沿用 tourKey
    const effectiveKey = isItinerary ? ITINERARY_TOUR_KEY_V3 : tourKey;
    if (localStorage.getItem(effectiveKey)) return;
    const t = setTimeout(() => buildTour(getFilteredSteps(), effectiveKey).drive(), 800);
    return () => clearTimeout(t);
  }, [pathname, hasTour, isDesktop, isItinerary, getFilteredSteps, tourKey]);

  const startTour = useCallback(() => {
    if (window.innerWidth < 768) return;
    const effectiveKey = isItinerary ? ITINERARY_TOUR_KEY_V3 : tourKey;
    buildTour(getFilteredSteps(), effectiveKey).drive();
  }, [isItinerary, getFilteredSteps, tourKey]);

  if (!hasTour) return null;
  // 行程頁手機版由 OnboardingModal 接手，不顯示 driver.js 按鈕
  if (isItinerary && isDesktop === false) return null;

  return (
    <button
      onClick={startTour}
      id="tour-help-btn"
      aria-label="開啟使用導引"
      title="使用導引"
      className="fixed bottom-6 left-6 z-40 bg-white text-[#1B2E26] border border-stone-200 shadow-md hover:shadow-lg hover:scale-105 active:scale-95 transition-all duration-200 flex items-center gap-1.5 px-3 py-2.5 rounded-full text-sm font-medium"
    >
      <CircleHelp size={16} className="shrink-0" />
      <span className="hidden sm:inline">使用導引</span>
    </button>
  );
}
