'use client';

import 'driver.js/dist/driver.css';
import { driver } from 'driver.js';
import type { DriveStep } from 'driver.js';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { CircleHelp } from 'lucide-react';
import {
  HOME_TOUR_KEY,
  ITINERARY_TOUR_KEY,
  homeSteps,
  itinerarySteps,
} from '@/lib/tourConfig';

const LEGACY_TOUR_KEYS = ['cultrRoute_homeTour_v1', 'cultrRoute_itineraryTour_v1'];

function buildTour(steps: DriveStep[], tourKey: string) {
  let d: ReturnType<typeof driver>;
  d = driver({
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: '下一步 →',
    prevBtnText: '← 上一步',
    doneBtnText: '完成 ✓',
    smoothScroll: true,
    overlayColor: 'rgba(27, 46, 38, 0.65)',
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

  // 清除舊版 v1 快取，確保使用者能看到最新導引
  useEffect(() => {
    LEGACY_TOUR_KEYS.forEach(k => localStorage.removeItem(k));
  }, []);

  // Auto-start on first visit, only on pages with a defined tour
  useEffect(() => {
    if (!hasTour) return;
    if (localStorage.getItem(tourKey)) return;
    const t = setTimeout(() => buildTour(getFilteredSteps(), tourKey).drive(), 800);
    return () => clearTimeout(t);
  }, [pathname, hasTour, getFilteredSteps, tourKey]);

  const startTour = useCallback(() => {
    buildTour(getFilteredSteps(), tourKey).drive();
  }, [getFilteredSteps, tourKey]);

  if (!hasTour) return null;

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
