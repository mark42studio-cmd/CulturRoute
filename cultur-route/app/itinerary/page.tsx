'use client';

import { createClient } from '@supabase/supabase-js';
import { useItineraryStore } from '@/store/useItineraryStore';
import Link from 'next/link';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
import {
  MapPin, Calendar, ArrowLeft, Trash2, Map as MapIcon,
  GripVertical, Ticket, AlertTriangle, FileText, X, Clock, Car, BedDouble,
  ExternalLink, PackageOpen, Camera, CalendarPlus, Loader2, Ban,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, Fragment, useRef, useState } from 'react';
import { downloadICS, downloadReportImage } from '@/lib/itinerary-export';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import type { PlannedEvent } from '@/types';

const MapComponent = dynamic(
  () => import('@/components/ItineraryMap'),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-gray-500 font-bold bg-gray-100 rounded-3xl">地圖載入中...</div> }
);

// ── 常數 ──────────────────────────────────────────────────────────────────────

const STAY_LABELS: Record<number, string> = {
  30: '30 分鐘', 60: '1 小時', 90: '1.5 小時',
  120: '2 小時', 180: '3 小時', 240: '半天',
};

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 展覽 TimePicker 選項：09:00–17:00，排除 12:00–13:00（午休） */
const EXHIBITION_TIME_OPTIONS = [
  '09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00',
];

const FALLBACK_URLS = {
  rental:        'https://www.klook.com/zh-TW/search/?query=台東+租機車',
  ticket:        'https://www.klook.com/zh-TW/search/?query=台東+門票優惠',
  accommodation: 'https://www.booking.com/searchresults/zh-tw.html?ss=台東市',
};

// ── 工具函式 ──────────────────────────────────────────────────────────────────

