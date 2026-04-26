'use client';

import { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import EventCard from '@/components/EventCard';
import AddItineraryButton from '@/components/AddItineraryButton';
import EventDetailModal from '@/components/EventDetailModal';
import { CalendarRange, CalendarX, Sparkles, Clock } from 'lucide-react';
import { useItineraryStore } from '@/store/useItineraryStore';
import type { Event } from '@/types';

// 台灣時區安全的日期轉換：將任意 ISO 字串轉換為台北時間的 YYYY-MM-DD
// 必須用 toLocaleDateString 而非 substring(0,10)，因為 Supabase 回傳 UTC 時間
// 例：凌晨 0:00 台北時間 = 前一天 16:00 UTC，substring 會取到錯誤日期
const dateOnlyTaipei = (iso: string): string =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

// ssr:false — @vis.gl/react-google-maps 依賴瀏覽器 window
const EventsMapDynamic = dynamic(() => import('@/components/EventsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full bg-slate-50 animate-pulse rounded-2xl flex items-center justify-center text-slate-400 text-sm font-medium">
      地圖載入中…
    </div>
  ),
});

export default function EventBrowser({ initialEvents }: { initialEvents: Event[] }) {
  const {
    tripStartDate: startDate, tripEndDate: endDate, setTripDates,
    plannedEvents, addTripDay, addEvent, removeEvent, setHoveredEventId,
  } = useItineraryStore();
  const [isMounted, setIsMounted] = useState(false);
  const [viewMode, setViewMode] = useState<'all' | 'performance' | 'lecture' | 'exhibition'>('all');
  const [quickToastId, setQuickToastId] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  // useMemo 確保每次 render 不重新計算（日期在同一天內不會改變）
  const TODAY = useMemo(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }), []);

  // 展覽：vibe_tags 含「靜態展覽」，或標題含「個展」「聯展」「特展」
  // 不再依賴 end_date，避免多日節慶被誤判
  const isExhibition = (event: Event): boolean => {
    if (event.vibe_tags?.includes('靜態展覽')) return true;
    return /個展|聯展|特展/.test(event.title);
  };

  // 演出：vibe_tags 含表演/音樂/舞蹈/戲劇相關標籤，且非展覽
  const PERFORMANCE_TAGS = ['演出', '表演', '音樂', '音樂會', '演唱會', '舞蹈', '戲劇', '劇場'];
  const isPerformance = (event: Event): boolean => {
    if (isExhibition(event)) return false;
    return event.vibe_tags?.some(t => PERFORMANCE_TAGS.includes(t)) ?? false;
  };

  // 講座：vibe_tags 含講座/工作坊/論壇等標籤，且非展覽
  const LECTURE_TAGS = ['講座', '工作坊', '論壇', '分享', '課程', '演講', '研習'];
  const isLecture = (event: Event): boolean => {
    if (isExhibition(event)) return false;
    return event.vibe_tags?.some(t => LECTURE_TAGS.some(lt => t.includes(lt))) ?? false;
  };

  const applyViewMode = (events: Event[]): Event[] => {
    if (viewMode === 'performance') return events.filter(isPerformance);
    if (viewMode === 'lecture')     return events.filter(isLecture);
    if (viewMode === 'exhibition')  return events.filter(isExhibition);
    return events;
  };

  useEffect(() => { setIsMounted(true); }, []);

  const isFiltering = startDate && endDate;
  let currentEvents = initialEvents;
  let missedEvents: Event[] = [];

  // viewMode 過濾（在所有其他篩選之前先套，保證非篩選模式也生效）
  currentEvents = applyViewMode(currentEvents);

  if (isFiltering) {

    currentEvents = initialEvents.filter(event => {
      const eStart = dateOnlyTaipei(event.start_time);
      // 優先使用 end_date（跨日展覽），其次 end_time 的日期，最後退回 start_time 日期
      const eEnd = event.end_date ?? (event.end_time ? dateOnlyTaipei(event.end_time) : eStart);
      // 重疊判斷：活動開始 ≤ 行程結束 且 活動結束 ≥ 行程開始
      return eStart <= endDate && eEnd >= startDate;
    });

    // 日期篩選後再套 viewMode（避免 initialEvents 重賦值蓋掉外層的過濾）
    currentEvents = applyViewMode(currentEvents);

    // 錯過活動：活動開始在行程結束後 7 天內
    const tripEnd = new Date(endDate);
    tripEnd.setDate(tripEnd.getDate() + 7);
    const sevenDaysAfterStr = tripEnd.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

    missedEvents = initialEvents.filter(event => {
      const eStart = dateOnlyTaipei(event.start_time);
      return eStart > endDate && eStart <= sevenDaysAfterStr;
    });
  }

  const isOngoing = (event: Event): boolean => {
    const eStart = dateOnlyTaipei(event.start_time);
    const eEnd   = event.end_date ?? (event.end_time ? dateOnlyTaipei(event.end_time) : eStart);
    return TODAY >= eStart && TODAY <= eEnd;
  };

  // ── 多留一下（合併版）：增加旅遊天數 + 同步加入行程，標記 isExtraDayTrigger ──
  const handleStayLonger = (e: React.MouseEvent, event: Event) => {
    e.preventDefault(); // 阻止 Link 跳轉
    addTripDay();                                    // tripEndDate + 1 天
    addEvent(event, { isExtraDayTrigger: true });   // 加入行程並帶入提醒標記
  };

  // 快速加入行程（手機用）：阻止 Link 跳轉，切換加入/移除，短暫顯示回饋
  const handleQuickAdd = (e: React.MouseEvent, event: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const isAdded = plannedEvents.some(p => p.id === event.id);
    if (isAdded) {
      removeEvent(event.id);
    } else {
      addEvent(event);
      setQuickToastId(event.id);
      setTimeout(() => setQuickToastId(null), 1500);
    }
  };

  // 「多留幾天」區塊專用：卡片多一顆「多留一下」按鈕
  const renderMissedEventGrid = (events: Event[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event) => (
        <div
          key={event.id}
          onClick={() => setSelectedEvent(event)}
          className="relative flex flex-col h-full group cursor-pointer"
        >
          {isOngoing(event) && (
            <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-green-500 text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow-md">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse inline-block" />
              進行中
            </div>
          )}
          <EventCard
            event={event}
            onMouseEnter={() => setHoveredEventId(event.id)}
            onMouseLeave={() => setHoveredEventId(null)}
          />
          <div
            className="absolute inset-x-0 bottom-0 h-[60%] bg-white/97 p-5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col z-20 border-t border-stone-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-serif font-bold text-stone-800 mb-1.5 text-base tracking-wide">活動簡介</h4>
            <p className="text-stone-500 text-sm leading-relaxed line-clamp-2 mb-2">{event.long_description || event.description || '暫無詳細簡介。'}</p>
            <div className="text-teal-800 text-sm flex items-center mb-auto tracking-wide">點擊卡片查看詳情 <span className="ml-1 group-hover:translate-x-1 transition-transform">→</span></div>
            <button
              onClick={(e) => handleStayLonger(e, event)}
              className="mt-3 w-full py-2 font-medium text-sm tracking-wider transition-all active:scale-95 flex items-center justify-center gap-2 border border-teal-800 text-teal-800 hover:bg-teal-800 hover:text-white"
            >
              <Clock size={14} />
              多留一下，看這個！
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderEventGrid = (events: Event[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event) => {
        const isAdded = plannedEvents.some(p => p.id === event.id);
        const justAdded = quickToastId === event.id;
        return (
          <div
            key={event.id}
            onClick={() => setSelectedEvent(event)}
            className="relative flex flex-col h-full group cursor-pointer"
          >
            {/* 進行中 badge */}
            {isOngoing(event) && (
              <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-green-500 text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow-md">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse inline-block" />
                進行中
              </div>
            )}
            <EventCard
              event={event}
              onMouseEnter={() => setHoveredEventId(event.id)}
              onMouseLeave={() => setHoveredEventId(null)}
            />
            {/* 手機快速加入按鈕（只在 lg 以下顯示，永遠可點，不需要 hover） */}
            <button
              onClick={(e) => handleQuickAdd(e, event)}
              className={[
                'lg:hidden absolute bottom-3 right-3 z-30 w-10 h-10 rounded-full flex items-center justify-center shadow-md transition-all duration-200 active:scale-90 border-2',
                isAdded
                  ? 'bg-teal-600 border-teal-600 text-white'
                  : 'bg-white border-stone-200 text-stone-600 hover:border-teal-600 hover:text-teal-600',
              ].join(' ')}
              aria-label={isAdded ? '已加入行程' : '加入行程'}
            >
              {justAdded ? '✓' : isAdded ? '✓' : '+'}
            </button>
            {/* 桌機 hover 覆蓋層 */}
            <div
              className="absolute inset-x-0 bottom-0 h-[55%] bg-white/97 p-6 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col z-20 border-t border-stone-100"
              onClick={(e) => e.stopPropagation()}
            >
              <h4 className="font-serif font-bold text-stone-800 mb-2 text-base tracking-wide">活動簡介</h4>
              <p className="text-stone-500 text-sm leading-relaxed line-clamp-3 mb-2">{event.long_description || event.description || '暫無詳細簡介。'}</p>
              <div className="text-teal-800 text-sm flex items-center mb-auto tracking-wide">點擊卡片查看詳情 <span className="ml-1 group-hover:translate-x-1 transition-transform">→</span></div>
              <AddItineraryButton event={event} />
            </div>
          </div>
        );
      })}
    </div>
  );

  if (!isMounted) return null;

  return (
    <>
    <div className="flex flex-col lg:flex-row-reverse gap-6 items-start">

      {/* ── 地圖面板 ──────────────────────────────────────────────────────────
           手機：sticky top-0，高度 40vh，地圖永遠可見
           桌面：右側 400px，sticky top-4，佔滿視窗高度
      ────────────────────────────────────────────────────────────────────── */}
      <aside className="w-full lg:w-[400px] lg:flex-shrink-0 sticky top-0 z-30 lg:top-4 bg-[#f8f6f0] lg:bg-transparent">
        <div className="h-[28vh] lg:h-[calc(100vh-2rem)] overflow-hidden border border-stone-200">
          <EventsMapDynamic events={currentEvents} />
        </div>
      </aside>

      {/* ── 主內容：篩選器 + 活動列表 ──────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
      {/* 今日進行中橫幅（未篩選時才顯示） */}
      {!isFiltering && (() => {
        const ongoingCount = initialEvents.filter(isOngoing).length;
        return ongoingCount > 0 ? (
          <div className="mb-6 flex items-center justify-between border-b border-green-200 pb-4">
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
              <span className="text-green-800 text-sm tracking-wide">
                今日（{TODAY.slice(5).replace('-', '/')}）正有 <span className="font-bold">{ongoingCount}</span> 個活動進行中
              </span>
            </div>
            <button
              onClick={() => setTripDates(TODAY, TODAY)}
              className="text-xs tracking-wider text-green-700 border border-green-300 hover:bg-green-700 hover:text-white px-3 py-1.5 transition-colors shrink-0"
            >
              只看今日
            </button>
          </div>
        ) : null;
      })()}

      <div id="tour-date-filter" className="mb-10 border-b border-stone-200 pb-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <CalendarRange className="text-teal-800" size={18} />
            <h2 className="text-base font-serif tracking-widest text-stone-700 uppercase">你預計在台東停留的時間？</h2>
          </div>
          {!isFiltering && (
            <button
              onClick={() => setTripDates(TODAY, TODAY)}
              className="flex items-center gap-1.5 text-xs tracking-wider text-teal-800 border border-teal-700 hover:bg-teal-800 hover:text-white px-3 py-2 transition-colors"
            >
              <CalendarRange size={12} />
              快速選今日
            </button>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-4 items-end">
          <div className="flex-1 w-full">
            <label className="block text-[10px] font-medium text-stone-400 mb-2 uppercase tracking-[0.2em]">抵達日期</label>
            <input
              type="date" value={startDate}
              onChange={(e) => setTripDates(e.target.value, endDate)}
              className="w-full bg-transparent border-b border-stone-300 px-0 py-2 text-stone-700 focus:outline-none focus:border-teal-700 transition-colors"
              suppressHydrationWarning
            />
          </div>
          <div className="flex-1 w-full">
            <label className="block text-[10px] font-medium text-stone-400 mb-2 uppercase tracking-[0.2em]">離開日期</label>
            <input
              type="date" min={startDate} value={endDate}
              onChange={(e) => setTripDates(startDate, e.target.value)}
              className="w-full bg-transparent border-b border-stone-300 px-0 py-2 text-stone-700 focus:outline-none focus:border-teal-700 transition-colors"
              suppressHydrationWarning
            />
          </div>
          {isFiltering && (
            <button onClick={() => setTripDates('', '')} className="px-4 py-2 text-xs text-stone-400 hover:text-stone-600 tracking-wider border border-stone-300 hover:border-stone-500 transition-colors">清除</button>
          )}
        </div>
      </div>

      <div className="mb-5 flex items-baseline justify-between">
        <h3 className="text-xl font-serif tracking-wide text-stone-800">{isFiltering ? '這段期間的精彩活動' : '所有藝文活動'}</h3>
        <span className="text-stone-400 text-[10px] tracking-[0.2em] uppercase border-b border-stone-300 pb-0.5">{currentEvents.length} 筆</span>
      </div>

      {/* ── 類型膠囊篩選器 ──────────────────────────────────────────────────── */}
      <div id="tour-event-type-filter" className="mb-8 flex gap-2 flex-wrap">
        {(
          [
            { key: 'all',         label: '✨ 全部' },
            { key: 'performance', label: '🎭 演出' },
            { key: 'lecture',     label: '🎤 講座' },
            { key: 'exhibition',  label: '🏛️ 展覽' },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setViewMode(key)}
            className={[
              'px-4 py-1.5 rounded-full text-sm tracking-wide border transition-all duration-200',
              viewMode === key
                ? 'bg-stone-800 text-white border-stone-800'
                : 'bg-stone-100 text-stone-500 border-stone-200 hover:border-stone-400 hover:text-stone-700',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {currentEvents.length === 0 ? (
        <div className="py-20 text-center border border-stone-200 flex flex-col items-center mb-12">
          <CalendarX className="text-stone-300 mb-4" size={40} />
          <h3 className="text-base font-serif tracking-wide text-stone-500 mb-1">這幾天剛好沒有活動</h3>
        </div>
      ) : (
        <div id="tour-event-grid" className="mb-16">{renderEventGrid(currentEvents)}</div>
      )}

      {isFiltering && missedEvents.length > 0 && (
        <div className="mt-16 pt-12 border-t border-stone-300 relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#f8f6f0] px-6">
            <div className="flex items-center gap-2 text-stone-600 border border-stone-300 px-4 py-2"><Sparkles size={14} className="text-amber-600" /><span className="text-sm tracking-widest font-serif">如果您願意多留幾天</span></div>
          </div>
          <p className="text-center text-stone-400 text-sm mb-8 max-w-2xl mx-auto tracking-wide">就在您預計離開後的幾天內，台東還有這些即將發生的精彩活動。</p>
          <div className="opacity-90 hover:opacity-100 transition-opacity">{renderMissedEventGrid(missedEvents)}</div>
        </div>
      )}
      </div>{/* end 主內容 */}
    </div>

    <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </>
  );
}