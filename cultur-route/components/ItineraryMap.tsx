'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  MarkerClusterer,
  DirectionsRenderer,
  Polyline,
  InfoWindow,
} from '@react-google-maps/api';

// ── Geocoding 快取（模組層級，跨 re-render 保留）────────────────────────────
// key: venue_name  value: { lat, lng } | null（null = geocoding 失敗）
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

// ── 常數 ──────────────────────────────────────────────────────────────────────

const TAITUNG_CENTER = { lat: 22.75, lng: 121.15 };

// Google Maps "Silver" 藝文質感主題
const SILVER_STYLE = [
  { elementType: 'geometry',              stylers: [{ color: '#f5f5f5' }] },
  { elementType: 'labels.icon',           stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill',      stylers: [{ color: '#616161' }] },
  { elementType: 'labels.text.stroke',    stylers: [{ color: '#f5f5f5' }] },
  { featureType: 'administrative.land_parcel', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
  { featureType: 'poi',                   elementType: 'geometry',            stylers: [{ color: '#eeeeee' }] },
  { featureType: 'poi',                   elementType: 'labels.text.fill',    stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park',              elementType: 'geometry',            stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'poi.park',              elementType: 'labels.text.fill',    stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'road',                  elementType: 'geometry',            stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial',         elementType: 'labels.text.fill',    stylers: [{ color: '#757575' }] },
  { featureType: 'road.highway',          elementType: 'geometry',            stylers: [{ color: '#dadada' }] },
  { featureType: 'road.highway',          elementType: 'labels.text.fill',    stylers: [{ color: '#616161' }] },
  { featureType: 'road.local',            elementType: 'labels.text.fill',    stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'transit.line',          elementType: 'geometry',            stylers: [{ color: '#e5e5e5' }] },
  { featureType: 'transit.station',       elementType: 'geometry',            stylers: [{ color: '#eeeeee' }] },
  { featureType: 'water',                 elementType: 'geometry',            stylers: [{ color: '#c9c9c9' }] },
  { featureType: 'water',                 elementType: 'labels.text.fill',    stylers: [{ color: '#9e9e9e' }] },
];

// 使用者自訂 Pin：帶序號的藍色圓形圖示（SVG Data URI）
function makeNumberedIcon(num: number): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
      <path d="M16 0C7.163 0 0 7.163 0 16c0 10.5 16 24 16 24S32 26.5 32 16C32 7.163 24.837 0 16 0z"
            fill="#2563eb"/>
      <circle cx="16" cy="16" r="10" fill="white"/>
      <text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif"
            font-size="${num > 9 ? '10' : '12'}" font-weight="bold" fill="#2563eb">${num}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

// ── 格式化工具 ─────────────────────────────────────────────────────────────────

/** 公尺 → "x.x km" 或 "xxx m" */
function fmtDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${meters} m`;
}

/** 秒 → "x 小時 xx 分" 或 "xx 分鐘" */
function fmtDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} 分鐘`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

// ── 台東縣空間邊界（Geocoding bounds 用）────────────────────────────────────────
// 完整含蓋台東縣陸域（含蘭嶼/綠島），作為 Google Geocoder 空間偏置框
const TAITUNG_BBOX = {
  south: 21.90, north: 23.60,   // 蘭嶼最南 ↔ 長濱最北
  west:  120.70, east: 121.65,  // 知本沿海 ↔ 太平洋岸
};

// 台東縣政府座標（作為「市中心」驗證錨點）
const TAITUNG_CITY_HALL = { lat: 22.7607, lng: 121.1477 };

// 這些場館關鍵字預期在台東市中心，若 Geocoding 結果距縣政府 > 5 km 視為錯誤
const CITY_CULTURAL_KEYWORDS = ['生活美學館', '藝文中心', '美術館'];

/** Haversine 距離（公尺） */
function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);
  const a2 =
    sinΔφ * sinΔφ + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinΔλ * sinΔλ;
  return R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
}

/**
 * 從 Geocoding 多筆結果中挑選最佳：
 * - 優先含 establishment / point_of_interest 的結果
 * - 降低權重：「僅含」 neighborhood / natural_feature 的結果（防止定位到空曠鄉郊）
 */
