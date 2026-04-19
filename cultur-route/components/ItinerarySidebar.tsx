'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useItineraryStore } from '@/store/useItineraryStore';
import { Calendar, X, Trash2, Clock } from 'lucide-react';
import Link from 'next/link';
import type { PlannedEvent } from '@/types';

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
    removeEvent, updateStayDuration,
    flashEventId, flashDayAdded, clearFlash,
  } = useItineraryStore();

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
          <button onClick={toggleSidebar} className="p-2 text-gray-400 hover:bg-gray-100 rounded-full transition-colors">
            <X size={20} />
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
                      <span>
                        預計前往：{fmtMonthDay(event.assigned_date)}
                        {event.visit_time ? `　${fmtVisitTime(event.visit_time)}` : ''}
                      </span>
                    </div>
                  </div>
                ) : (
                  /* 單次活動：維持原有單行格式 */
                  <div className="text-xs text-gray-500">
                    {new Date(event.start_time).toLocaleDateString('zh-TW', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
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
        </div>

        {/* 別忘了在檔案最上面確認有 import Link from 'next/link'; */}

        {/* 面板底部 */}
        {plannedEvents.length > 0 && (
          <div className="p-6 border-t border-gray-100 bg-white">
            {/* 🌟 改成 Link，並設定點擊後自動關閉側邊欄 */}
            <Link 
              href="/itinerary" 
              onClick={toggleSidebar}
              className="block w-full py-3 bg-slate-800 text-white text-center rounded-xl font-bold hover:bg-slate-900 transition-colors shadow-md"
            >
              下一步：自動安排路線 →
            </Link>
          </div>
        )}
      </div>
    </>
  );
}