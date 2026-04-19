'use client';

import { Fragment, useMemo, useState } from 'react';
import { APIProvider, Map as GoogleMap, AdvancedMarker, InfoWindow } from '@vis.gl/react-google-maps';
import { useItineraryStore } from '@/store/useItineraryStore';
import type { Event } from '@/types';

const TAITUNG_CENTER = { lat: 22.75, lng: 121.15 };

type MappedEvent = Event & { latitude: number; longitude: number };

interface Cluster {
  key: string;
  lat: number;
  lng: number;
  events: MappedEvent[];
}

/** 首頁活動瀏覽地圖（@vis.gl/react-google-maps）
 *  - 同座標活動自動群集為數字泡泡，點擊展開活動清單
 *  - 無座標活動不顯示（EventCard 已有「尚無地圖標記」提示）
 *  - hoveredEventId 與 EventCard hover 雙向連動
 */
export default function EventsMap({ events }: { events: Event[] }) {
  const { hoveredEventId, setHoveredEventId } = useItineraryStore();
  const [openClusterKey, setOpenClusterKey] = useState<string | null>(null);

  // ── 有效座標過濾（memoized，避免每次 render 觸發 clusters 重算）─────────────
  const mapped = useMemo(
    () => events.filter(
      (e): e is MappedEvent =>
        typeof e.latitude === 'number' && typeof e.longitude === 'number'
    ),
    [events]
  );

  // ── 依精確座標（4 位小數 ≈ 11 m 精度）分群 ────────────────────────────────────
  const clusters = useMemo((): Cluster[] => {
    const groups = new Map<string, MappedEvent[]>();
    for (const event of mapped) {
      const key = `${event.latitude.toFixed(4)},${event.longitude.toFixed(4)}`;
      const arr = groups.get(key) ?? [];
      arr.push(event);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).map(([key, evs]) => {
      const [lat, lng] = key.split(',').map(Number);
      return { key, lat, lng, events: evs };
    });
  }, [mapped]);

  // ── Debug 檢查點（確認資料流量）────────────────────────────────────────────────
  console.log(
    `[EventsMap] 總接收: ${events.length} 筆`,
    `| 有座標: ${mapped.length} 筆`,
    `| 分群後: ${clusters.length} 個 cluster`,
  );

  return (
    <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ''}>
      <GoogleMap
        defaultCenter={TAITUNG_CENTER}
        defaultZoom={10}
        mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID}
        gestureHandling="greedy"
        disableDefaultUI={false}
        style={{ width: '100%', height: '100%' }}
        reuseMaps
        onClick={() => setOpenClusterKey(null)}
      >
        {clusters.map((cluster) => {
          const isMulti   = cluster.events.length > 1;
          const sole      = cluster.events[0];
          const isHovered = !isMulti && sole.id === hoveredEventId;
          const isOpen    = openClusterKey === cluster.key;

          return (
            <Fragment key={cluster.key}>

              <AdvancedMarker
                position={{ lat: cluster.lat, lng: cluster.lng }}
                onClick={isMulti ? () => setOpenClusterKey(isOpen ? null : cluster.key) : undefined}
              >
                {isMulti ? (
                  /* ── 群集泡泡：inline style 保底，避免 Tailwind JIT 掃不到 ── */
                  <div
                    style={{
                      width:           '36px',
                      height:          '36px',
                      borderRadius:    '50%',
                      backgroundColor: isOpen ? '#f97316' : '#1e3a5f',
                      color:           '#ffffff',
                      fontWeight:      700,
                      fontSize:        '13px',
                      display:         'flex',
                      alignItems:      'center',
                      justifyContent:  'center',
                      boxShadow:       isOpen
                        ? '0 0 0 4px rgba(249,115,22,0.35), 0 4px 12px rgba(0,0,0,0.3)'
                        : '0 0 0 4px rgba(30,58,95,0.25), 0 4px 12px rgba(0,0,0,0.25)',
                      cursor:          'pointer',
                      userSelect:      'none',
                      transform:       isOpen ? 'scale(1.12)' : 'scale(1)',
                      transition:      'background-color 0.2s, transform 0.2s, box-shadow 0.2s',
                      zIndex:          20,
                    }}
                  >
                    {cluster.events.length}
                  </div>
                ) : (
                  /* ── 單一活動圖釘 ── */
                  <div
                    onMouseEnter={() => setHoveredEventId(sole.id)}
                    onMouseLeave={() => setHoveredEventId(null)}
                    className={[
                      'relative flex flex-col items-center cursor-pointer select-none',
                      'transition-all duration-300 origin-bottom',
                      isHovered ? 'scale-150 z-20' : 'scale-100 z-10',
                    ].join(' ')}
                  >
                    {/* Hover tooltip */}
                    <div className={[
                      'absolute bottom-full mb-2 left-1/2 -translate-x-1/2',
                      'max-w-[180px] whitespace-nowrap',
                      'bg-white text-slate-800 text-[11px] font-bold',
                      'px-3 py-1.5 rounded-xl shadow-lg border border-slate-100 pointer-events-none',
                      'transition-all duration-300',
                      isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
                    ].join(' ')}>
                      {sole.venue_name || sole.title}
                      <span className="
                        absolute top-full left-1/2 -translate-x-1/2
                        border-4 border-transparent border-t-white
                        drop-shadow-[0_1px_0_rgba(0,0,0,0.06)]
                      " />
                    </div>

                    {/* 圓形圖釘 */}
                    <div
                      style={{
                        width:           '32px',
                        height:          '32px',
                        borderRadius:    '50%',
                        backgroundColor: isHovered ? '#f97316' : '#2563eb',
                        display:         'flex',
                        alignItems:      'center',
                        justifyContent:  'center',
                        boxShadow:       isHovered
                          ? '0 0 0 4px rgba(253,186,116,0.6), 0 6px 16px rgba(249,115,22,0.5)'
                          : '0 2px 8px rgba(0,0,0,0.25)',
                        transition:      'background-color 0.3s, box-shadow 0.3s',
                      }}
                    >
                      <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ffffff' }} />
                    </div>

                    {/* 圖釘尖角 */}
                    <div style={{
                      width:       0,
                      height:      0,
                      marginTop:   '-1px',
                      borderLeft:  '4px solid transparent',
                      borderRight: '4px solid transparent',
                      borderTop:   `6px solid ${isHovered ? '#f97316' : '#2563eb'}`,
                      transition:  'border-top-color 0.3s',
                    }} />
                  </div>
                )}
              </AdvancedMarker>

              {/* ── 群集展開 InfoWindow ── */}
              {isMulti && isOpen && (
                <InfoWindow
                  position={{ lat: cluster.lat, lng: cluster.lng }}
                  onCloseClick={() => setOpenClusterKey(null)}
                >
                  <div style={{ minWidth: '200px', maxHeight: '220px', overflowY: 'auto' }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', marginBottom: '8px', paddingBottom: '6px', borderBottom: '1px solid #f1f5f9' }}>
                      {cluster.events[0].venue_name}
                      <span style={{ marginLeft: '6px', fontWeight: 400, color: '#94a3b8' }}>
                        共 {cluster.events.length} 個活動
                      </span>
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      {cluster.events.map(ev => (
                        <a
                          key={ev.id}
                          href={`/event/${ev.id}`}
                          style={{ fontSize: '12px', fontWeight: 500, color: '#334155', textDecoration: 'none', padding: '4px 0', borderBottom: '1px solid #f8fafc', lineHeight: 1.4 }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#0d9488')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#334155')}
                        >
                          {ev.title}
                        </a>
                      ))}
                    </div>
                  </div>
                </InfoWindow>
              )}

            </Fragment>
          );
        })}
      </GoogleMap>
    </APIProvider>
  );
}