function selectBestGeoResult(
  results: google.maps.GeocoderResult[]
): google.maps.GeocoderResult | null {
  if (!results.length) return null;

  const PREFERRED = new Set(['establishment', 'point_of_interest']);
  const PENALIZED = new Set(['neighborhood', 'natural_feature', 'administrative_area_level_3']);

  let best = results[0];
  let bestScore = -Infinity;

  for (const r of results) {
    const types = r.types ?? [];
    let score = 0;
    if (types.some(t => PREFERRED.has(t))) score += 2;
    // 若所有 types 都是 penalized → 重罰；部分 penalized → 輕罰
    if (types.length > 0 && types.every(t => PENALIZED.has(t))) score -= 3;
    else if (types.some(t => PENALIZED.has(t))) score -= 1;
    if (score > bestScore) { bestScore = score; best = r; }
  }

  return best;
}

// 台東縣 16 行政區（依行政院地名資訊）
// 用於從 venue_name 自動萃取鄉鎮前綴，使 Geocoding 查詢更精準
const TAITUNG_TOWNSHIPS = [
  '台東市', '卑南鄉', '鹿野鄉', '關山鎮', '海端鄉', '池上鄉',
  '東河鄉', '成功鎮', '長濱鄉', '太麻里鄉', '金峰鄉', '大武鄉',
  '達仁鄉', '綠島鄉', '蘭嶼鄉', '延平鄉',
];

/**
 * 前端場館地址強制覆寫（鏡像後端 process_pending.py 的 VENUE_ADDRESS_MAP）
 *
 * 用途：DB 舊有資料的 address 欄位可能尚未填入（後端攔截器只對新資料生效），
 * 此 map 作為兜底保障，讓所有歷史資料也能立即使用精確地址查座標。
 *
 * 規則：substring match on venue_name，命中即回傳精確地址，不串接 venue_name。
 * 可隨時擴充，與後端 VENUE_ADDRESS_MAP 保持同步。
 */
const VENUE_ADDRESS_OVERRIDE: Record<string, string> = {
  '設計中心':   '台東縣台東市鐵花路369號',
  '文化百老匯': '台東縣台東市大同路254號',
};

/**
 * 建立 Geocoding 查詢字串
 *
 * 優先順序（嚴格）：
 *   1. event.address（DB 欄位，後端已驗證的精確地址）── 只用 address，不串 venue_name
 *   2. VENUE_ADDRESS_OVERRIDE（venue_name substring match，兜底保障舊有資料）
 *   3. venue_name 帶鄉鎮前綴（一般 fallback）
 */
function buildGeoQuery(event: MapEvent): string {
  // 優先 1：DB address 欄位有值 → 直接用，絕不串接 venue_name
  if (event.address?.trim()) return event.address.trim();

  const venue = event.venue_name?.trim() ?? '';

  // 優先 2：前端地址白名單（substring match）
  for (const [kw, addr] of Object.entries(VENUE_ADDRESS_OVERRIDE)) {
    if (venue.includes(kw)) return addr;
  }

  // 優先 3：venue_name + 鄉鎮前綴（一般場館）
  const township = TAITUNG_TOWNSHIPS.find(t => venue.includes(t));
  if (township) return `台東縣${township} ${venue}`;

  return `台東縣 ${venue}`;
}

// ── 型別 ──────────────────────────────────────────────────────────────────────

export interface MapEvent {
  id: string;
  title: string;
  venue_name: string;
  /** AI 擷取的完整地址（比 venue_name 更精確，優先用於 Geocoding） */
  address?: string;
  latitude?: number;
  longitude?: number;
  /** 停留分鐘數（來自 PlannedEvent.stay_duration），用於 full 模式計算 */
  stay_duration?: number;
  end_time?: string;
  /** vibe_tags，用於美食/夜市啟發式規則 */
  vibe_tags?: string[];
}

type RouteMode = 'travel' | 'full';


// ── 強化扇形展開（Spiderfy）───────────────────────────────────────────────────
// 對相同原始座標的 Marker 套用黃金角度偏移；偏移後記錄群組資訊供連線使用。

interface SpiderGroup {
  center: { lat: number; lng: number };
  memberIds: string[];
}

type SpiderfiedEvent = MapEvent & {
  latitude: number;
  longitude: number;
  /** 屬於 Spider 群組時才有；記錄原始中心點與所有成員 ID */
  _spider?: SpiderGroup;
};

