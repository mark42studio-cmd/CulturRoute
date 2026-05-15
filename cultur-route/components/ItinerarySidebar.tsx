'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useItineraryStore } from '@/store/useItineraryStore';
import { Calendar, X, Trash2, Clock, ExternalLink, Lock } from 'lucide-react';
import Link from 'next/link';
import type { PlannedEvent } from '@/types';
import { toast } from 'sonner';
import { buildTripDateRange } from '@/lib/tripDates';
import { buildAgodaUrl, addOneDay } from '@/lib/agoda';

// ── 側邊欄日期格式工具 ──────────────────────────────────────────────────────────

/** YYYY-MM-DD → "M月D日" */
const fmtMonthDay = (iso: string): string => {
  const [, m, d] = iso.substring(0, 10).split('-').map(Number);
  return `${m}月${d}日`;
};

/** HH:MM → "上午09:00" / "下午02:00" */
const fmtVisitTime = (hhmm: string): string => {
  const [h, min] = hhmm.split(':').map(Number);
  const [y, mo, day] = [2000, 1, 1]; // 任意基準日，只取時間部分
  return new Date(y, mo - 1, day, h, min)
    .toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
};

/**
 * 判斷是否為展覽（有 end_date 且晚於 start_time 日期）
 * 與 page.tsx 的 isExhibition 邏輯一致，但僅用 end_date 判斷（最嚴格定義）
 */
const isSidebarExhibition = (event: PlannedEvent): boolean =>
  !!(event.end_date && event.end_date > event.start_time.substring(0, 10));

const isSingleDayLocked = (event: PlannedEvent): boolean => {
  if (event.time_type === '單日活動') return true;
  // No end info at all → cannot confirm multi-day, treat as locked
  if (!event.end_time && !event.end_date) return true;
  const startDay = event.start_time.substring(0, 10);
  const endDay = event.end_time?.substring(0, 10);
  return !!endDay && startDay === endDay;
};

const CHINESE_DAY_NAMES = ['一','二','三','四','五','六','七','八','九','十'];

function localDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function buildTripDateOptions(start: string, end: string, assigned: string): string[] {
  if (!start || !end) return assigned ? [assigned] : [];
  const dates: string[] = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  for (let n = 0; n < 62; n++) {
    const d = new Date(sy, sm - 1, sd + n);
    const s = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (s > end) break;
    dates.push(s);
  }
  if (assigned && !dates.includes(assigned)) { dates.push(assigned); dates.sort(); }
  return dates;
}

function formatDayOption(dateStr: string, tripStart: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  const n = Math.round((localDate(dateStr).getTime() - localDate(tripStart).getTime()) / 86400000) + 1;
  const ord = n >= 1 && n <= 10 ? CHINESE_DAY_NAMES[n - 1] : String(n);
  return `預計前往：${m}月${d}日(第${ord}天)`;
}

const STAY_OPTIONS = [
  { value: 30,  label: '30 分鐘' },
  { value: 60,  label: '1 小時' },
  { value: 90,  label: '1.5 小時' },
  { value: 120, label: '2 小時' },
  { value: 180, label: '3 小時' },
  { value: 240, label: '半天' },
];

// ── 客製化下拉選單（捨棄原生 <select>，消除 OS 藍色反白）────────────────────────

type SelectOption<T> = { value: T; label: string };

