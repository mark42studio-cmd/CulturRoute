'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { Clock, MapPin, Calendar, GripVertical, Pencil, ChevronDown, X, Trash2, Plus, Lock, AlertTriangle } from 'lucide-react';
import EventDetailModal from '@/components/EventDetailModal';
import { useItineraryStore } from '@/store/useItineraryStore';
import type { PlannedEvent } from '@/types';

const isFixedEvent = (e: PlannedEvent): boolean =>
  e.category !== '展覽' || e.time_type === '單日活動';

const isExhibition = (e: PlannedEvent): boolean => e.category === '展覽';

const EXHIBITION_TIME_OPTIONS = [
  '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
];

// ── ExhibitionTimePicker：展覽專屬「我打算幾點去？」選單 ──────────────────────

interface ExhibitionTimePickerProps {
  eventId: string;
  currentTime?: string;
  onUpdateVisitTime: (id: string, time: string) => void;
}

function ExhibitionTimePicker({ eventId, currentTime, onUpdateVisitTime }: ExhibitionTimePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        id="tour-exhibition-time-btn"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-600 bg-violet-50 border border-violet-100 rounded-md px-2 py-0.5 cursor-pointer hover:bg-violet-100 active:bg-violet-200 transition-colors"
        aria-label="設定參觀時間"
      >
        <Clock size={10} className="shrink-0" />
        <span>{currentTime ? `${currentTime} 前往` : '我打算幾點去？'}</span>
        <ChevronDown size={9} className="text-violet-400 shrink-0" />
      </button>
      {open && (
        <ul className="absolute bottom-full left-0 mb-1.5 z-50 bg-white border border-stone-200 rounded-xl shadow-lg py-1 min-w-[110px]">
          {EXHIBITION_TIME_OPTIONS.map(t => (
            <li
              key={t}
              onClick={() => { onUpdateVisitTime(eventId, t); setOpen(false); }}
              className={`px-3 py-2 text-xs font-mono cursor-pointer transition-colors ${
                t === currentTime
                  ? 'bg-violet-50 text-violet-700 font-semibold'
                  : 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'
              }`}
            >
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const calculateTimeOverlaps = (events: PlannedEvent[]): Set<string> => {
  const overlapping = new Set<string>();
  const getRange = (e: PlannedEvent): [number, number] | null => {
    const start = getStartHHMM(e);
    if (!start) return null;
    const s = hhmmToMin(start);
    return [s, s + (e.stay_duration ?? 60)];
  };
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = getRange(events[i]);
      const b = getRange(events[j]);
      if (!a || !b) continue;
      if (a[0] < b[1] && a[1] > b[0]) {
        overlapping.add(events[i].id);
        overlapping.add(events[j].id);
      }
    }
  }
  return overlapping;
};

// ── 時間工具（與 itinerary/page.tsx 邏輯相同）────────────────────────────────

function toTaipeiHHMM(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '00:00';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  return `${parts.find(p => p.type === 'hour')?.value ?? '00'}:${parts.find(p => p.type === 'minute')?.value ?? '00'}`;
}

function getEffectiveSortTime(event: PlannedEvent): string {
  if (event.visit_time) return event.visit_time;
  if (event.start_time) return toTaipeiHHMM(event.start_time);
  return '00:00';
}

function getStartHHMM(event: PlannedEvent): string | null {
  if (event.visit_time) return event.visit_time;
  if (!event.start_time) return null;
  const t = toTaipeiHHMM(event.start_time);
  return t === '00:00' ? null : t;
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── DayDropZone ──────────────────────────────────────────────────────────────

interface DayDropZoneProps {
  dateStr: string;
  label: string;
  children: React.ReactNode;
  itemIds: string[];
  isEmpty: boolean;
  onRemove: () => void;
}

function DayDropZone({ dateStr, label, children, itemIds, isEmpty, onRemove }: DayDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: dateStr,
    data: { type: 'container', dateStr },
  });

  return (
    <div>
      <div className="sticky top-[64px] z-20 bg-[#f8f6f0]/95 backdrop-blur-sm py-2.5 mb-3 border-b border-stone-200 flex justify-between items-center">
        <span className="text-sm font-bold text-slate-700">{label}</span>
        <button
          onClick={onRemove}
          className="text-stone-300 hover:text-red-400 transition-colors cursor-pointer p-1"
          aria-label="刪除此天"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <SortableContext id={dateStr} items={itemIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={[
            'min-h-[56px] rounded-xl transition-all duration-150 pl-7 relative',
            'before:absolute before:left-2.5 before:top-0 before:bottom-0 before:w-0.5 before:rounded-full',
            isOver
              ? 'bg-teal-50/60 ring-2 ring-teal-400 ring-inset before:bg-teal-300'
              : 'before:bg-slate-200',
          ].join(' ')}
        >
          {isEmpty && (
            <p className={`text-xs italic pl-2 py-3 transition-colors ${isOver ? 'text-teal-500 font-medium' : 'text-stone-400'}`}>
              {isOver ? '放開以加入此天 ✨' : '留白的一天 ☁️'}
            </p>
          )}
          {children}
        </div>
      </SortableContext>
    </div>
  );
}

// ── SortableEventCard ─────────────────────────────────────────────────────────

interface CardProps {
  event: PlannedEvent;
  index: number;
  onOpen: (event: PlannedEvent) => void;
  onEditTime: (event: PlannedEvent) => void;
  onRemove: (id: string) => void;
  onUpdateVisitTime: (id: string, time: string) => void;
  isConflicting: boolean;
}

function SortableEventCard({ event, index, onOpen, onEditTime, onRemove, onUpdateVisitTime, isConflicting }: CardProps) {
  const fixed  = isFixedEvent(event);
  const exhib  = isExhibition(event);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: event.id,
    data: { type: 'item', dateStr: event.assigned_date, event },
    disabled: fixed,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const startHHMM = getStartHHMM(event);
  const endHHMM   = startHHMM
    ? minToHHMM(hhmmToMin(startHHMM) + (event.stay_duration ?? 60))
    : null;
  const openingHours = exhib
    ? (event.opening_hours
        ?? (event.end_time
          ? `${toTaipeiHHMM(event.start_time)} - ${toTaipeiHHMM(event.end_time)}`
          : null))
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative mb-3 planned-event-card ${isDragging ? 'opacity-30' : ''} ${exhib ? 'tour-exhibition-card' : 'tour-fixed-event-card'}`}
    >
      {/* 時間軸節點 */}
      <div className="absolute -left-[18px] top-3.5 w-4 h-4 rounded-full bg-slate-700 border-2 border-[#f8f6f0] flex items-center justify-center z-10">
        <span className="text-white text-[9px] font-bold leading-none">{index + 1}</span>
      </div>

      {/* 活動卡片 */}
      <div className={`relative bg-white rounded-xl border shadow-sm flex items-stretch ${isConflicting ? 'border-rose-300' : 'border-gray-100'}`}>
        {/* 拖曳把手 / 鎖定圖示 */}
        {fixed ? (
          <div className="px-2.5 flex items-center justify-center text-stone-200 shrink-0 border-r border-gray-100 cursor-not-allowed" aria-label="固定活動，無法拖曳">
            <Lock size={15} />
          </div>
        ) : (
          <button
            {...listeners}
            {...attributes}
            className="px-2.5 flex items-center justify-center text-stone-300 hover:text-stone-500 touch-none shrink-0 cursor-grab active:cursor-grabbing border-r border-gray-100"
            aria-label="拖曳排序"
            onClick={e => e.stopPropagation()}
          >
            <GripVertical size={15} />
          </button>
        )}

        {/* 主內容區（點擊開啟詳情） */}
        <div
          role="button"
          tabIndex={0}
          className="p-3 pr-7 flex flex-col gap-1 flex-1 min-w-0 text-left cursor-pointer"
          onClick={() => onOpen(event)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpen(event); }}
        >
          <h3 className="font-bold text-gray-800 text-sm leading-snug line-clamp-2">{event.title}</h3>

          {/* 展覽：開放時間 + 「我打算幾點去？」選單，選擇後自動插隊排序 */}
          {exhib && (
            <>
              {openingHours && (
                <span className="inline-flex items-center gap-1 text-[11px] text-stone-400 font-mono">
                  <Clock size={10} className="shrink-0" />
                  <span>開放時間：{openingHours}</span>
                </span>
              )}
              <ExhibitionTimePicker
                eventId={event.id}
                currentTime={event.visit_time}
                onUpdateVisitTime={onUpdateVisitTime}
              />
            </>
          )}

          {/* 固定活動：可點擊修改預計抵達時間 */}
          {!exhib && startHHMM && endHHMM && (
            <span
              role="button"
              tabIndex={0}
              onClick={e => { e.stopPropagation(); onEditTime(event); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onEditTime(event); } }}
              className="inline-flex items-center gap-1 text-[11px] text-teal-600 font-mono cursor-pointer rounded px-1 -mx-1 hover:bg-teal-50 active:bg-teal-100 transition-colors group/time"
            >
              <Clock size={10} className="shrink-0" />
              <span>{startHHMM} – {endHHMM}</span>
              <Pencil size={9} className="shrink-0 opacity-0 group-hover/time:opacity-60 transition-opacity" />
            </span>
          )}

          {isConflicting && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-rose-600 bg-rose-50 border border-rose-100 rounded px-1.5 py-0.5">
              <AlertTriangle size={10} className="shrink-0" />
              <span>⚠️ 與今日其他行程時間重疊</span>
            </div>
          )}
          {event.venue_name && (
            <div className="flex items-center gap-1 text-[11px] text-stone-400">
              <MapPin size={10} className="shrink-0" />
              <span className="truncate">{event.venue_name}</span>
            </div>
          )}
        </div>

        {/* 刪除按鈕 */}
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(event.id); }}
          className="absolute top-2 right-2 text-stone-300 hover:text-red-500 transition-colors p-1"
          aria-label="移除活動"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ── TimeSelect：完全客製化的下拉選單（捨棄 <select>，消除原生藍色樣式）──────

const HOURS   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

const snapMin = (m: string) => {
  const n = Math.round(parseInt(m, 10) / 5) * 5;
  return String(n >= 60 ? 0 : n).padStart(2, '0');
};

interface TimeSelectProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}

function TimeSelect({ value, options, onChange }: TimeSelectProps) {
  const [isOpen,       setIsOpen]       = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef      = useRef<HTMLUListElement>(null);

  // 點擊外部關閉
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [isOpen]);

  // 展開時把已選項目捲入視野
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative flex-1">
      {/* 觸發按鈕 */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className={[
          'w-full flex items-center justify-center gap-1.5',
          'border rounded-xl px-3 py-2.5 text-sm font-mono transition-colors',
          isOpen
            ? 'border-stone-400 bg-stone-50 text-stone-800'
            : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300',
        ].join(' ')}
      >
        <span>{value}</span>
        <ChevronDown
          size={12}
          className={`text-stone-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 浮動選單面板（向上展開，避免被底部 safe-area 遮擋） */}
      {isOpen && (
        <ul
          ref={listRef}
          className="absolute bottom-full left-0 right-0 mb-1.5 z-50 bg-white border border-stone-200 rounded-xl shadow-lg max-h-48 overflow-y-auto scrollbar-hide"
        >
          {options.map(opt => (
            <li
              key={opt}
              data-selected={opt === value}
              onClick={() => { onChange(opt); setIsOpen(false); }}
              className={[
                'px-4 py-2.5 text-sm font-mono text-center cursor-pointer transition-colors',
                opt === value
                  ? 'bg-stone-50 text-stone-900 font-medium'
                  : 'text-stone-500 hover:bg-stone-100 hover:text-stone-900',
              ].join(' ')}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── TimePicker：小時 + 分鐘兩個 TimeSelect 並排 ──────────────────────────────

interface TimePickerProps {
  label: string;
  hour: string;
  minute: string;
  onHourChange: (h: string) => void;
  onMinuteChange: (m: string) => void;
}

function TimePicker({ label, hour, minute, onHourChange, onMinuteChange }: TimePickerProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium text-stone-400 uppercase tracking-[0.18em]">{label}</span>
      <div className="flex items-center gap-2">
        <TimeSelect value={hour}   options={HOURS}   onChange={onHourChange}   />
        <span className="text-stone-300 font-mono text-lg leading-none select-none shrink-0">:</span>
        <TimeSelect value={minute} options={MINUTES} onChange={onMinuteChange} />
      </div>
    </div>
  );
}

// ── TimeEditSheet：手機版修改時間的底部抽屜 ──────────────────────────────────

interface TimeEditSheetProps {
  event: PlannedEvent;
  onClose: () => void;
  updateVisitTime: (id: string, time: string) => void;
  updateStayDuration: (id: string, minutes: number) => void;
}

function TimeEditSheet({ event, onClose, updateVisitTime, updateStayDuration }: TimeEditSheetProps) {
  const rawStart = getStartHHMM(event) ?? '09:00';
  const rawEnd   = minToHHMM(hhmmToMin(rawStart) + (event.stay_duration ?? 60));

  // 拆解成 HH / MM，MM snap 到 5 分鐘格
  const [startH, setStartH] = useState(rawStart.split(':')[0]);
  const [startM, setStartM] = useState(snapMin(rawStart.split(':')[1] ?? '00'));
  const [endH,   setEndH]   = useState(rawEnd.split(':')[0]);
  const [endM,   setEndM]   = useState(snapMin(rawEnd.split(':')[1] ?? '00'));
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    setTimeout(onClose, 280);
  };

  const handleConfirm = () => {
    const newStart   = `${startH}:${startM}`;
    const newEnd     = `${endH}:${endM}`;
    const startTotal = hhmmToMin(newStart);
    const endTotal   = hhmmToMin(newEnd);
    const duration   = endTotal > startTotal ? endTotal - startTotal : 60;
    updateVisitTime(event.id, newStart);
    updateStayDuration(event.id, duration);
    handleClose();
  };

  return (
    <div className="fixed inset-0 z-50" onClick={handleClose}>
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-[280ms]"
        style={{ opacity: isOpen ? 1 : 0 }}
      />

      {/* 抽屜本體 */}
      <div
        className="absolute inset-x-0 bottom-0 bg-white rounded-t-3xl shadow-2xl transition-transform duration-[280ms] ease-out"
        style={{ transform: isOpen ? 'translateY(0)' : 'translateY(100%)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 把手 */}
        <div className="flex justify-center pt-3.5 pb-2">
          <div className="w-8 h-0.5 bg-stone-200 rounded-full" />
        </div>

        <div className="px-6 pt-1 pb-6">
          {/* 活動名稱 */}
          <p className="text-[10px] font-medium text-stone-400 uppercase tracking-[0.18em] mb-1">編輯時間</p>
          <h2 className="text-base font-medium text-stone-800 leading-snug line-clamp-2 mb-6">{event.title}</h2>

          {/* 時間選擇器並排 */}
          <div className="grid grid-cols-2 gap-5 mb-7">
            <TimePicker
              label="開始"
              hour={startH} minute={startM}
              onHourChange={setStartH} onMinuteChange={setStartM}
            />
            <TimePicker
              label="結束"
              hour={endH} minute={endM}
              onHourChange={setEndH} onMinuteChange={setEndM}
            />
          </div>

          {/* 行：取消（左）+ 確認（右） */}
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="flex-1 py-3 rounded-xl border border-stone-200 text-stone-500 text-sm hover:bg-stone-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              className="flex-1 py-3 rounded-xl bg-stone-900 hover:bg-stone-700 active:bg-stone-800 text-white text-sm font-medium transition-colors"
            >
              確認
            </button>
          </div>
        </div>

        {/* iPhone home bar safe area */}
        <div style={{ height: 'env(safe-area-inset-bottom)' }} />
      </div>
    </div>
  );
}

// ── DragOverlay 浮動卡片（跟著手指移動）─────────────────────────────────────

function FloatingCard({ event }: { event: PlannedEvent }) {
  const startHHMM = getStartHHMM(event);
  const endHHMM   = startHHMM
    ? minToHHMM(hhmmToMin(startHHMM) + (event.stay_duration ?? 60))
    : null;

  return (
    <div className="bg-white rounded-xl border border-teal-200 shadow-2xl p-3.5 rotate-1 scale-[1.04] flex gap-2.5 items-stretch max-w-[85vw]">
      <div className="w-0.5 bg-teal-400 rounded-full shrink-0" />
      <div className="flex flex-col gap-1 min-w-0">
        <h3 className="font-bold text-gray-800 text-sm leading-snug line-clamp-2">{event.title}</h3>
        {startHHMM && endHHMM && (
          <div className="flex items-center gap-1 text-[11px] text-teal-600 font-mono">
            <Clock size={10} className="shrink-0" />
            <span>{startHHMM} – {endHHMM}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── MobileTimeline 主元件 ─────────────────────────────────────────────────────

interface MobileTimelineProps {
  sortedDates: string[];
  formatTabLabel: (dateStr: string, index: number) => string;
}

export default function MobileTimeline({ sortedDates, formatTabLabel }: MobileTimelineProps) {
  const {
    plannedEvents, updateEventDate, updateVisitTime, updateStayDuration, removeEvent,
    addTripDay, prependTripDay, removeTripDay, tripStartDate, tripEndDate,
  } = useItineraryStore();
  const [activeId,         setActiveId]         = useState<UniqueIdentifier | null>(null);
  const [detailEvent,      setDetailEvent]      = useState<PlannedEvent | null>(null);
  const [editingTimeEvent, setEditingTimeEvent] = useState<PlannedEvent | null>(null);

  const handleEditTime = (event: PlannedEvent) => {
    if (isFixedEvent(event)) {
      toast('此為固定活動，時間無法修改', {
        description: '活動時間由主辦方決定，請依官方公告安排行程。',
      });
      return;
    }
    setEditingTimeEvent(event);
  };

  const handleRemoveDay = (dateStr: string) => {
    const dayEvents = dayEventMap[dateStr] ?? [];
    if (dayEvents.length > 0) {
      toast('請先清空該日活動再刪除天數');
      return;
    }
    const isFirst = sortedDates[0] === dateStr;
    const isLast  = sortedDates[sortedDates.length - 1] === dateStr;
    if (!isFirst && !isLast) {
      toast('僅能移除行程的第一天或最後一天');
      return;
    }
    removeTripDay(dateStr);
    toast('✓ 已刪除該天行程');
  };

  const handleAddDay = () => {
    if (!tripEndDate) return;
    addTripDay();
    toast('✓ 已成功延長一天行程');
  };

  const handlePrependDay = () => {
    if (!tripStartDate) return;
    prependTripDay();
    toast('✓ 已為您提前一天行程');
  };

  const sensors = useSensors(
    // 手機：長按 250ms 後才觸發拖曳，tolerance 5px 允許微小手指移動而不誤觸
    useSensor(TouchSensor,   { activationConstraint: { delay: 250, tolerance: 5 } }),
    // 桌機 fallback：拖移超過 8px 才觸發
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // 每天依有效排序時間升序排列（與桌機邏輯相同）
  const dayEventMap = useMemo(() => {
    const map: Record<string, PlannedEvent[]> = {};
    for (const dateStr of sortedDates) {
      map[dateStr] = plannedEvents
        .filter(e => e.assigned_date === dateStr)
        .sort((a, b) => getEffectiveSortTime(a).localeCompare(getEffectiveSortTime(b)));
    }
    return map;
  }, [plannedEvents, sortedDates]);

  const activeEvent = activeId ? (plannedEvents.find(e => e.id === activeId) ?? null) : null;

  // 跨天時間重疊偵測：每天獨立計算，合併成全局 Set
  const overlapSet = useMemo(() => {
    const result = new Set<string>();
    for (const dateStr of sortedDates) {
      const dayEvents = dayEventMap[dateStr] ?? [];
      const overlaps = calculateTimeOverlaps(dayEvents);
      overlaps.forEach(id => result.add(id));
    }
    return result;
  }, [dayEventMap, sortedDates]);

  // 從 over 取得目標日期：可能是 container droppable 或 sortable item 所屬的 SortableContext id
  function getTargetDate(over: DragEndEvent['over']): string | undefined {
    if (!over) return undefined;
    const d = over.data.current as Record<string, unknown> | undefined;
    if (d?.type === 'container') return String(over.id);
    // SortableContext 的 id 存在 sortable.containerId
    const containerId = (d?.sortable as { containerId?: string } | undefined)?.containerId;
    return containerId ?? (d?.dateStr as string | undefined);
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over) return;

    const event = plannedEvents.find(e => e.id === active.id);
    if (!event) return;

    const sourceDate = (active.data.current as Record<string, unknown>)?.dateStr as string;
    const targetDate = getTargetDate(over);
    if (!targetDate) return;

    if (sourceDate === targetDate) {
      // ── 同天排序：時間槽繼承（僅對展覽類活動重排，固定活動時間不可被覆蓋）──
      const dayEvents = dayEventMap[sourceDate] ?? [];
      const oldIndex  = dayEvents.findIndex(e => e.id === active.id);
      const newIndex  = dayEvents.findIndex(e => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      // 只收集展覽（可拖曳）的時間槽做重排，固定活動保持 start_time 不動
      const flexSlots = dayEvents
        .filter(e => !isFixedEvent(e))
        .map(e => getEffectiveSortTime(e))
        .sort();

      const reordered = arrayMove(dayEvents, oldIndex, newIndex);
      let slotIdx = 0;
      reordered.forEach(e => {
        if (isFixedEvent(e)) return;
        const newSlot = flexSlots[slotIdx++];
        if (newSlot !== getEffectiveSortTime(e)) {
          updateVisitTime(e.id, newSlot);
        }
      });
    } else {
      // ── 跨天移動：固定活動鎖定防護 ────────────────────────────────────────
      if (isFixedEvent(event)) {
        toast('此為固定活動，無法更改日期！', {
          description: '此活動時間由主辦方決定，請選擇正確的日期加入行程。',
        });
        return;
      }
      // ── 展覽邊界防護：只能排入展期內的日期 ──────────────────────────────
      if (isExhibition(event)) {
        const exhibStart = event.start_time.slice(0, 10);
        const exhibEnd   = event.end_date ?? event.end_time?.slice(0, 10);
        if (targetDate < exhibStart) {
          const [, sm, sd] = exhibStart.split('-');
          const [, tm, td] = targetDate.split('-');
          toast(`⚠️ 展覽尚未開始，無法排入 ${parseInt(tm)}月${parseInt(td)}日`, {
            description: `此展覽展期自 ${parseInt(sm)}月${parseInt(sd)}日起。`,
          });
          return;
        }
        if (exhibEnd && targetDate > exhibEnd) {
          const [, em, ed] = exhibEnd.split('-');
          const [, tm, td] = targetDate.split('-');
          toast(`⚠️ 此展覽展期僅至 ${parseInt(em)}月${parseInt(ed)}日，無法排入 ${parseInt(tm)}月${parseInt(td)}日`);
          return;
        }
      }
      updateEventDate(String(active.id), targetDate);
    }
  }

  // 空狀態
  if (plannedEvents.length === 0) {
    return (
      <div className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-gray-200">
        <div className="w-12 h-12 bg-gray-50 text-gray-400 rounded-full flex items-center justify-center mx-auto mb-3">
          <Calendar size={24} />
        </div>
        <h2 className="text-sm font-bold text-gray-600 mb-1">☁️ 留白，是台東最美的行程</h2>
        <p className="text-xs text-gray-400 leading-relaxed">從首頁探索活動，點擊 + 加入行程吧！</p>
      </div>
    );
  }

  return (
    <>
      {/* 提前一天 */}
      {tripStartDate && (
        <button
          onClick={handlePrependDay}
          className="w-full mb-6 py-3 flex items-center justify-center gap-2 border-2 border-dashed border-stone-200 rounded-xl text-stone-400 hover:text-stone-600 hover:border-stone-300 hover:bg-stone-50 transition-all cursor-pointer"
        >
          <Plus size={15} />
          <span className="text-sm">提前一天</span>
        </button>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-col gap-5 mb-2">
          {sortedDates.map((dateStr, dayIndex) => {
            const dayEvents = dayEventMap[dateStr] ?? [];
            const itemIds   = dayEvents.map(e => e.id);
            return (
              <DayDropZone
                key={dateStr}
                dateStr={dateStr}
                label={formatTabLabel(dateStr, dayIndex)}
                itemIds={itemIds}
                isEmpty={dayEvents.length === 0}
                onRemove={() => handleRemoveDay(dateStr)}
              >
                {dayEvents.map((evt, idx) => (
                  <SortableEventCard
                    key={evt.id}
                    event={evt}
                    index={idx}
                    onOpen={setDetailEvent}
                    onEditTime={handleEditTime}
                    onRemove={removeEvent}
                    onUpdateVisitTime={updateVisitTime}
                    isConflicting={overlapSet.has(evt.id)}
                  />
                ))}
              </DayDropZone>
            );
          })}
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
          {activeEvent && <FloatingCard event={activeEvent} />}
        </DragOverlay>
      </DndContext>

      {/* 新增一天 */}
      {tripEndDate && (
        <button
          onClick={handleAddDay}
          className="w-full mt-6 py-3 flex items-center justify-center gap-2 border-2 border-dashed border-stone-200 rounded-xl text-stone-400 hover:text-stone-600 hover:border-stone-300 hover:bg-stone-50 transition-all cursor-pointer"
        >
          <Plus size={15} />
          <span className="text-sm">新增一天</span>
        </button>
      )}

      {/* 活動詳情 Bottom Sheet（手機）/ Modal（桌機） */}
      {detailEvent && (
        <EventDetailModal
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
        />
      )}

      {/* 修改時間抽屜 */}
      {editingTimeEvent && (
        <TimeEditSheet
          event={editingTimeEvent}
          onClose={() => setEditingTimeEvent(null)}
          updateVisitTime={updateVisitTime}
          updateStayDuration={updateStayDuration}
        />
      )}
    </>
  );
}
