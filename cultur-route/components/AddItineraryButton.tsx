'use client';

import { toast } from 'sonner';
import { useItineraryStore } from '@/store/useItineraryStore';
import { getDateMismatch, dateOnlyTaipei, formatDateZH, isSingleDayEvent } from '@/lib/eventUtils';
import { buildAgodaUrl, addOneDay } from '@/lib/agoda';
import type { Event } from '@/types';

export default function AddItineraryButton({ event }: { event: Event }) {
  const {
    plannedEvents, addEvent, removeEvent,
    tripStartDate, tripEndDate, setTripDates,
    setPendingJumpToDate,
  } = useItineraryStore();
  const isAdded = plannedEvents.some(e => e.id === event.id);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 移除不受日期鎖限制
    if (isAdded) {
      removeEvent(event.id);
      toast('已從行程移除', { description: event.title });
      return;
    }

    // 日期防呆鎖：必須先設定出發日期才能加入行程
    if (!tripStartDate) {
      toast('📅 請先設定出發日期！', {
        description: '請選擇您的行程日期，再開始安排專屬行程。',
      });
      document
        .getElementById('tour-date-filter')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // ── Task 2: 展期邊界強制驗證——展期與行程無交集時完全阻擋 ─────────────────────────
    const eventStartStr = dateOnlyTaipei(event.start_time);
    const rawEventEnd   = event.end_date ?? (event.end_time ? dateOnlyTaipei(event.end_time) : null);
    const eventEndStr   = rawEventEnd ?? eventStartStr;

    if (eventEndStr < tripStartDate || eventStartStr > tripEndDate) {
      const startLabel = formatDateZH(eventStartStr);
      const endLabel   = eventEndStr !== eventStartStr ? ` - ${formatDateZH(eventEndStr)}` : '';
      toast(`⚠️ 選擇的日期不在該活動的展演期間內 (${startLabel}${endLabel})`);
      return;
    }

    // ── Task 3: 週一休館防呆——單日活動活動日落在週一時阻擋 ────────────────────────────
    const MONDAY_CLOSED_VENUES = ['藝文中心', '美術館', '圖書館'] as const;
    if (isSingleDayEvent(event)) {
      const [ey, em, ed] = eventStartStr.split('-').map(Number);
      if (new Date(ey, em - 1, ed).getDay() === 1) {
        const closedVenue = MONDAY_CLOSED_VENUES.find(v => event.venue_name.includes(v));
        if (closedVenue) {
          toast(`⚠️ 注意：該場館 (${closedVenue}) 每週一休館，請選擇其他日期。`);
          return;
        }
      }
    }

    const mismatchDate = getDateMismatch(event, tripStartDate, tripEndDate);

    if (mismatchDate) {
      // 自動延長行程範圍
      const newStart = mismatchDate < tripStartDate ? mismatchDate : tripStartDate;
      const newEnd   = mismatchDate > tripEndDate   ? mismatchDate : tripEndDate;
      setTripDates(newStart, newEnd);
      addEvent(event);
      setPendingJumpToDate(mismatchDate);

      const dateLabel = formatDateZH(mismatchDate);
      toast(`✨ 已自動延長您的行程！`, {
        description: `已新增至 ${dateLabel}。您多留了幾天，記得提早預訂住宿喔！`,
        action: {
          label: '查看推薦住宿',
          onClick: () => window.open(buildAgodaUrl(newStart, addOneDay(newEnd)), '_blank'),
        },
        duration: 6000,
      });
      return;
    }

    addEvent(event);
    toast('✓ 已加入行程', { description: event.title });
  };

  return (
    <button
      onClick={handleClick}
      className={`mt-4 w-full py-2.5 text-sm tracking-wider transition-all active:scale-95 border ${
        isAdded
          ? 'border-stone-300 text-stone-400 bg-transparent'
          : 'border-teal-800 text-teal-800 hover:bg-teal-800 hover:text-white'
      }`}
    >
      {isAdded ? '✓ 已加入行程' : '+ 加入行程'}
    </button>
  );
}