function applyCoordJitter(
  events: Array<MapEvent & { latitude: number; longitude: number }>
): { events: SpiderfiedEvent[]; spiderGroups: Map<string, SpiderGroup> } {
  // 第一次掃描：按原始座標分組
  const groupMap = new Map<string, string[]>(); // key → [id, ...]
  for (const e of events) {
    const key = `${e.latitude.toFixed(5)},${e.longitude.toFixed(5)}`;
    const arr = groupMap.get(key) ?? [];
    arr.push(e.id);
    groupMap.set(key, arr);
  }

  // 建立 SpiderGroup 查詢表（僅多於 1 個成員的群組才需要）
  const spiderGroups = new Map<string, SpiderGroup>();
  for (const [key, ids] of groupMap.entries()) {
    if (ids.length < 2) continue;
    const [latStr, lngStr] = key.split(',');
    const center = { lat: parseFloat(latStr), lng: parseFloat(lngStr) };
    ids.forEach(id => spiderGroups.set(id, { center, memberIds: ids }));
  }

  // 第二次掃描：套用偏移
  const countMap = new Map<string, number>();
  const RADIUS = 0.0005; // ~55m，加大後肉眼可明顯區分

  const resultEvents: SpiderfiedEvent[] = events.map(e => {
    const key = `${e.latitude.toFixed(5)},${e.longitude.toFixed(5)}`;
    const idx = countMap.get(key) ?? 0;
    countMap.set(key, idx + 1);

    const spider = spiderGroups.get(e.id);
    if (idx === 0) return { ...e, _spider: spider };

    // 黃金角 137.5°：讓各 Marker 自然散開，不互相重疊
    const angle = (idx * 137.5 * Math.PI) / 180;
    return {
      ...e,
      latitude:  e.latitude  + RADIUS * Math.cos(angle),
      longitude: e.longitude + RADIUS * Math.sin(angle),
      _spider:   spider,
    };
  });

  return { events: resultEvents, spiderGroups };
}

// ── 主元件 ────────────────────────────────────────────────────────────────────

interface ItineraryMapProps {
  events: MapEvent[];
  /** Bug 2：行程清單選中的活動 ID，地圖會自動飛到並開啟 Popup */
  selectedEventId?: string | null;
  /**
   * Directions API 回傳後，將各 leg 實際行駛分鐘數傳給父元件，
   * 供行程卡片衝突分析（calculateItineraryGaps）使用真實車程。
   * 陣列長度 = 活動數 - 1，順序對應行程清單排序。
   */
  onLegDurationsChange?: (durations: number[]) => void;
}

