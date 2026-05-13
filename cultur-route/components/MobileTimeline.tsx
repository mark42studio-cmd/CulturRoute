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
import { Clock, MapPin, Calendar, GripVertical, Pencil, ChevronDown } from 'lucide-react';
import EventDetailModal from '@/components/EventDetailModal';
import { useItineraryStore } from '@/store/useItineraryStore';
import type { PlannedEvent } from '@/types';

// ── 演出鎖定判斷（與 EventBrowser.tsx 相同常數）────────────────────────────
const PERFORMANCE_TAGS = ['演出', '表演', '音樂', '音樂會', '演唱會', '舞蹈', '戲劇', '劇場'];
const isPerformance = (e: PlannedEvent) =>
  e.vibe_tags?.some(t => PERFORMANCE_TAGS.some(pt => t.includes(pt))) ?? false;

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
}

function DayDropZone({ dateStr, label, children, itemIds, isEmpty }: DayDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: dateStr,
    data: { type: 'container', dateStr },
  });

  return (
    <div>
      <div className="sticky top-[64px] z-20 bg-[#f8f6f0]/95 backdrop-blur-sm py-2.5 mb-3 border-b border-stone-200">
        <span className="text-sm font-bold text-slate-700">{label}</span>
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
}

function SortableEventCard({ event, index, onOpen, onEditTime }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: event.id,
    data: { type: 'item', dateStr: event.assigned_date, event },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const startHHMM = getStartHHMM(event);
  const endHHMM   = startHHMM
    ? minToHHMM(hhmmToMin(startHHMM) + (event.stay_duration ?? 60))
    : null;

  return (
    <div ref={setNodeRef} style={style} className={`relative mb-3 ${isDragging ? 'opacity-30' : ''}`}>
      {/* 時間軸節點 */}
      <div className="absolute -left-[18px] top-3.5 w-4 h-4 rounded-full bg-slate-700 border-2 border-[#f8f6f0] flex items-center justify-center z-10">
        <span className="text-white text-[9px] font-bold leading-none">{index + 1}</span>
      </div>

      {/* 活動卡片 */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm flex items-stretch overflow-hidden">
        {/* 拖曳把手（左側，touch-none 防止與滑動頁面衝突） */}
        <button
          {...listeners}
          {...attributes}
          className="px-2.5 flex items-center justify-center text-stone-300 hover:text-stone-500 touch-none shrink-0 cursor-grab active:cursor-grabbing border-r border-gray-100"
          aria-label="拖曳排序"
          onClick={e => e.stopPropagation()}
        >
          <GripVertical size={15} />
        </button>

        {/* 主內容區（點擊開啟詳情） */}
        <button
          className="p-3 flex flex-col gap-1 flex-1 min-w-0 text-left"
          onClick={() => onOpen(event)}
        >
          <h3 className="font-bold text-gray-800 text-sm leading-snug line-clamp-2">{event.title}</h3>

          {/* 時間區塊：獨立點擊，不觸發卡片 Modal */}
          {startHHMM && endHHMM && (
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

          {event.venue_name && (
            <div className="flex items-center gap-1 text-[11px] text-stone-400">
              <MapPin size={10} className="shrink-0" />
              <span className="truncate">{event.venue_name}</span>
            </div>
          )}
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
  const { plannedEvents, updateEventDate, updateVisitTime, updateStayDuration } = useItineraryStore();
  const [activeId,         setActiveId]         = useState<UniqueIdentifier | null>(null);
  const [detailEvent,      setDetailEvent]      = useState<PlannedEvent | null>(null);
  const [editingTimeEvent, setEditingTimeEvent] = useState<PlannedEvent | null>(null);

  const handleEditTime = (event: PlannedEvent) => {
    if (isPerformance(event)) {
      toast.error('演出活動為固定時間，無法修改', {
        description: '演出的開始時間由主辦方決定，請依官方時間安排行程。',
      });
      return;
    }
    setEditingTimeEvent(event);
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
      // ── 同天排序：時間槽繼承（與桌機邏輯完全相同）──────────────────────────
      // 原理：把「時間坑位」固定，讓活動重新填入坑位，下次 render 自動按 visit_time 重排。
      const dayEvents = dayEventMap[sourceDate] ?? [];
      const oldIndex  = dayEvents.findIndex(e => e.id === active.id);
      const newIndex  = dayEvents.findIndex(e => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const timeSlots = dayEvents.map(e => getEffectiveSortTime(e)).sort();
      const reordered = arrayMove(dayEvents, oldIndex, newIndex);
      reordered.forEach((e, i) => {
        if (timeSlots[i] !== getEffectiveSortTime(e)) {
          updateVisitTime(e.id, timeSlots[i]);
        }
      });
    } else {
      // ── 跨天移動：演出鎖定防護 ─────────────────────────────────────────────
      if (isPerformance(event)) {
        toast.error('此為限定演出，無法隨意更改日期喔！', {
          description: '演出活動的時間是固定的，請選擇正確的日期加入行程。',
        });
        return;
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
              >
                {dayEvents.map((evt, idx) => (
                  <SortableEventCard
                    key={evt.id}
                    event={evt}
                    index={idx}
                    onOpen={setDetailEvent}
                    onEditTime={handleEditTime}
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