const getLocalYYYYMMDD = (dateStr: string | Date): string => {
  const d = new Date(dateStr);
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Task 2：標籤格式 → MM/DD (週X) 第N天
 * 使用 new Date(year, month-1, day) 避免 UTC 時區偏移問題
 */
const formatTabLabel = (dateStr: string, index: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${mm}/${dd} (${WEEKDAYS[date.getDay()]}) 第${index + 1}天`;
};

/**
 * Task 3：行程卡片日期嚴格對齊 assigned_date
 * 格式：YYYY/MM/DD (第N天)
 */
const formatAssignedDate = (assignedDate: string, tripDates: string[]): string => {
  const idx = tripDates.indexOf(assignedDate);
  const dayNum = idx >= 0 ? idx + 1 : '?';
  return `${assignedDate.replace(/-/g, '/')} (第${dayNum}天)`;
};

/**
 * 展覽日期區間標籤：「3月30日 – 6月28日」
 * 用於行程卡片顯示展覽的彈性參訪範圍。
 */
const formatExhibitionRange = (startISO: string, endDate: string): string => {
  const [, sm, sd] = startISO.substring(0, 10).split('-').map(Number);
  const [, em, ed] = endDate.split('-').map(Number);
  return `${sm}月${sd}日 – ${em}月${ed}日`;
};

/**
 * 硬排警告：判斷 assigned_date 是否落在活動的實際演出日期範圍外
 * 使用 YYYY-MM-DD 字串比對，規避時區問題
 */
const getIsHardScheduled = (event: PlannedEvent): boolean => {
  const assigned = event.assigned_date;
  const eStart   = event.start_time.substring(0, 10);
  // 優先用 end_date（跨日展覽），其次取 end_time 日期，最後退回 start 當天
  const eEnd     = event.end_date
    ?? (event.end_time ? event.end_time.substring(0, 10) : eStart);
  return assigned < eStart || assigned > eEnd;
};

/**
 * 動態日期範圍：合併旅程設定日期 + 所有已加入活動的 assigned_date，
 * 取 min/max 後生成連續日期列（上限 60 天），確保 Tab 永遠不會遺漏任何活動。
 */
const buildTripDates = (start: string, end: string, events: PlannedEvent[]): string[] => {
  const seeds: string[] = [...events.map(e => e.assigned_date).filter(Boolean)];
  if (start) seeds.push(start);
  if (end)   seeds.push(end);
  if (seeds.length === 0) return [getLocalYYYYMMDD(new Date())];

  const minDate = seeds.reduce((a, b) => (a < b ? a : b));
  const maxDate = seeds.reduce((a, b) => (a > b ? a : b));

  const [sy, sm, sd] = minDate.split('-').map(Number);
  const [ey, em, ed] = maxDate.split('-').map(Number);
  let curr = new Date(sy, sm - 1, sd);
  const endDate = new Date(ey, em - 1, ed);

  const dates: string[] = [];
  let count = 0;
  while (curr <= endDate && count < 60) {
    dates.push(getLocalYYYYMMDD(curr));
    curr.setDate(curr.getDate() + 1);
    count++;
  }
  return dates.length > 0 ? dates : [getLocalYYYYMMDD(new Date())];
};

/**
 * 判斷活動是否為「靜態展覽」（與 EventBrowser.tsx 邏輯一致）：
 * - vibe_tags 含「靜態展覽」（AI 標記，最可靠）
 * - 標題含「個展」「聯展」「特展」（補充辨識）
 */
const isExhibition = (event: PlannedEvent): boolean => {
  if (event.vibe_tags?.includes('靜態展覽')) return true;
  return /個展|聯展|特展/.test(event.title);
};

/**
 * ISO 時間字串 → 台灣時區 HH:MM（24h）
 *
 * Supabase 的 timestamptz 欄位統一以 UTC 回傳（例如台灣 10:00 存成 02:00+00:00）。
 * 直接做 substring(11,16) 只會拿到 UTC 時間，必須透過 Date + Intl 轉換。
 * 使用 en-GB locale 確保跨瀏覽器皆輸出 "HH:MM" 格式（無 AM/PM）。
 */
const toTaipeiHHMM = (iso: string): string => {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '00:00';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(date);
  const h = parts.find(p => p.type === 'hour')?.value   ?? '00';
  const m = parts.find(p => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
};

/**
 * 取活動的有效排序時間（HH:MM，台灣時區）：
 * 1. visit_time（使用者自訂展覽前往時間）
 * 2. start_time 轉換台灣時區後的時間部分
 * 3. 無法取得時 fallback '00:00'
 */
const getEffectiveSortTime = (event: PlannedEvent): string => {
  if (event.visit_time) return event.visit_time;
  if (event.start_time) return toTaipeiHHMM(event.start_time);
  return '00:00';
};

// ── 行程時間智慧系統 ──────────────────────────────────────────────────────────

/**
 * 取活動有效開始 HH:MM（台灣時區）；
 * 轉換後為 00:00 或來源為空時回傳 null（不參與衝突計算）。
 */
const getStartHHMM = (event: PlannedEvent): string | null => {
  if (event.visit_time) return event.visit_time;
  if (!event.start_time) return null;
  const t = toTaipeiHHMM(event.start_time);
  if (t === '00:00') return null;
  return t;
};

/** HH:MM → 分鐘數 */
const hhmmToMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** 分鐘數 → HH:MM（不跨日，超過 23:59 截斷） */
const minToHHMM = (min: number): string => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * 估算兩地移動時間（分鐘）
 * 以直線距離 / 30 km/h（台東市區含停車），最少 10 分鐘。
 * 1° lat ≈ 111 km；1° lon ≈ 80 km（北緯 23°）
 */
const mockTravelTime = (a: PlannedEvent, b: PlannedEvent): number => {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return 20;
  const dLat = (b.latitude  - a.latitude)  * 111;
  const dLon = (b.longitude - a.longitude) * 80;
  const distKm = Math.sqrt(dLat ** 2 + dLon ** 2);
  return Math.max(10, Math.round((distKm / 30) * 60));
};

interface GapWarning {
  afterIndex: number;     // 在第 afterIndex 張卡片之後顯示警告
  conflictMinutes: number;
  travelMinutes: number;
}

/**
 * 計算同一天行程中的時間衝突清單。
 *
 * @param items          當天已排序的活動列表
 * @param realTravelMins Directions API 回傳的各 leg 實際車程（分鐘），
 *                       長度 = items.length - 1。API 尚未回應時傳 []，
 *                       此時自動降級使用 mockTravelTime 估算。
 */
const calculateItineraryGaps = (items: PlannedEvent[], realTravelMins: number[] = []): GapWarning[] => {
  const warnings: GapWarning[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const aStart = getStartHHMM(a);
    const bStart = getStartHHMM(b);
    if (!aStart || !bStart) continue;
    const aEndMin   = hhmmToMin(aStart) + (a.stay_duration ?? 60);
    const bStartMin = hhmmToMin(bStart);
    // 優先使用真實車程（Directions API leg）；API 尚未回應時降級至直線估算
    const travel = (realTravelMins[i] != null) ? realTravelMins[i] : mockTravelTime(a, b);
    const slack  = bStartMin - (aEndMin + travel);
    if (slack < 0) {
      warnings.push({ afterIndex: i, conflictMinutes: -slack, travelMinutes: travel });
    }
  }
  return warnings;
};

// ── 主元件 ────────────────────────────────────────────────────────────────────

export default function ItineraryPage() {
  const {
    plannedEvents, removeEvent, reorderEvents,
    updateEventDate, updateVisitTime, tripStartDate, tripEndDate,
  } = useItineraryStore();

  const [isMounted,        setIsMounted]        = useState(false);
  const [activeDate,       setActiveDate]       = useState<string>('');
  const [showReport,       setShowReport]       = useState(false);
  const [isCapturing,      setIsCapturing]      = useState(false);
  // Bug 2：行程清單點擊活動時，通知地圖高亮對應 Marker
  const [selectedEventId,  setSelectedEventId]  = useState<string | null>(null);
  // Directions API 各 leg 實際車程（分鐘），由 ItineraryMap 回傳，用於精準衝突分析
  const [legDurations,     setLegDurations]     = useState<number[]>([]);
  const [isLiked,           setIsLiked]           = useState(false);
  const [likeCount,         setLikeCount]         = useState<number>(0);
  const [feedbackText,      setFeedbackText]      = useState('');
  const [feedbackSent,      setFeedbackSent]      = useState(false);
  const [isFeedbackLoading, setIsFeedbackLoading] = useState(false);
  const [feedbackError,     setFeedbackError]     = useState(false);
  const reportCardRef  = useRef<HTMLDivElement>(null);
  const postcardRef    = useRef<HTMLDivElement>(null);
  // Toast 通知（取代舊的 warningModal）
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([]);
  const showToast = useCallback((message: string) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  // Task 2：active tab 自動捲入視野
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeDate]);

  useEffect(() => { setIsMounted(true); }, []);

  // 掛載時從 app_stats 讀取累計總讚數
  useEffect(() => {
    supabase
      .from('app_stats')
      .select('total_likes')
      .eq('id', 1)
      .single()
      .then(({ data }) => { if (data?.total_likes != null) setLikeCount(data.total_likes); });
  }, []);

  // ── 動態日期區間：合併旅程設定 + 所有活動日期，自動延伸 Tabs ─────────────────
  const sortedDates = buildTripDates(tripStartDate, tripEndDate, plannedEvents);
  const actualActiveDate = sortedDates.includes(activeDate) ? activeDate : sortedDates[0];

  // 切換日期時清空舊的車程資料，避免暫時顯示不正確的衝突警告
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLegDurations([]); }, [actualActiveDate]);

  // ── 容錯：偵測 assigned_date 不在 sortedDates 內的活動（動態範圍下理論上不存在）
  const unassignedEvents: PlannedEvent[] = plannedEvents.filter(
    e => !sortedDates.includes(e.assigned_date)
  );

  // ── 空狀態引導 ──────────────────────────────────────────────────────────────
  const datesWithEvents  = sortedDates.filter(d => plannedEvents.some(e => e.assigned_date === d));
  const nearestDateWithEvents = datesWithEvents.length > 0
    ? datesWithEvents.reduce((nearest, d) => {
        const dn = Math.abs(new Date(nearest).getTime() - new Date(actualActiveDate).getTime());
        const dd = Math.abs(new Date(d).getTime()       - new Date(actualActiveDate).getTime());
        return dd < dn ? d : nearest;
      })
    : null;

  // ── 事件處理 ────────────────────────────────────────────────────────────────

  /**
   * 日期變更防呆（移至選單 / 未來跨日 DnD 共用此函式）
   *
   * 規則：
   *  1. 同日 → 無操作（應走 reorderEvents）
   *  2. 單次性活動（非展覽）→ 硬阻擋，Toast 警告
   *  3. 展覽 → 目標日期必須落在展期 [start_date, end_date] 內，否則 Toast 警告
   */
  const handleDateChange = (event: PlannedEvent, newDateStr: string) => {
    if (newDateStr === event.assigned_date) return;

    const exhibition = isExhibition(event);

    if (!exhibition) {
      showToast('此為單次性活動，無法更改日期');
      return;
    }

    // 展覽：驗證目標日期落在展期範圍內
    const eventStartStr = event.start_time.substring(0, 10);
    const eventEndStr   = event.end_date
      ?? (event.end_time ? event.end_time.substring(0, 10) : eventStartStr);

    if (newDateStr < eventStartStr || newDateStr > eventEndStr) {
      showToast('該日期不在展覽期間內');
      return;
    }

    updateEventDate(event.id, newDateStr);
  };

  const handleDownloadImage = () => {
    if (!postcardRef.current) return;
    // 防呆計時器：最多 10 秒後強制恢復按鈕，無論截圖成功或失敗
    const safetyTimer = setTimeout(() => setIsCapturing(false), 10_000);
    downloadReportImage(
      postcardRef.current,
      () => setIsCapturing(true),
      () => { clearTimeout(safetyTimer); setIsCapturing(false); },
      3,
    );
  };

  const handleExportICS = () => downloadICS(plannedEvents);

  // 按讚：Optimistic UI → 先更新本地，再呼叫 increment_like() RPC；失敗時回滾
  const handleLike = async () => {
    if (isLiked) return;
    setIsLiked(true);
    setLikeCount(prev => prev + 1);
    const { error } = await supabase.rpc('increment_like');
    if (error) {
      setIsLiked(false);
      setLikeCount(prev => prev - 1);
    }
  };

  const handleFeedbackSubmit = async () => {
    if (!feedbackText.trim() || isFeedbackLoading) return;
    setIsFeedbackLoading(true);
    setFeedbackError(false);
    const { error } = await supabase.from('feedbacks').insert({ content: feedbackText.trim() });
    setIsFeedbackLoading(false);
    if (error) {
      setFeedbackError(true);
    } else {
      setFeedbackSent(true);
      setFeedbackText('');
    }
  };

  // 按有效時間升序排列：visit_time（使用者自訂）> start_time 時間部分
  const currentDayEvents = plannedEvents
    .filter(e => e.assigned_date === actualActiveDate)
    .sort((a, b) => getEffectiveSortTime(a).localeCompare(getEffectiveSortTime(b)));

  // 衝突警告（derived，每次 render 重算）
  // legDurations：由 ItineraryMap Directions API 回傳的真實車程；未就緒時降級至估算
  const gapWarnings = calculateItineraryGaps(currentDayEvents, legDurations);
  const conflictSet = new Set(gapWarnings.map(w => w.afterIndex));

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const srcIdx = result.source.index;
    const dstIdx = result.destination.index;
    if (srcIdx === dstIdx) return;

    // ── 時間槽自動繼承（Time-Slot Auto-Reassignment） ───────────────────────
    // currentDayEvents 已按有效時間升序排列，代表「坑位」的固定順序。
    // 拖曳只是讓活動重新填入坑位，坑位本身的時間不動。
    //
    // 步驟：
    //  1. 萃取當前坑位時間列表（已排序）
    //  2. 對事件陣列執行元素換位
    //  3. 依序將坑位時間重新賦值給換位後的事件
    //  → 下次 render getEffectiveSortTime 自動重排，視覺順序正確

    const timeSlots = currentDayEvents.map(e => getEffectiveSortTime(e));
    // timeSlots 已是升序（currentDayEvents 排序保證），再 sort 確保穩定
    timeSlots.sort();

    const reordered = [...currentDayEvents];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(dstIdx, 0, moved);

    reordered.forEach((event, i) => {
      // 只有時間確實改變時才寫入，避免多餘 state update
      if (timeSlots[i] !== getEffectiveSortTime(event)) {
        updateVisitTime(event.id, timeSlots[i]);
      }
    });
    // 不呼叫 reorderEvents：store 索引與 sorted view 索引不同步；
    // 改由 visit_time 的重新賦值驅動下次 render 的排序結果。
  };

  // 分潤彙總（取第一個非 null URL）
  const aggRental = plannedEvents.find(e => e.affiliate_links?.rental?.url)?.affiliate_links?.rental
                 ?? { label: '租車/租機車', url: null };
  const aggTicket = plannedEvents.find(e => e.affiliate_links?.ticket?.url)?.affiliate_links?.ticket
                 ?? { label: '售票連結', url: null };
  const aggAccommodation = plannedEvents.find(e => e.affiliate_links?.accommodation?.url)?.affiliate_links?.accommodation
                        ?? { label: '周邊住宿', url: null };

  if (!isMounted) return null;

  return (
    <main className="min-h-screen bg-[#f8f6f0] relative">

      {/* ── Toast 通知（日期變更防呆） ────────────────────────────────────────── */}
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none w-full max-w-xs px-4">
        {toasts.map(t => (
          <div
            key={t.id}
            className="flex items-center gap-2.5 bg-red-600 text-white px-4 py-3 rounded-2xl shadow-2xl text-sm font-bold w-full"
          >
            <Ban size={15} className="shrink-0" />
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* ── 完整行程報告 Modal ─────────────────────────────────────────────── */}
      {showReport && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8">
            {/* ↓ ref 掛在此 div，截圖範圍 = 標題列 + 內容，不含 Footer 按鈕 */}
            <div ref={reportCardRef}>
            <div className="flex items-center justify-between p-6 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10">
              <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <FileText size={20} className="text-blue-600" />
                完整行程報告
              </h2>
              <button onClick={() => setShowReport(false)} className="p-2 text-gray-400 hover:bg-gray-100 rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {plannedEvents.length === 0 ? (
                <p className="text-center text-gray-400 py-12">行程清單為空，請先從首頁加入活動。</p>
              ) : (
                sortedDates.map((date, dayIndex) => {
                  const dayEvents = plannedEvents
                    .filter(e => e.assigned_date === date)
                    .sort((a, b) => getEffectiveSortTime(a).localeCompare(getEffectiveSortTime(b)));
                  return (
                    <div key={date}>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center font-bold text-sm shrink-0">
                          {dayIndex + 1}
                        </div>
                        <h3 className="font-bold text-gray-800">{formatTabLabel(date, dayIndex)}</h3>
                      </div>
                      {dayEvents.length === 0 ? (
                        <p className="text-gray-400 text-sm pl-11">— 這天尚無安排</p>
                      ) : (
                        <div className="ml-3.5 pl-8 border-l-2 border-gray-100 space-y-3">
                          {dayEvents.map(event => (
                            <div key={event.id} className="relative -ml-px pl-5">
                              <div className="absolute -left-1.5 top-3.5 w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow-sm" />
                              <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                                <h4 className="font-bold text-gray-800 text-sm mb-2">{event.title}</h4>
                                <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                                  <span className="flex items-center gap-1.5"><MapPin size={11} className="text-blue-500" />{event.venue_name}</span>
                                  <span className="flex items-center gap-1.5"><Clock size={11} className="text-green-500" />預計停留 {STAY_LABELS[event.stay_duration ?? 90] ?? '1.5 小時'}</span>
                                  {event.ticket_url && (
                                    <a href={event.ticket_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-amber-600 font-bold hover:underline">
                                      <Ticket size={11} /> 購票
                                    </a>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* 旅遊資源推薦 */}
              <div className="border-t-2 border-dashed border-gray-100 pt-6">
                <h3 className="font-bold text-gray-700 mb-1 flex items-center gap-2">
                  <Car size={16} className="text-blue-600" />旅遊資源推薦
                </h3>
                <p className="text-xs text-gray-400 mb-4 pl-6">點擊連結將在新分頁開啟，協助您提前預訂交通與住宿</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <a href={aggRental.url ?? FALLBACK_URLS.rental} target="_blank" rel="noopener noreferrer"
                     className="group flex items-center gap-3 bg-sky-50 hover:bg-sky-100 active:bg-sky-200 text-sky-700 px-4 py-3.5 rounded-xl font-bold text-sm transition-colors border border-sky-100 shadow-sm hover:shadow-md">
                    <Car size={17} className="shrink-0" />
                    <span className="flex-1 leading-tight">🚗 前往 Klook<br /><span className="font-normal text-xs text-sky-500">預約台東租車</span></span>
                    <ExternalLink size={13} className="shrink-0 text-sky-400 group-hover:text-sky-600 transition-colors" />
                  </a>
                  <a href={aggTicket.url ?? FALLBACK_URLS.ticket} target="_blank" rel="noopener noreferrer"
                     className="group flex items-center gap-3 bg-amber-50 hover:bg-amber-100 active:bg-amber-200 text-amber-700 px-4 py-3.5 rounded-xl font-bold text-sm transition-colors border border-amber-100 shadow-sm hover:shadow-md">
                    <Ticket size={17} className="shrink-0" />
                    <span className="flex-1 leading-tight">🎫 查看 Klook<br /><span className="font-normal text-xs text-amber-500">最新門票優惠</span></span>
                    <ExternalLink size={13} className="shrink-0 text-amber-400 group-hover:text-amber-600 transition-colors" />
                  </a>
                  <a href={aggAccommodation.url ?? FALLBACK_URLS.accommodation} target="_blank" rel="noopener noreferrer"
                     className="group flex items-center gap-3 bg-indigo-50 hover:bg-indigo-100 active:bg-indigo-200 text-indigo-700 px-4 py-3.5 rounded-xl font-bold text-sm transition-colors border border-indigo-100 shadow-sm hover:shadow-md">
                    <BedDouble size={17} className="shrink-0" />
                    <span className="flex-1 leading-tight">🏠 查看 Booking.com<br /><span className="font-normal text-xs text-indigo-400">鄰近住宿</span></span>
                    <ExternalLink size={13} className="shrink-0 text-indigo-400 group-hover:text-indigo-600 transition-colors" />
                  </a>
                </div>
              </div>

              {/* ── 溫馨提醒（截圖範圍內，下載圖片時同步保留）──────────────── */}
              {plannedEvents.length > 0 && (
                <div className="flex items-start gap-3 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <span className="text-lg shrink-0 leading-none mt-0.5">💡</span>
                  <p className="text-sm text-yellow-800 leading-relaxed">
                    <span className="font-bold">溫馨提醒：</span>
                    出發前請記得確認並預訂台東的
                    <span className="font-bold">住宿</span>與
                    <span className="font-bold">交通（火車/租車）</span>服務喔！
                  </p>
                </div>
              )}
            </div>
            </div>{/* ↑ 關閉 reportCardRef wrapper */}

            {/* ── Modal Footer：下載圖片 / 匯出行事曆 ────────────────────── */}
            <div className="bg-white border-t border-gray-100 px-6 py-4 flex items-center justify-end gap-3 rounded-b-2xl">
              <button
                onClick={handleDownloadImage}
                disabled={isCapturing || plannedEvents.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCapturing
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Camera size={15} />}
                {isCapturing ? '製作中...' : '下載台東明信片'}
              </button>
              <button
                onClick={handleExportICS}
                disabled={plannedEvents.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CalendarPlus size={15} />
                匯出至行事曆
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header + Tab Bar ─────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <Link href="/" className="p-2 -ml-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <MapIcon className="text-blue-600" />路線規劃
            </h1>
          </div>

          {/* 日期 Tab Bar：snap 水平滑動 + 右側漸層遮罩 */}
          <div className="flex-1 min-w-0 relative">
            <div
              className="flex bg-[#ede9e0] p-1 rounded-xl overflow-x-auto scroll-smooth snap-x"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              {sortedDates.map((dateStr, index) => {
                const isActive = actualActiveDate === dateStr;
                return (
                  <button
                    key={dateStr}
                    ref={isActive ? activeTabRef : null}
                    onClick={() => setActiveDate(dateStr)}
                    className={[
                      'px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 whitespace-nowrap shrink-0 snap-start',
                      isActive
                        ? 'bg-slate-700 text-white shadow-md ring-2 ring-slate-400/40 ring-offset-1 scale-[1.04]'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-white/50',
                    ].join(' ')}
                  >
                    {/* 呼吸燈小點 */}
                    {isActive && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-300 animate-pulse mr-1.5 align-middle" />
                    )}
                    {formatTabLabel(dateStr, index)}
                  </button>
                );
              })}
            </div>
            {/* 右側漸層遮罩：暗示使用者右邊還有天數可滑動 */}
            <div
              className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-[#f8f6f0] to-transparent pointer-events-none rounded-r-xl"
              aria-hidden="true"
            />
          </div>
        </div>
      </header>

      {/* ── Main Grid ────────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 mt-8 grid grid-cols-1 lg:grid-cols-3 gap-8 lg:h-[calc(100vh-120px)]">

        {/* 左欄：活動清單 + 待處理池（手機版在上，桌機版在左） */}
        <div className="lg:col-span-1 flex flex-col gap-4 lg:overflow-y-auto pr-2 pb-10">

          {/* 當天活動（或空狀態） */}
          {currentDayEvents.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-gray-200">
              <div className="w-12 h-12 bg-gray-50 text-gray-400 rounded-full flex items-center justify-center mx-auto mb-3">
                <Calendar size={24} />
              </div>
              <h2 className="text-sm font-bold text-gray-600 mb-1">當天尚無活動</h2>
              {nearestDateWithEvents && nearestDateWithEvents !== actualActiveDate ? (
                <div className="mt-3 space-y-2">
                  <p className="text-gray-400 text-xs">
                    建議查看{' '}
                    <button onClick={() => setActiveDate(nearestDateWithEvents)} className="text-blue-500 font-bold hover:underline">
                      {formatTabLabel(nearestDateWithEvents, sortedDates.indexOf(nearestDateWithEvents))}
                    </button>
                  </p>
                  <button
                    onClick={() => setActiveDate(nearestDateWithEvents)}
                    className="inline-flex items-center gap-2 text-xs font-bold text-white bg-blue-500 hover:bg-blue-600 px-4 py-2 rounded-xl transition-colors shadow-sm"
                  >
                    <Calendar size={12} />定位到最近有活動的日期
                  </button>
                </div>
              ) : (
                <p className="text-gray-400 text-xs mt-2">可以從其他天把行程移過來，或回首頁探索！</p>
              )}
            </div>
          ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="itinerary-list">
                {(provided) => (
                  <div {...provided.droppableProps} ref={provided.innerRef} className="flex flex-col gap-4">
                    {currentDayEvents.map((event, index) => (
                      <Fragment key={event.id}>
                      <Draggable draggableId={event.id} index={index}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            onClick={() => setSelectedEventId(prev => prev === event.id ? null : event.id)}
                            className={[
                              'rounded-2xl p-5 border shadow-sm relative group flex gap-4 transition-colors cursor-pointer',
                              // 斑馬紋：偶數 white，奇數 slate-50
                              index % 2 === 0 ? 'bg-white' : 'bg-slate-50',
                              snapshot.isDragging ? 'border-blue-500 shadow-xl scale-[1.02] z-50'
                                : selectedEventId === event.id ? 'border-blue-500 ring-2 ring-blue-300'
                                : 'border-gray-100',
                            ].join(' ')}
                          >
                            <div {...provided.dragHandleProps} className="flex items-center justify-center text-gray-300 hover:text-blue-500 transition-colors">
                              <GripVertical size={20} />
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center font-bold text-sm flex-shrink-0 mt-1">
                              {index + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-bold text-gray-800 text-base mb-1 pr-6 leading-tight truncate">{event.title}</h3>
                              {/* 硬排警告 tag — 不影響 DnD 佈局，inline-block 流式排列 */}
                              {getIsHardScheduled(event) && (
                                <div className="mb-2 flex items-center gap-1.5 bg-red-600 text-white text-[11px] font-bold px-2.5 py-1 rounded-lg w-fit leading-tight">
                                  <AlertTriangle size={11} className="shrink-0" />
                                  此活動在今日無舉辦，請再確認
                                </div>
                              )}
                              {/* Task 3：嚴格對齊 assigned_date */}
                              <div className="flex items-center text-blue-500 text-xs gap-1 mb-1 font-medium">
                                <Calendar size={12} />
                                {formatAssignedDate(event.assigned_date, sortedDates)}
                              </div>
                              {/* 時間顯示：HH:MM – HH:MM（僅在有明確時間時顯示） */}
                              {(() => {
                                const startHHMM = getStartHHMM(event);
                                if (!startHHMM) return null;
                                const endHHMM = minToHHMM(hhmmToMin(startHHMM) + (event.stay_duration ?? 60));
                                return (
                                  <div className="flex items-center gap-1.5 text-[11px] text-teal-600 font-mono mb-1">
                                    <Clock size={11} className="shrink-0 text-teal-500" />
                                    <span>{startHHMM} – {endHHMM}</span>
                                    <span className="text-gray-300 font-sans ml-0.5">（{event.stay_duration ?? 60} 分鐘）</span>
                                  </div>
                                );
                              })()}
                              {/* Feature 1：展覽完整展期區間（與單次活動明確區分） */}
                              {isExhibition(event) && event.end_date && (
                                <div className="flex items-center text-violet-400 text-[11px] gap-1 mb-1">
                                  <span className="font-bold tracking-wide">展期</span>
                                  <span>{formatExhibitionRange(event.start_time, event.end_date)}</span>
                                </div>
                              )}
                              {/* Feature 3：展覽 / 長期活動 — 彈性前往時間選擇 */}
                              {isExhibition(event) && (
                                <div
                                  className="flex items-center gap-2 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5 mb-1 w-fit"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Clock size={11} className="text-violet-500 shrink-0" />
                                  <span className="text-[11px] text-violet-600 font-medium whitespace-nowrap">此活動為展覽，預計前往</span>
                                  <select
                                    value={event.visit_time ?? ''}
                                    onChange={(e) => updateVisitTime(event.id, e.target.value)}
                                    className="text-[11px] font-bold text-violet-700 bg-white border border-violet-200 rounded px-1.5 py-0.5 outline-none focus:border-violet-400 cursor-pointer"
                                  >
                                    <option value="">選擇時間</option>
                                    {EXHIBITION_TIME_OPTIONS.map(t => (
                                      <option key={t} value={t}>{t}</option>
                                    ))}
                                  </select>
                                </div>
                              )}
                              {/* 展覽開放時間防呆提醒 */}
                              {isExhibition(event) && (
                                <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-2 py-1.5 rounded mt-1 mb-1">
                                  <span className="shrink-0">💡</span>
                                  <span>展覽確切開放時間，建議出發前至官網確認。</span>
                                </div>
                              )}
                              <div className="flex flex-wrap items-center gap-3 mt-2">
                                <div className="flex items-center text-blue-600 font-medium text-xs gap-1">
                                  <MapPin size={12} />
                                  <span className="truncate max-w-[100px] sm:max-w-[150px]">{event.venue_name}</span>
                                </div>
                                {event.ticket_url && (
                                  <a href={event.ticket_url} target="_blank" rel="noopener noreferrer"
                                     onClick={(e) => e.stopPropagation()}
                                     className="flex items-center gap-1 text-[10px] font-bold text-white bg-amber-500 hover:bg-amber-600 px-2 py-0.5 rounded transition-colors shadow-sm">
                                    <Ticket size={10} /> 購票
                                  </a>
                                )}
                                <select
                                  value={actualActiveDate}
                                  onChange={(e) => handleDateChange(event, e.target.value)}
                                  className="text-[10px] font-bold text-gray-500 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 outline-none hover:bg-gray-100 cursor-pointer ml-auto"
                                >
                                  {sortedDates.map((d, i) => (
                                    <option key={d} value={d}>移至 {formatTabLabel(d, i)}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <button
                              onClick={() => removeEvent(event.id)}
                              className="absolute top-4 right-4 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                      </Draggable>
                      {/* 時間衝突警告：出現在當前卡片與下一張卡片之間 */}
                      {conflictSet.has(index) && (() => {
                        const warn = gapWarnings.find(w => w.afterIndex === index)!;
                        return (
                          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 -mt-2 -mb-2">
                            <AlertTriangle size={14} className="shrink-0 text-red-500 mt-0.5" />
                            <div className="text-xs text-red-700 leading-snug">
                              <span className="font-bold">時間衝突！</span>
                              {' '}前往下一站預計需 {warn.travelMinutes} 分鐘，但時間不足 {warn.conflictMinutes} 分鐘，建議調整行程順序。
                            </div>
                          </div>
                        );
                      })()}
                      </Fragment>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          )}

          {/* Task 4：待處理活動池（旅程縮短後超出範圍的活動） */}
          {unassignedEvents.length > 0 && (
            <div className="mt-2 pt-4 border-t-2 border-dashed border-amber-200">
              <div className="flex items-center gap-2 mb-2">
                <PackageOpen size={15} className="text-amber-500 shrink-0" />
                <span className="text-xs font-bold text-amber-600">
                  待處理活動（{unassignedEvents.length} 筆）
                </span>
              </div>
              <p className="text-[11px] text-gray-400 mb-3 pl-5">
                以下活動不在旅程日期內，請重新安排或移除
              </p>
              <div className="flex flex-col gap-2">
                {unassignedEvents.map(event => (
                  <div key={event.id} className="bg-amber-50 border border-amber-100 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h4 className="font-bold text-gray-700 text-sm leading-tight line-clamp-2 flex-1">
                        {event.title}
                      </h4>
                      <button
                        onClick={() => removeEvent(event.id)}
                        className="text-gray-300 hover:text-red-500 transition-colors p-1 shrink-0"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="text-[11px] text-amber-500 mb-2 flex items-center gap-1">
                      <AlertTriangle size={11} />
                      原排於 {event.assigned_date.replace(/-/g, '/')}，超出旅程範圍
                    </p>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) updateEventDate(event.id, e.target.value);
                      }}
                      className="w-full text-xs text-gray-600 bg-white border border-amber-200 rounded-lg px-3 py-1.5 outline-none focus:border-amber-400 cursor-pointer"
                    >
                      <option value="" disabled>重新安排到...</option>
                      {sortedDates.map((d, i) => (
                        <option key={d} value={d}>{formatTabLabel(d, i)}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 卡片 Footer：操作按鈕 + 回饋（貼合左欄底部，在 scrollable 列表內）── */}
          <div className="border-t border-[#e8e4da] bg-[#f0ede6] rounded-2xl p-6 flex flex-col gap-6 mt-2">

            {/* 核心操作按鈕：Primary → Secondary → Tertiary */}
            <div className="flex flex-col gap-3">
              {/* Primary：最重要的功能，品牌深海藍底白字 */}
              <button
                onClick={() => setShowReport(true)}
                disabled={plannedEvents.length === 0}
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#1e3a5f] hover:bg-[#162d4a] active:bg-[#0f2238] text-white rounded-xl font-bold text-sm shadow-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileText size={15} />
                生成完整行程報告
              </button>
              {/* Secondary：實用功能，暖灰底深字 */}
              <button
                onClick={handleExportICS}
                disabled={plannedEvents.length === 0}
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#e8e4da] hover:bg-[#dedad0] active:bg-[#d4cfc4] text-slate-700 rounded-xl font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CalendarPlus size={15} />
                匯出行程檔案 (ICS)
              </button>
              {/* Tertiary：附加功能，outline 低調 */}
              <button
                onClick={handleDownloadImage}
                disabled={isCapturing || plannedEvents.length === 0}
                className="flex items-center justify-center gap-2 w-full py-2.5 border border-[#d4cfc4] hover:border-[#c5bfb3] hover:bg-[#ede9e0] active:bg-[#e5e0d6] text-slate-500 rounded-xl font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCapturing ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}
                {isCapturing ? '製作中...' : '下載台東明信片'}
              </button>
            </div>

            {/* 按讚與留言 */}
            <div className="bg-white p-5 rounded-2xl border border-gray-100 flex flex-col gap-4">

              {/* 標題列：標題左，累計讚數右 */}
              <div className="flex items-center justify-between">
                <h4 className="text-gray-800 font-bold text-sm">喜歡行程小助手嗎？</h4>
                {likeCount > 0 && (
                  <span className="text-xs text-gray-400">
                    目前累積喜歡人數：<span className="font-semibold text-rose-400">{likeCount.toLocaleString()}</span>
                  </span>
                )}
              </div>

              <button
                onClick={handleLike}
                disabled={isLiked}
                className={[
                  'flex items-center gap-2 w-fit px-4 py-2 rounded-full border transition-colors shadow-sm',
                  isLiked
                    ? 'bg-rose-50 border-rose-300 text-rose-600 cursor-default'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-rose-50 hover:text-rose-600',
                ].join(' ')}
              >
                <span>{isLiked ? '❤️' : '👍'}</span>
                <span className="text-sm font-medium">
                  {isLiked ? '已按讚！謝謝你' : '給助手一個讚'}
                </span>
              </button>

              {feedbackSent ? (
                <div className="text-sm text-green-600 font-medium bg-green-50 border border-green-200 rounded-xl px-4 py-3">
                  已收到你的建議，感謝回饋！
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    placeholder="有什麼建議？告訴我們..."
                    className="w-full text-sm p-3 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 resize-none h-24"
                  />
                  {feedbackError && (
                    <p className="text-xs text-red-500">送出失敗，請稍後再試。</p>
                  )}
                  <button
                    onClick={handleFeedbackSubmit}
                    disabled={!feedbackText.trim() || isFeedbackLoading}
                    className="self-end flex items-center gap-1.5 px-4 py-1.5 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isFeedbackLoading && <Loader2 size={13} className="animate-spin" />}
                    匿名送出
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* 右欄：地圖（手機版在下，桌機版在右） */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="rounded-3xl border border-gray-200 overflow-hidden relative shadow-inner h-[55vh] lg:h-full lg:min-h-[500px]">
            <MapComponent
              events={currentDayEvents}
              selectedEventId={selectedEventId}
              onLegDurationsChange={setLegDurations}
            />
          </div>

          {/* ── 匯出區塊（手機版地圖下方，桌機版同位置） ── */}
          <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-5 flex flex-col sm:flex-row items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-bold text-stone-700 text-sm">產生行程報告 ＆ 匯出明信片</p>
              <p className="text-xs text-stone-400 mt-0.5">將行程轉為精美圖片，方便分享或列印</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                disabled
                className="px-4 py-2.5 bg-stone-200 text-stone-400 text-xs font-bold rounded-xl cursor-not-allowed"
                title="即將推出"
              >
                📋 行程報告
              </button>
              <button
                disabled
                className="px-4 py-2.5 bg-stone-200 text-stone-400 text-xs font-bold rounded-xl cursor-not-allowed"
                title="即將推出"
              >
                🖼️ 匯出明信片
              </button>
            </div>
          </div>
        </div>
      </div>


      {/* ── 臺東氣息明信片模板（橫式 4x6 吋 + 3mm 出血，off-screen，永遠在 DOM）──────
           • 最外層：1271×871px（含出血），海景底圖鋪滿
           • 內部安全區：1200×800px 置中，所有文字/行程嚴禁超出
           • 全部顏色 rgba() / hex，絕對 html2canvas 安全，零 Tailwind opacity modifier
      ─────────────────────────────────────────────────────────────────────── */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: '-9999px', zIndex: -1 }}>

        {/* ── 最外層：出血容器 1271×871，背景圖鋪滿（含出血邊） ── */}
        <div
          ref={postcardRef}
          style={{
            width: '1271px',
            height: '871px',
            position: 'relative',
            overflow: 'hidden',
            flexShrink: 0,
            backgroundImage: "url('/postcard-bg.jpg')",
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            fontFamily: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* ── 全域漸層遮罩（淡化版）：純 rgba()，html2canvas 安全 ── */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'linear-gradient(to right, rgba(0,0,0,0.50), rgba(0,0,0,0.20), rgba(0,0,0,0.10))',
            pointerEvents: 'none',
          }} />

          {/* ── 安全區：1200×800，所有內容嚴格限制於此 ── */}
          <div style={{
            position: 'relative',
            zIndex: 10,
            width: '1200px',
            height: '800px',
            flexShrink: 0,
            display: 'flex',
            overflow: 'hidden',
          }}>

            {/* ════ 左欄：品牌文案錨定左下角 ════ */}
            <div style={{
              width: '420px',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              padding: '0 48px 52px 56px',
              borderRight: '1px solid rgba(255,255,255,0.12)',
            }}>
              <div style={{ fontSize: '10px', letterSpacing: '0.45em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', marginBottom: '16px' }}>
                CulturRoute · 臺東藝文路徑
              </div>
              <div style={{ fontSize: '64px', fontWeight: 900, color: '#ffffff', letterSpacing: '-0.01em', lineHeight: 0.88, marginBottom: '20px' }}>
                探索<br />臺東
              </div>
              <div style={{ width: '36px', height: '1.5px', backgroundColor: 'rgba(255,255,255,0.50)', marginBottom: '16px' }} />
              <div style={{ fontSize: '17px', fontWeight: 300, color: 'rgba(255,255,255,0.88)', letterSpacing: '0.22em', marginBottom: '28px' }}>
                遇見最好的自己
              </div>
              <div>
                {(tripStartDate || tripEndDate) && (
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.50)', letterSpacing: '0.12em', fontWeight: 300, marginBottom: '8px' }}>
                    {tripStartDate && tripEndDate && tripStartDate !== tripEndDate
                      ? `${tripStartDate.replace(/-/g, '/')}  ─  ${tripEndDate.replace(/-/g, '/')}`
                      : (tripStartDate || tripEndDate).replace(/-/g, '/')}
                  </div>
                )}
                <div style={{ fontSize: '9px', letterSpacing: '0.3em', color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase' }}>
                  culturroute.tw
                </div>
              </div>
            </div>

            {/* ════ 右欄：行程 Timeline（透明，海景貫穿）════ */}
            <div style={{
              flex: 1,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              padding: '52px 52px 48px 48px',
            }}>
              {sortedDates.map((date, dayIndex) => {
                const dayEvents = plannedEvents
                  .filter(e => e.assigned_date === date)
                  .sort((a, b) => getEffectiveSortTime(a).localeCompare(getEffectiveSortTime(b)));
                if (dayEvents.length === 0) return null;
                return (
                  <div key={date} style={{ marginBottom: '24px' }}>
                    {/* Day label + 細橫線 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                      <div style={{ fontSize: '9px', letterSpacing: '0.4em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        第 {dayIndex + 1} 天　{formatTabLabel(date, dayIndex)}
                      </div>
                      <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(255,255,255,0.15)' }} />
                    </div>

                    {/* Events：只顯示活動名稱 + 地點 */}
                    {dayEvents.map((event, eIdx) => (
                      <div key={event.id} style={{ display: 'flex' }}>
                        {/* Timeline 軸：空心圓點 + 細連接線 */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginRight: '16px', flexShrink: 0 }}>
                          <div style={{
                            width: '7px', height: '7px', borderRadius: '50%',
                            border: '1.5px solid rgba(255,255,255,0.60)',
                            backgroundColor: 'transparent',
                            marginTop: '4px', flexShrink: 0,
                          }} />
                          {eIdx < dayEvents.length - 1 && (
                            <div style={{ width: '1px', flex: 1, minHeight: '22px', backgroundColor: 'rgba(255,255,255,0.18)', margin: '4px 0' }} />
                          )}
                        </div>

                        {/* 極簡內容：活動名稱 + 地點 */}
                        <div style={{ flex: 1, paddingBottom: eIdx < dayEvents.length - 1 ? '14px' : '0' }}>
                          <div style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff', lineHeight: 1.3, marginBottom: '3px' }}>
                            {event.title}
                          </div>
                          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.50)', letterSpacing: '0.03em' }}>
                            📍 {event.venue_name}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

          </div>{/* /安全區 1200×800 */}
        </div>{/* /出血容器 1271×871 */}
      </div>
    </main>
  );
}