export default function ItineraryMap({ events, selectedEventId, onLegDurationsChange }: ItineraryMapProps) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
  });

  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [directionsError, setDirectionsError] = useState(false);
  const [activeMarker, setActiveMarker] = useState<string | null>(null);
  const isFirstMount = useRef(true);

  // Bug 1：venue_name geocoding 結果快取（組件狀態層）
  // key: event.id, value: { lat, lng }
  const [geocodedCoords, setGeocodedCoords] = useState<Record<string, { lat: number; lng: number }>>({});

  // ── 路線模式切換（travel / full） ─────────────────────────────────────────
  const [routeMode, setRouteMode] = useState<RouteMode>('travel');

  // Bug 1：將 geocoded 座標覆蓋原始儲存座標，確保以 venue_name 為基準
  const eventsWithResolvedCoords = useMemo(
    () => events.map(e => ({
      ...e,
      latitude:  geocodedCoords[e.id]?.lat ?? e.latitude,
      longitude: geocodedCoords[e.id]?.lng ?? e.longitude,
    })),
    [events, geocodedCoords]
  );

  // 過濾出有座標的活動，再套用強化扇形展開（Jitter + Spider 群組資訊）
  const { validEvents, spiderGroups } = useMemo(() => {
    const withCoords = eventsWithResolvedCoords.filter(
      (e): e is MapEvent & { latitude: number; longitude: number } =>
        typeof e.latitude === 'number' && typeof e.longitude === 'number' &&
        e.latitude  >= TAITUNG_BBOX.south && e.latitude  <= TAITUNG_BBOX.north &&
        e.longitude >= TAITUNG_BBOX.west  && e.longitude <= TAITUNG_BBOX.east
    );
    const { events: spiderfied, spiderGroups } = applyCoordJitter(withCoords);
    return { validEvents: spiderfied, spiderGroups };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsWithResolvedCoords]);

  /** 穩定字串 key：只要活動 ID 清單沒變，就不觸發 Directions effect 重算 */
  const eventsKey = validEvents.map(e => e.id).join(',');

  // ── 精準 Geocoding：動態前綴 + 台東縣空間限制 ─────────────────────────────
  // 只在 Maps JS API 載入完成後執行，並以 geocodeCache 避免重複查詢
  useEffect(() => {
    if (!isLoaded) return;
    const geocoder = new google.maps.Geocoder();

    // 台東縣 LatLngBounds，作為 Geocoder 空間偏置（bias）
    const taitungBounds = new google.maps.LatLngBounds(
      { lat: TAITUNG_BBOX.south, lng: TAITUNG_BBOX.west },
      { lat: TAITUNG_BBOX.north, lng: TAITUNG_BBOX.east }
    );

    events.forEach(event => {
      if (!event.venue_name) return;

      // 動態組合查詢字串（address 優先；無 address 時檢查地址白名單；最後帶鄉鎮前綴）
      const query = buildGeoQuery(event);

      // 快取鍵 = 實際查詢字串（確保相同查詢不重複呼叫 API，且不會因 address/venue_name
      // 不一致導致快取錯位）
      const cacheKey = query;

      // 已有快取結果（含失敗的 null）→ 直接套用
      if (geocodeCache.has(cacheKey)) {
        const cached = geocodeCache.get(cacheKey);
        if (cached) {
          setGeocodedCoords(prev =>
            prev[event.id]?.lat === cached.lat ? prev : { ...prev, [event.id]: cached }
          );
        }
        return;
      }

      // 判斷該場館是否屬於「市中心文化場館」，需套用距離硬門檻
      const venueName = event.venue_name?.trim() ?? '';
      const isCityCultural = CITY_CULTURAL_KEYWORDS.some(kw => venueName.includes(kw));

      /** 驗證並套用一組 Geocoding 結果；回傳 true 表示採用，false 表示需 fallback */
      const applyResults = (
        results: google.maps.GeocoderResult[] | null,
        usedQuery: string,
        isFallback: boolean
      ): boolean => {
        const best = selectBestGeoResult(results ?? []);
        if (!best) return false;

        const loc2d = best.geometry.location;
        const lat = loc2d.lat();
        const lng = loc2d.lng();

        // 1. bbox 硬邊界驗證
        if (
          lat < TAITUNG_BBOX.south || lat > TAITUNG_BBOX.north ||
          lng < TAITUNG_BBOX.west  || lng > TAITUNG_BBOX.east
        ) {
          console.warn(
            `[ItineraryMap] Geocoding 超出台東縣範圍，丟棄：`,
            usedQuery, `→ (${lat.toFixed(5)}, ${lng.toFixed(5)})`
          );
          return false;
        }

        // 2. 市中心文化場館距離硬門檻（5 km）
        if (isCityCultural && !isFallback) {
          const distM = haversineMeters({ lat, lng }, TAITUNG_CITY_HALL);
          if (distM > 5000) {
            console.warn(
              `[ItineraryMap] 市中心文化場館距縣政府 ${(distM / 1000).toFixed(1)} km，疑似錯誤，觸發 fallback：`,
              usedQuery, `→ (${lat.toFixed(5)}, ${lng.toFixed(5)})`
            );
            return false; // 觸發 fallback
          }
        }

        const loc = { lat, lng };
        geocodeCache.set(cacheKey, loc);
        setGeocodedCoords(prev => ({ ...prev, [event.id]: loc }));
        return true;
      };

      geocoder.geocode(
        {
          address: query,
          region: 'TW',
          // 空間邊界偏置：讓 Google 優先在台東縣範圍內搜尋（bias，非 hard filter）
          bounds: taitungBounds,
          // 國家限制：強制結果在台灣境內（消除跨國同名地點誤差）
          componentRestrictions: { country: 'TW' },
        },
        (results, status) => {
          if (status === google.maps.GeocoderStatus.OK && results?.length) {
            const accepted = applyResults(results, query, false);
            if (!accepted) {
              // Fallback：強制用「台東縣台東市 + venue_name」縮小搜尋範圍
              const fallbackQuery = `台東縣台東市 ${venueName}`;
              console.info('[ItineraryMap] 啟動 fallback 查詢：', fallbackQuery);
              geocoder.geocode(
                {
                  address: fallbackQuery,
                  region: 'TW',
                  bounds: taitungBounds,
                  componentRestrictions: { country: 'TW' },
                },
                (fbResults, fbStatus) => {
                  if (fbStatus === google.maps.GeocoderStatus.OK && fbResults?.length) {
                    applyResults(fbResults, fallbackQuery, true);
                  } else {
                    geocodeCache.set(cacheKey, null);
                    console.warn('[ItineraryMap] Fallback Geocoding 也失敗：', fallbackQuery, fbStatus);
                  }
                }
              );
            }
          } else {
            geocodeCache.set(cacheKey, null);
            console.warn('[ItineraryMap] Geocoding failed for:', query, status);
          }
        }
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, events]);

  // ── Bug 2：selectedEventId 變更時自動高亮並飛到對應 Marker ────────────────
  useEffect(() => {
    if (!selectedEventId) { setActiveMarker(null); return; }
    if (!mapInstance) return;
    setActiveMarker(selectedEventId);
    const target = validEvents.find(e => e.id === selectedEventId);
    if (target) {
      mapInstance.panTo({ lat: target.latitude, lng: target.longitude });
      mapInstance.setZoom(15);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, mapInstance]);


  // ── Auto-centering：切換日期 Tab 時平滑位移至當天第一個活動 ─────────────────
  const firstId  = validEvents[0]?.id        ?? null;
  const firstLat = validEvents[0]?.latitude  ?? null;
  const firstLng = validEvents[0]?.longitude ?? null;

  useEffect(() => {
    if (!mapInstance) return;
    const target = (firstLat && firstLng) ? { lat: firstLat, lng: firstLng } : TAITUNG_CENTER;
    const zoom   = firstLat ? 13 : 12;

    if (isFirstMount.current) {
      mapInstance.setCenter(target);
      mapInstance.setZoom(zoom);
      isFirstMount.current = false;
    } else {
      mapInstance.panTo(target);
      mapInstance.setZoom(zoom);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, firstLat, firstLng, mapInstance]);

  // ── Directions API：名稱優先 → 座標降級，路線吸附到正式出入口 ───────────────
  useEffect(() => {
    if (!isLoaded || validEvents.length < 2) {
      setDirections(null);
      setDirectionsError(false);
      return;
    }

    const service = new google.maps.DirectionsService();

    /** 成功時更新地圖路線，並將各 leg 行駛分鐘數回傳父元件 */
    const applyResult = (result: google.maps.DirectionsResult) => {
      setDirections(result);
      setDirectionsError(false);
      const legMins = result.routes[0]?.legs.map(
        l => Math.max(1, Math.ceil((l.duration?.value ?? 0) / 60))
      ) ?? [];
      onLegDurationsChange?.(legMins);
    };

    // ── 第二層（降級）：座標精確，但路線入口吸附較差 ────────────────────────
    const requestByCoords = () => {
      service.route(
        {
          origin:      { lat: validEvents[0].latitude,                      lng: validEvents[0].longitude },
          destination: { lat: validEvents[validEvents.length - 1].latitude, lng: validEvents[validEvents.length - 1].longitude },
          waypoints:   validEvents.slice(1, -1).map(e => ({
            location: { lat: e.latitude, lng: e.longitude },
            stopover: true,
          })),
          travelMode:        google.maps.TravelMode.DRIVING,
          optimizeWaypoints: false,
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            applyResult(result);
          } else {
            console.warn('[ItineraryMap] 座標路線也失敗：', status, '— 退回直線連線');
            setDirections(null);
            setDirectionsError(true);
          }
        }
      );
    };

    // ── 第一層（優先）：地點名稱 → Google 自動吸附正式出入口 ──────────────────
    service.route(
      {
        origin:      buildGeoQuery(validEvents[0]),
        destination: buildGeoQuery(validEvents[validEvents.length - 1]),
        waypoints:   validEvents.slice(1, -1).map(e => ({
          location: buildGeoQuery(e),
          stopover: true,
        })),
        travelMode:        google.maps.TravelMode.DRIVING,
        optimizeWaypoints: false,
        region:            'TW',
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK && result) {
          applyResult(result);
        } else {
          console.info('[ItineraryMap] 名稱路線失敗，降級至座標模式：', status);
          requestByCoords();
        }
      }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsKey, isLoaded]);

  const onMapLoad = useCallback((map: google.maps.Map) => {
    setMapInstance(map);
  }, []);

  const polylinePath = validEvents.map(e => ({ lat: e.latitude, lng: e.longitude }));

  // ── 路線統計（所有模式的計算集中在此） ────────────────────────────────────
  const routeStats = useMemo(() => {
    const legs = directions?.routes?.[0]?.legs ?? [];

    // 純移動時間
    const travelSec   = legs.reduce((s, l) => s + (l.duration?.value ?? 0), 0);
    const totalDistM  = legs.reduce((s, l) => s + (l.distance?.value ?? 0), 0);

    // 各站停留時間（分鐘→秒）
    const staySec = validEvents.reduce((s, e) => s + (e.stay_duration ?? 60) * 60, 0);

    // 全部行程 = (移動 + 停留) × 1.15 風險緩衝
    const fullSec = Math.round((travelSec + staySec) * 1.15);

    return { legs, travelSec, totalDistM, staySec, fullSec };
  }, [directions, validEvents]);

  // ── 載入中 / 失敗 ──────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-50 rounded-3xl text-red-500 text-sm font-bold">
        地圖載入失敗，請確認 API Key 設定
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="w-full h-full bg-gray-50 flex items-center justify-center text-gray-400 text-sm font-bold animate-pulse rounded-3xl">
        地圖載入中...
      </div>
    );
  }

  // ── 選取中的 Marker（InfoWindow 資料） ────────────────────────────────────────
  const activeEvent = activeMarker ? validEvents.find(e => e.id === activeMarker) ?? null : null;
  const activeIndex = activeEvent ? validEvents.indexOf(activeEvent) : -1;

  const { legs: routeLegs, travelSec, totalDistM, fullSec } = routeStats;

  // ── 面板總覽欄位（依模式） ─────────────────────────────────────────────────
  const summaryChips: { label: string; value: string }[] = (() => {
    const distChip = { label: '總里程', value: fmtDistance(totalDistM) };
    if (routeMode === 'full') {
      return [distChip, { label: '總耗時 (含緩衝)', value: fmtDuration(fullSec) }];
    }
    return [distChip, { label: '開車時間', value: fmtDuration(travelSec) }];
  })();

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div className="w-full h-full flex flex-col">

      {/* ── 地圖本體（此區塊不動）──────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <GoogleMap
          mapContainerClassName="w-full h-full rounded-3xl"
          center={TAITUNG_CENTER}
          zoom={12}
          options={{
            styles: SILVER_STYLE,
            zoomControl: true,
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: false,
            clickableIcons: false,
            gestureHandling: 'cooperative',
          }}
          onLoad={onMapLoad}
          onClick={() => setActiveMarker(null)}
        >
          {directions && (
            <DirectionsRenderer
              directions={directions}
              options={{
                suppressMarkers: true,
                polylineOptions: { strokeColor: '#2563eb', strokeWeight: 4, strokeOpacity: 0.75 },
              }}
            />
          )}

          {directionsError && polylinePath.length > 1 && (
            <Polyline
              path={polylinePath}
              options={{ strokeColor: '#94a3b8', strokeWeight: 2, strokeOpacity: 0.6, geodesic: true } as google.maps.PolylineOptions}
            />
          )}

          {/* ── Spider 連線：選中同一原始座標群組的任一 Marker 時顯示 ────────── */}
          {(() => {
            if (!activeMarker) return null;
            const activeSpider = spiderGroups.get(activeMarker);
            if (!activeSpider) return null;
            // 對群組內每個成員從原始中心點拉一條淡灰虛線
            return activeSpider.memberIds.map(memberId => {
              const member = validEvents.find(e => e.id === memberId);
              if (!member) return null;
              return (
                <Polyline
                  key={`spider-leg-${memberId}`}
                  path={[
                    activeSpider.center,
                    { lat: member.latitude, lng: member.longitude },
                  ]}
                  options={{
                    strokeColor: '#64748b',
                    strokeWeight: 1.5,
                    strokeOpacity: 0.55,
                    geodesic: false,
                    icons: [{
                      icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
                      offset: '0',
                      repeat: '10px',
                    }],
                  } as google.maps.PolylineOptions}
                />
              );
            });
          })()}

          {/* ── Spider 中心點 Marker（群組選中時顯示原始位置小圓點）────────────── */}
          {(() => {
            if (!activeMarker) return null;
            const activeSpider = spiderGroups.get(activeMarker);
            if (!activeSpider) return null;
            const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#64748b" stroke="white" stroke-width="1.5"/></svg>`;
            return (
              <Marker
                key="spider-center"
                position={activeSpider.center}
                clickable={false}
                icon={{
                  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dotSvg)}`,
                  scaledSize: new google.maps.Size(10, 10),
                  anchor: new google.maps.Point(5, 5),
                }}
              />
            );
          })()}

          <MarkerClusterer options={{ imagePath: 'https://developers.google.com/maps/documentation/javascript/examples/markerclusterer/m' }}>
            {(clusterer) => (
              <>
                {validEvents.map((event, index) => (
                  <Marker
                    key={event.id}
                    position={{ lat: event.latitude, lng: event.longitude }}
                    clusterer={clusterer}
                    title={event.title}
                    icon={{
                      url: makeNumberedIcon(index + 1),
                      scaledSize: new google.maps.Size(32, 40),
                      anchor: new google.maps.Point(16, 40),
                    }}
                    onClick={() => setActiveMarker(prev => (prev === event.id ? null : event.id))}
                  />
                ))}
              </>
            )}
          </MarkerClusterer>

          {activeEvent && (
            <InfoWindow
              position={{ lat: activeEvent.latitude, lng: activeEvent.longitude }}
              onCloseClick={() => setActiveMarker(null)}
              options={{ pixelOffset: new google.maps.Size(0, -42) }}
            >
              <div style={{ maxWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#1e3a5f', marginBottom: 4 }}>
                  {activeIndex + 1}. {activeEvent.title}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{activeEvent.venue_name}</div>
                {/* Spider 群組提示 */}
                {spiderGroups.has(activeEvent.id) && (
                  <div style={{ marginTop: 6, fontSize: 10, color: '#94a3b8', borderTop: '1px solid #f1f5f9', paddingTop: 4 }}>
                    同場館共 {spiderGroups.get(activeEvent.id)!.memberIds.length} 個活動
                  </div>
                )}
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </div>

      {/* ── 路線摘要面板（Directions OK，且有 2+ 個活動） ────────────────────── */}
      {routeLegs.length > 0 && (
        <div className="mt-2 bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

          {/* 模式切換 Toggle */}
          <div className="flex items-center gap-1 px-3 pt-3 pb-2">
            {([
              { key: 'travel', label: '移動時間' },
              { key: 'full',   label: '全部行程' },
            ] as { key: RouteMode; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setRouteMode(key)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  routeMode === key
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 總覽列 */}
          <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 border-y border-blue-100">
            {summaryChips.map(chip => (
              <span key={chip.label} className="flex items-center gap-1.5 font-bold text-sm text-blue-700">
                {chip.label}：{chip.value}
              </span>
            ))}
            {routeMode === 'travel' && (
              <span className="ml-auto text-xs text-blue-400">不含停留</span>
            )}
            {routeMode === 'full' && (
              <span className="ml-auto text-xs text-blue-400">含 15% 緩衝</span>
            )}
          </div>

          {/* 分段明細 */}
          <div className="divide-y divide-gray-50">
            {routeLegs.map((leg, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2 text-xs text-gray-600">
                {/* 序號 */}
                <span className="flex items-center gap-1 shrink-0 font-bold text-gray-800">
                  <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
                  <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">{i + 2}</span>
                </span>

                {/* 起點名稱 */}
                <span className="truncate flex-1 text-gray-500">{validEvents[i]?.venue_name ?? leg.start_address}</span>

                {/* 模式對應欄位 */}
                {routeMode === 'travel' && (
                  <>
                    <span className="shrink-0 text-gray-400">{fmtDistance(leg.distance?.value ?? 0)}</span>
                    <span className="shrink-0 font-bold text-blue-600">{fmtDuration(leg.duration?.value ?? 0)}</span>
                  </>
                )}

                {routeMode === 'full' && (
                  <>
                    <span className="shrink-0 text-gray-400 flex gap-1">
                      <span title="開車">🚗 {fmtDuration(leg.duration?.value ?? 0)}</span>
                    </span>
                    <span className="shrink-0 font-medium text-emerald-600" title="停留">
                      🏛 {fmtDuration((validEvents[i]?.stay_duration ?? 60) * 60)}
                    </span>
                  </>
                )}

              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Fallback 提示（Directions 失敗） ─────────────────────────────────── */}
      {directionsError && polylinePath.length > 1 && (
        <div className="mt-2 flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-100 rounded-2xl text-amber-700 text-xs font-medium">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          道路路線暫時無法取得，目前顯示直線路徑
        </div>
      )}

    </div>
  );
}