function CustomSelect<T extends string | number>({
  value,
  options,
  onChange,
  triggerClassName,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={triggerClassName ?? 'w-full flex items-center justify-between rounded-lg px-2 py-1 border border-purple-200 text-purple-700 bg-purple-50 text-xs cursor-pointer transition-colors hover:border-purple-300'}
      >
        <span className="truncate text-left">{selected?.label ?? String(value)}</span>
        <svg className="ml-1 shrink-0 opacity-50" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <ul className="absolute z-50 top-full mt-1 left-0 min-w-full bg-white shadow-lg border border-stone-200 rounded-xl overflow-hidden">
          {options.map(opt => (
            <li
              key={String(opt.value)}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={[
                'cursor-pointer px-4 py-2 text-stone-700 hover:bg-stone-100 hover:text-stone-900 transition-colors text-sm whitespace-nowrap',
                opt.value === value ? 'bg-stone-50 font-medium' : '',
              ].join(' ')}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ItinerarySidebar() {
  const pathname = usePathname();
  const {
    plannedEvents, isSidebarOpen, toggleSidebar,
    removeEvent, updateStayDuration, updateEventDate,
    tripStartDate, tripEndDate,
    flashEventId, flashDayAdded, clearFlash,
    clearPlannedEvents,
  } = useItineraryStore();

  const tripDates = buildTripDateRange(
    tripStartDate,
    tripEndDate,
    plannedEvents.map(e => e.assigned_date),
  );

  // 面板 DOM 掛載控制：避免關閉狀態的 fixed 元素停留在 320-640px 造成橫向溢出
  // panelMounted: 面板是否在 DOM 中；panelVisible: translate 是否為 x-0
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);

  useEffect(() => {
    if (isSidebarOpen) {
      setPanelMounted(true);
      // 雙 rAF：確保 DOM 掛載後再切換 translate，觸發 CSS transition
      requestAnimationFrame(() => requestAnimationFrame(() => setPanelVisible(true)));
    } else {
      setPanelVisible(false);
      // 等動畫完成（300ms）再從 DOM 移除，避免瞬間消失
      const t = setTimeout(() => setPanelMounted(false), 320);
      return () => clearTimeout(t);
    }
  }, [isSidebarOpen]);

  // 必須在所有 hook 之後才能 early return，避免違反 Rules of Hooks
  useEffect(() => {
    if (!flashEventId && !flashDayAdded) return;
    const t = setTimeout(clearFlash, 2000);
    return () => clearTimeout(t);
  }, [flashEventId, flashDayAdded, clearFlash]);

  if (pathname.startsWith('/admin')) return null;

  return (
    <>
      {/* 🌟 1. 右下角浮動按鈕 */}
      <button
        id="itinerary-sidebar-btn"
        onClick={toggleSidebar}
        className="hidden md:flex fixed bottom-6 right-6 z-40 bg-blue-600 text-white p-4 rounded-full shadow-lg hover:bg-blue-700 hover:scale-105 transition-all duration-300 items-center justify-center"
      >
        <Calendar size={24} />
        {/* 如果有行程，顯示紅點數量 */}
        {plannedEvents.length > 0 && (
          <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border-2 border-white">
            {plannedEvents.length}
          </span>
        )}
      </button>

      {/* 🌟 2. 黑色半透明遮罩 (點擊旁邊也能關閉) */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-sm transition-opacity"
          onClick={toggleSidebar}
        />
      )}

      {/* 🌟 3. 滑出的側邊欄面板（關閉後從 DOM 移除，避免 fixed + translateX(100%) 造成橫向溢出） */}
      {panelMounted && (
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-sm bg-white z-50 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          panelVisible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 面板標題列 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Calendar size={20} className="text-blue-600" />
            我的文化行程
          </h2>
          <div className="flex items-center gap-1">
            {plannedEvents.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm('確定要清除所有已安排的行程嗎？')) {
                    clearPlannedEvents();
                  }
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                title="全部清除"
              >
                <Trash2 size={13} />
                全部清除
              </button>
            )}
            <button onClick={toggleSidebar} className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-colors">
              <X size={18} />
              <span className="text-xs">我再看看</span>
            </button>
          </div>
        </div>

        {/* 新增一天 flash banner */}
        {flashDayAdded && (
          <div className="mx-4 mt-3 flex items-center gap-2 bg-green-50 border border-green-300 text-green-700 text-sm font-bold px-4 py-2.5 rounded-xl animate-pulse shadow-sm">
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            已為您增加一天台東行程！
          </div>
        )}

        {/* 已經加入的活動清單（依天分組） */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-gray-50">
          {plannedEvents.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
              <p>目前還沒有加入任何行程喔！</p>
              <p className="text-sm mt-2">快去首頁探索有趣的活動吧</p>
            </div>
          ) : (
            tripDates.map((dateStr, idx) => {
              const dayEvents = plannedEvents.filter(e => e.assigned_date === dateStr);
              return (
                <div key={dateStr} className="flex flex-col gap-3">
                  {/* Day 分隔線 */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2.5 py-1 rounded-full shrink-0">
                      Day {idx + 1} · {fmtMonthDay(dateStr)}
                    </span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </div>

                  {/* 當日活動或空狀態 */}
                  {dayEvents.length === 0 ? (
                    <div className="text-center text-gray-400 text-sm py-3 bg-white rounded-xl border border-dashed border-gray-200">
                      本日尚無行程
                    </div>
                  ) : (
                    dayEvents.map((event) => (
                      <div key={event.id} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex flex-col gap-2">
                        <div className="flex justify-between items-start">
                          <h3 className="font-bold text-gray-800 text-sm line-clamp-2 pr-4">{event.title}</h3>
                          <button
                            onClick={() => removeEvent(event.id)}
                            className="text-gray-400 hover:text-red-500 transition-colors p-1 shrink-0"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        {event.isExtraDayTrigger && (
                          <a
                            href={event.affiliate_links?.accommodation?.url ?? buildAgodaUrl(tripStartDate || event.assigned_date, addOneDay(tripEndDate || event.assigned_date))}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg w-fit leading-tight hover:bg-amber-100 transition-colors cursor-pointer"
                          >
                            <span>💡</span>
                            <span>多留了一天，記得多訂住宿</span>
                            <ExternalLink size={10} className="shrink-0" />
                          </a>
                        )}
                        {isSidebarExhibition(event) ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1 text-[11px] text-gray-400">
                              <Calendar size={10} className="shrink-0" />
                              <span>展期：{fmtMonthDay(event.start_time)} – {fmtMonthDay(event.end_date!)}</span>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-600 font-medium">
                              <Clock size={11} className="shrink-0 text-violet-400" />
                              <div className="flex-1">
                                <CustomSelect<string>
                                  value={event.assigned_date}
                                  options={buildTripDateOptions(tripStartDate, tripEndDate, event.assigned_date).map(d => ({ value: d, label: formatDayOption(d, tripStartDate || event.assigned_date) }))}
                                  onChange={(val) => {
                                    const [vy, vm, vd] = val.split('-').map(Number);
                                    if (new Date(vy, vm - 1, vd).getDay() === 1) {
                                      const kw = ['藝文中心', '美術館', '圖書館'].find(v => event.venue_name.includes(v));
                                      if (kw) { toast(`⚠️ 注意：該場館 (${kw}) 每週一休館，請選擇其他日期。`); return; }
                                    }
                                    updateEventDate(event.id, val);
                                  }}
                                />
                              </div>
                              {event.visit_time && (
                                <span className="text-[11px] text-gray-400 shrink-0">{fmtVisitTime(event.visit_time)}</span>
                              )}
                            </div>
                          </div>
                        ) : isSingleDayLocked(event) ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="text-xs text-gray-500">
                              {new Date(event.start_time).toLocaleDateString('zh-TW', {
                                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                              })}
                            </div>
                            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md">
                              <Lock size={11} className="shrink-0 opacity-60" />
                              <span>此為單日限定活動，無法更改日期</span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <div className="text-xs text-gray-500">
                              {new Date(event.start_time).toLocaleDateString('zh-TW', {
                                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                              })}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-600 font-medium">
                              <Calendar size={11} className="shrink-0 text-blue-400" />
                              <div className="flex-1">
                                <CustomSelect<string>
                                  value={event.assigned_date}
                                  options={buildTripDateOptions(tripStartDate, tripEndDate, event.assigned_date).map(d => ({ value: d, label: formatDayOption(d, tripStartDate || event.assigned_date) }))}
                                  onChange={(val) => {
                                    const [vy, vm, vd] = val.split('-').map(Number);
                                    if (new Date(vy, vm - 1, vd).getDay() === 1) {
                                      const kw = ['藝文中心', '美術館', '圖書館'].find(v => event.venue_name.includes(v));
                                      if (kw) { toast(`⚠️ 注意：該場館 (${kw}) 每週一休館，請選擇其他日期。`); return; }
                                    }
                                    updateEventDate(event.id, val);
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="text-xs text-blue-600 font-medium bg-blue-50 px-2 py-1 rounded overflow-hidden">
                          <span className="block truncate">{event.venue_name}</span>
                        </div>
                        {event.ticket_url?.startsWith('http') && (
                          <a
                            href={event.ticket_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-md hover:bg-violet-100 transition-colors w-fit"
                          >
                            <ExternalLink size={11} className="opacity-70 shrink-0" />
                            <span>票務資訊</span>
                          </a>
                        )}
                        <div
                          className={[
                            'flex items-center gap-2 mt-1 rounded-lg px-1.5 py-1 transition-all duration-500',
                            event.id === flashEventId ? 'bg-green-50 ring-2 ring-green-400 ring-offset-1' : '',
                          ].join(' ')}
                        >
                          <Clock size={12} className={event.id === flashEventId ? 'text-green-500 shrink-0' : 'text-gray-400 shrink-0'} />
                          <span className={`text-xs shrink-0 ${event.id === flashEventId ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                            {event.id === flashEventId ? '已延長！' : '預計停留'}
                          </span>
                          <CustomSelect<number>
                            value={event.stay_duration ?? 90}
                            options={STAY_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                            onChange={(val) => updateStayDuration(event.id, val)}
                            triggerClassName={event.id === flashEventId
                              ? 'flex-1 w-full flex items-center justify-between rounded-lg px-2 py-1 border border-green-300 text-green-700 bg-green-50 text-xs cursor-pointer font-bold transition-colors hover:border-green-400'
                              : 'flex-1 w-full flex items-center justify-between rounded-lg px-2 py-1 border border-stone-200 text-stone-600 bg-stone-50 text-xs cursor-pointer transition-colors hover:border-stone-400'}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 免責聲明 */}
        <div className="mx-2 mb-2 mt-1 px-4 py-3 bg-slate-50/80 rounded-lg border border-slate-100">
          <p className="text-xs text-slate-500 leading-relaxed text-center font-medium">
            <span className="text-amber-500 mr-1">💡</span>
            本平台資訊由 AI 輔助彙整。實際展演時間、地點、休館日與票務規定，請務必於出發前至官方網站再次確認。
          </p>
        </div>

        {/* 面板底部 */}
        {plannedEvents.length > 0 && (
          <div className="p-4 border-t border-gray-100 bg-white flex flex-col gap-2">
            <Link
              href="/itinerary"
              onClick={toggleSidebar}
              className="block w-full py-3 bg-slate-800 text-white text-center rounded-xl font-bold hover:bg-slate-900 transition-colors shadow-md text-sm"
            >
              下一步：自動安排路線 →
            </Link>
            <button
              onClick={toggleSidebar}
              className="w-full py-2.5 border border-gray-200 text-gray-500 text-sm font-bold rounded-xl hover:bg-gray-50 transition-colors"
            >
              繼續探索活動
            </button>
          </div>
        )}
      </div>
      )} {/* end panelMounted */}
    </>
  );
}