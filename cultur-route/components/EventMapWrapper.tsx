'use client';

import dynamic from 'next/dynamic';
import type { MapEvent } from '@/components/ItineraryMap';

// ssr: false — Google Maps 依賴瀏覽器的 window，不可在 SSR 階段執行
const MapComponent = dynamic(
  () => import('@/components/ItineraryMap'),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-gray-50 flex items-center justify-center text-gray-400 text-sm font-bold animate-pulse rounded-xl">
        地圖載入中...
      </div>
    ),
  }
);

export default function EventMapWrapper({ event }: { event: MapEvent }) {
  return <MapComponent events={[event]} />;
}
