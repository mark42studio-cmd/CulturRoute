'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, Map } from 'lucide-react';
import { useItineraryStore } from '@/store/useItineraryStore';

export default function BottomNav() {
  const pathname      = usePathname();
  const eventCount    = useItineraryStore(s => s.plannedEvents.length);
  const badgeLabel    = eventCount > 9 ? '9+' : String(eventCount);

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/80 backdrop-blur-md border-t border-stone-200 flex items-center"
      style={{ height: 'calc(4rem + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* 探索活動 */}
      <Link
        href="/"
        className={[
          'flex-1 h-16 flex flex-col items-center justify-center gap-0.5 transition-colors',
          pathname === '/' ? 'text-teal-700' : 'text-stone-400 active:text-stone-600',
        ].join(' ')}
      >
        <Compass size={22} strokeWidth={pathname === '/' ? 2.5 : 1.75} />
        <span className="text-[11px] font-medium tracking-wide">探索活動</span>
      </Link>

      {/* 路線規劃（帶活動數量 badge） */}
      <Link
        href="/itinerary"
        className={[
          'flex-1 h-16 flex flex-col items-center justify-center gap-0.5 transition-colors',
          pathname === '/itinerary' ? 'text-teal-700' : 'text-stone-400 active:text-stone-600',
        ].join(' ')}
      >
        <span className="relative inline-flex">
          <Map size={22} strokeWidth={pathname === '/itinerary' ? 2.5 : 1.75} />
          {eventCount > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center leading-none">
              {badgeLabel}
            </span>
          )}
        </span>
        <span className="text-[11px] font-medium tracking-wide">路線規劃</span>
      </Link>
    </nav>
  );
}
