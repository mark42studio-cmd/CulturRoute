'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useItineraryStore } from '@/store/useItineraryStore';
import { Calendar, X, Trash2, Clock } from 'lucide-react';
import Link from 'next/link';
import type { PlannedEvent } from '@/types';
import { useAffiliateLinks } from '@/hooks/useAffiliateLinks';
import { trackAffiliateClick } from '@/lib/gtag';

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

export default function ItinerarySidebar() {
  const pathname = usePathname();
  const {
    plannedEvents, isSidebarOpen, toggleSidebar,
    removeEvent, updateStayDuration, updateEventDate,
    tripStartDate, tripEndDate,
    flashEventId, flashDayAdded, clearFlash,
  } = useItineraryStore();

  const allLinks = useAffiliateLinks();

  const SIDEBAR_LINK_CONFIG = [
    { key: 'transport',     icon: '🏍️', label: '台東租車 / 租機車', iconBg: 'bg-amber-100'  },
    { key: 'accommodation', icon: '🏨', label: '台東特色住宿',       iconBg: 'bg-blue-100'   },
    { key: 'tickets',       icon: '🎟️', label: '活動購票優惠',       iconBg: 'bg-violet-100' },
  ] as const;

  const HUMOR_SUBTITLES: Record<string, string> = {
    transport:     '請租車，我們沒有山豬可以騎 🐗',
    accommodation: '石板屋不是人人都能住 🏠',
    tickets:       '台東專屬好康的啦！ 🎫',
  };

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
        className="fixed bottom-6 right-6 z-40 bg-blue-600 text-white p-4 rounded-full shadow-lg hover:bg-blue-700 hover:scale-105 transition-all duration-300 flex items-center justify-center"
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

      {/* 🌟 3. 滑出的側邊欄面板 */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-sm bg-white z-50 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          isSidebarOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 面板標題列 */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Calendar size={20} className="text-blue-600" />
            我的文化行程
          </h2>
          <button onClick={toggleSidebar} className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-colors">
            <X size={18} />
            <span className="text-xs">我再看看</span>
          </button>
        </div>

        {/* 新增一天 flash banner */}
        {flashDayAdded && (
          <div className="mx-4 mt-3 flex items-center gap-2 bg-green-50 border border-green-300 text-green-700 text-sm font-bold px-4 py-2.5 rounded-xl animate-pulse shadow-sm">
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            已為您增加一天台東行程！
          </div>
        )}

        {/* 已經加入的活動清單 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50">
          {plannedEvents.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
              <p>目前還沒有加入任何行程喔！</p>
              <p className="text-sm mt-2">快去首頁探索有趣的活動吧</p>
            </div>
          ) : (
            plannedEvents.map((event) => (
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
                {/* 訂房提醒：由「多留一下」合併按鈕加入的活動才顯示 */}
                {event.isExtraDayTrigger && (
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg w-fit leading-tight">
                    💡 多留了一天，記得多訂住宿
                  </div>
                )}
                {isSidebarExhibition(event) ? (
                  /* 展覽：兩行顯示——完整展期 + 選定前往時間 */
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1 text-[11px] text-gray-400">
                      <Calendar size={10} className="shrink-0" />
                      <span>展期：{fmtMonthDay(event.start_time)} – {fmtMonthDay(event.end_date!)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-600 font-medium">
                      <Clock size={11} className="shrink-0 text-violet-400" />
                      <div className="relative flex-1">
                        <select
                          value={event.assigned_date}
                          onChange={(e) => updateEventDate(event.id, e.target.value)}
                          className="w-full appearance-none text-xs rounded-lg px-2 py-1 pr-6 text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-400 focus:border-blue-500 outline-none cursor-pointer transition-colors"
                        >
                          {buildTripDateOptions(tripStartDate, tripEndDate, event.assigned_date).map(d => (
                            <option key={d} value={d}>{formatDayOption(d, tripStartDate || event.assigned_date)}</option>
                          ))}
                        </select>
                        <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                      {event.visit_time && (
                        <span className="text-[11px] text-gray-400 shrink-0">{fmtVisitTime(event.visit_time)}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  /* 單次活動：活動日期 + 預計前往選擇器 */
                  <div className="flex flex-col gap-0.5">
                    <div className="text-xs text-gray-500">
                      {new Date(event.start_time).toLocaleDateString('zh-TW', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-600 font-medium">
                      <Calendar size={11} className="shrink-0 text-blue-400" />
                      <div className="relative flex-1">
                        <select
                          value={event.assigned_date}
                          onChange={(e) => updateEventDate(event.id, e.target.value)}
                          className="w-full appearance-none text-xs rounded-lg px-2 py-1 pr-6 text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-400 focus:border-blue-500 outline-none cursor-pointer transition-colors"
                        >
                          {buildTripDateOptions(tripStartDate, tripEndDate, event.assigned_date).map(d => (
                            <option key={d} value={d}>{formatDayOption(d, tripStartDate || event.assigned_date)}</option>
                          ))}
                        </select>
                        <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    </div>
                  </div>
                )}
                <div className="text-xs text-blue-600 font-medium line-clamp-1 bg-blue-50 px-2 py-1 rounded w-fit">
                  {event.venue_name}
                </div>
                {/* 預計停留時間選擇器（多留一下觸發時顯示綠色動畫） */}
                <div
                  className={[
                    'flex items-center gap-2 mt-1 rounded-lg px-1.5 py-1 transition-all duration-500',
                    event.id === flashEventId
                      ? 'bg-green-50 ring-2 ring-green-400 ring-offset-1'
                      : '',
                  ].join(' ')}
                >
                  <Clock size={12} className={event.id === flashEventId ? 'text-green-500 shrink-0' : 'text-gray-400 shrink-0'} />
                  <span className={`text-xs shrink-0 ${event.id === flashEventId ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                    {event.id === flashEventId ? '已延長！' : '預計停留'}
                  </span>
                  <select
                    value={event.stay_duration ?? 90}
                    onChange={(e) => updateStayDuration(event.id, Number(e.target.value))}
                    className={[
                      'flex-1 text-xs rounded-lg px-2 py-1 outline-none cursor-pointer transition-colors',
                      event.id === flashEventId
                        ? 'text-green-700 bg-green-50 border border-green-300 font-bold focus:border-green-500'
                        : 'text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-400 focus:border-blue-500',
                    ].join(' ')}
                  >
                    {STAY_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))
          )}

          {/* 旅行推薦區塊：有活動時永遠顯示，URL 未設定時呈現 disabled 佔位 */}
          {plannedEvents.length > 0 && (
            <div className="mt-2 rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">出發前搞定這些</p>
              <div className="flex flex-col gap-3">
                {SIDEBAR_LINK_CONFIG.map(cfg => {
                  const dbLink = allLinks.find(l => l.key === cfg.key);
                  const url = dbLink?.url;
                  const label = dbLink?.label ?? cfg.label;
                  const humor = HUMOR_SUBTITLES[cfg.key];
                  if (url) {
                    return (
                      <a
                        key={cfg.key}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => trackAffiliateClick(cfg.key, label, url)}
                        className="group flex flex-row items-center p-3 bg-white border border-gray-100 rounded-xl hover:shadow-sm transition-all duration-200"
                      >
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-base ${cfg.iconBg}`}>{cfg.icon}</div>
                        <div className="flex flex-col ml-3 text-left flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-800 leading-tight">{label}</p>
                          <p className="text-xs text-gray-500 leading-snug mt-0.5 whitespace-normal break-words">{humor}</p>
                        </div>
                        <svg className="ml-2 shrink-0 text-gray-300 group-hover:text-blue-500 transition-colors" width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2.5 9.5L9.5 2.5M9.5 2.5H4.5M9.5 2.5V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </a>
                    );
                  }
                  return (
                    <div key={cfg.key} className="flex flex-row items-center p-3 bg-white border border-gray-100 rounded-xl opacity-50 cursor-not-allowed">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-base ${cfg.iconBg}`}>{cfg.icon}</div>
                      <div className="flex flex-col ml-3 text-left flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-800 leading-tight">{cfg.label}</p>
                        <p className="text-xs text-gray-400 leading-snug mt-0.5 whitespace-normal break-words">{humor}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
    </>
  );
}