'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { DayPicker, type DateRange, type DayButtonProps } from 'react-day-picker';
import { zhTW } from 'react-day-picker/locale';
import { format } from 'date-fns';
import { CalendarDays } from 'lucide-react';

type Props = {
  startDate: string;  // YYYY-MM-DD or ''
  endDate: string;    // YYYY-MM-DD or ''
  onSelect: (start: string, end: string) => void;
};

// Construct a local Date without UTC offset issues
function toDate(str: string): Date | undefined {
  if (!str) return undefined;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatLabel(from?: Date, to?: Date): string {
  if (!from) return '請選擇預計停留日期';
  const f = (d: Date) => format(d, 'M月d日');
  if (!to) return `${f(from)} 起，選擇離開日期…`;
  return format(from, 'yyyy-MM-dd') === format(to, 'yyyy-MM-dd')
    ? `${f(from)}（當天往返）`
    : `${f(from)} — ${f(to)}`;
}

// Defined outside component to avoid reference identity churn on every render
function RangeDayButton({ modifiers, ...props }: DayButtonProps) {
  const base =
    'w-9 h-9 flex items-center justify-center rounded-full text-sm transition-colors focus:outline-none';
  let extra: string;

  if (modifiers.range_start || modifiers.range_end || modifiers.selected) {
    extra = 'bg-stone-900 text-white hover:bg-stone-800 cursor-pointer';
  } else if (modifiers.range_middle) {
    extra = 'bg-transparent text-stone-900 hover:bg-stone-200 cursor-pointer rounded-none';
  } else if (modifiers.disabled) {
    extra = 'text-stone-300 cursor-not-allowed';
  } else if (modifiers.outside) {
    extra = 'text-stone-300 opacity-50 cursor-pointer';
  } else if (modifiers.today) {
    extra =
      'font-bold underline decoration-stone-300 underline-offset-4 hover:bg-stone-100 cursor-pointer text-stone-900';
  } else {
    extra = 'hover:bg-stone-100 text-stone-800 cursor-pointer';
  }

  return <button {...props} className={`${base} ${extra}`} />;
}

export default function DateRangePicker({ startDate, endDate, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  // In-progress range while calendar is actively open for picking.
  // When the picker is closed, we derive the range directly from props instead.
  const [pickerRange, setPickerRange] = useState<DateRange | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Authoritative range computed directly from props — always reflects the latest
  // store state, including external updates like auto-extension.
  const committedRange = useMemo<DateRange>(
    () => ({ from: toDate(startDate), to: toDate(endDate) }),
    [startDate, endDate],
  );

  // Calendar shows the in-progress pick while open; committed range otherwise.
  const range = open && pickerRange !== undefined ? pickerRange : committedRange;

  const closePicker = () => {
    setOpen(false);
    setPickerRange(undefined);
  };

  const openPicker = () => {
    // Initialise picker from the current committed range so the calendar
    // shows the correct selection on open.
    setPickerRange({ from: toDate(startDate), to: toDate(endDate) });
    setOpen(true);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePicker();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSelect = (r: DateRange | undefined, triggerDate: Date) => {
    // ── Same-day (round-trip) path ──────────────────────────────────────────
    // With min=1, re-clicking 'from' while 'to' is pending causes the library
    // to clear the selection (returns undefined). Treat as a deliberate
    // same-day round-trip selection.
    if (!r) {
      const d = format(triggerDate, 'yyyy-MM-dd');
      setPickerRange({ from: triggerDate, to: triggerDate });
      onSelect(d, d);
      setTimeout(() => closePicker(), 300);
      return;
    }

    setPickerRange(r);
    const { from, to } = r;

    if (!from) {
      onSelect('', '');
      return;
    }

    const fromStr = format(from, 'yyyy-MM-dd');
    const toStr   = to ? format(to, 'yyyy-MM-dd') : '';
    onSelect(fromStr, toStr);

    // ── Complete range path ─────────────────────────────────────────────────
    if (to) {
      setTimeout(() => closePicker(), 300);
    }
    // If only 'from' is set, calendar stays open for the second pick.
  };

  const hasSelection = !!range?.from;

  // Half-gradient on endpoint cells only applies to multi-day ranges.
  const hasMultiDay = !!(
    range?.from &&
    range?.to &&
    format(range.from, 'yyyy-MM-dd') !== format(range.to, 'yyyy-MM-dd')
  );

  const gradientR = '[background:linear-gradient(to_right,transparent_50%,var(--color-stone-100,#f5f5f4)_50%)]';
  const gradientL = '[background:linear-gradient(to_left,transparent_50%,var(--color-stone-100,#f5f5f4)_50%)]';

  return (
    <div ref={containerRef} className="relative w-full">
      {/* ── Trigger Button ── */}
      <button
        onClick={openPicker}
        className="w-full bg-white border border-stone-200 rounded-xl px-4 py-3 text-left flex items-center gap-3 shadow-sm hover:border-stone-300 transition-colors"
      >
        <CalendarDays size={16} className="text-stone-400 shrink-0" />
        <span className={`text-sm ${hasSelection ? 'text-stone-800' : 'text-stone-400'}`}>
          {formatLabel(range?.from, range?.to)}
        </span>
      </button>

      {/* ── Calendar Panel ── */}
      {open && (
        <div className="absolute top-full mt-2 left-0 z-50 max-w-[calc(100vw-2rem)]">
          <DayPicker
            mode="range"
            selected={range}
            onSelect={handleSelect}
            locale={zhTW}
            min={1}
            disabled={{ before: new Date() }}
            components={{ DayButton: RangeDayButton }}
            classNames={{
              root: 'bg-white p-5 rounded-2xl shadow-xl border border-stone-100 font-sans select-none',
              months: 'flex',
              month: '',
              month_caption: 'flex items-center justify-between mb-4',
              caption_label: 'text-sm font-semibold text-stone-800 tracking-wide',
              nav: 'flex items-center gap-1',
              button_previous:
                'w-8 h-8 flex items-center justify-center rounded-full hover:bg-stone-100 text-stone-500 hover:text-stone-800 transition-colors',
              button_next:
                'w-8 h-8 flex items-center justify-center rounded-full hover:bg-stone-100 text-stone-500 hover:text-stone-800 transition-colors',
              weekdays: 'flex',
              weekday:
                'w-9 h-8 flex items-center justify-center text-[11px] text-stone-400 font-medium tracking-wider',
              weeks: '',
              week: 'flex mt-1',
              day: 'h-9 w-9 relative flex items-center justify-center',
              day_button: '',
              range_start: hasMultiDay ? gradientR : '',
              range_end:   hasMultiDay ? gradientL : '',
              range_middle: 'bg-stone-100',
              outside: '',
              disabled: '',
              today: '',
            }}
          />
        </div>
      )}
    </div>
  );
}
