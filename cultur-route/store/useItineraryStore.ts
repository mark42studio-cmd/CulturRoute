import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Event, PlannedEvent } from '@/types';

// 🌟 小工具：將任何時間轉換成乾淨的 YYYY-MM-DD 格式
const getLocalYYYYMMDD = (dateStr: string) => {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

interface ItineraryStore {
  plannedEvents: PlannedEvent[];
  isSidebarOpen: boolean;
  tripStartDate: string;
  tripEndDate: string;
  /** UI-only：目前正在閃爍的活動 ID（未持久化） */
  flashEventId: string | null;
  /** UI-only：是否剛剛新增了一天（未持久化） */
  flashDayAdded: boolean;
  /** UI-only：游標懸停中的活動 ID，用於列表 ↔ 地圖雙向連動（未持久化） */
  hoveredEventId: string | null;
  setHoveredEventId: (id: string | null) => void;
  setTripDates: (start: string, end: string) => void;
  addEvent: (event: Event, options?: { isExtraDayTrigger?: boolean }) => void;
  removeEvent: (eventId: string) => void;
  toggleSidebar: () => void;
  reorderEvents: (startIndex: number, endIndex: number, targetDate: string) => void;
  updateEventDate: (eventId: string, newDate: string) => void;
  updateStayDuration: (eventId: string, minutes: number) => void;
  /** 直接累加 minutes 至指定活動的 stay_duration（上限 240），並觸發 flash + 開啟 Sidebar */
  extendStayDuration: (eventId: string, minutes: number) => void;
  /** 將整趟行程的 tripEndDate 延長一天，並觸發 flashDayAdded + 開啟 Sidebar */
  addTripDay: () => void;
  clearFlash: () => void;
  /** 設定展覽/長期活動的使用者自訂前往時間（HH:MM），用於時間軸排序 */
  updateVisitTime: (eventId: string, time: string) => void;
}

export const useItineraryStore = create<ItineraryStore>()(
  persist(
    (set) => ({
      plannedEvents: [],
      isSidebarOpen: false,
      tripStartDate: '',
      tripEndDate: '',
      flashEventId: null,
      flashDayAdded: false,
      hoveredEventId: null,
      setHoveredEventId: (id) => set({ hoveredEventId: id }),

      // 儲存首頁設定的日期
      setTripDates: (start, end) => set({ tripStartDate: start, tripEndDate: end }),

      addEvent: (event, options) => set((state) => {
        if (state.plannedEvents.find(e => e.id === event.id)) return state;

        const eventStartDate = getLocalYYYYMMDD(event.start_time);

        // 智慧預設日期（Smart Default Date Assignment）
        //
        // 展覽（有 end_date 且跨日）的排程規則：
        //   ① 抵達日 落在展期內  → assigned_date = tripStartDate（最常見情境）
        //   ② 抵達日 早於展覽開幕 → assigned_date = eventStartDate（使用者提早規劃）
        //   ③ 抵達日 晚於展覽結束 → assigned_date = eventStartDate（讓硬排警告提醒使用者）
        //
        // 不屬於展覽（單次活動）→ 維持 eventStartDate 不變。
        const isMultiDayExhibition = !!(event.end_date && event.end_date > eventStartDate);
        let assigned_date = eventStartDate;
        if (isMultiDayExhibition && state.tripStartDate) {
          const tripStart    = state.tripStartDate;
          const exhibitionEnd = event.end_date!;          // 已知非空
          // 情境 ①：抵達日在展期內，強制排到抵達日
          if (tripStart >= eventStartDate && tripStart <= exhibitionEnd) {
            assigned_date = tripStart;
          }
          // 情境 ②③：抵達日不在展期內，保留 eventStartDate（讓硬排警告提醒）
        }

        const isExhibitionEvent = !!(
          event.vibe_tags?.includes('靜態展覽') ||
          /個展|聯展|特展/.test(event.title)
        );

        return {
          plannedEvents: [
            ...state.plannedEvents,
            {
              ...event,
              assigned_date,
              stay_duration: 90,
              ...(options?.isExtraDayTrigger ? { isExtraDayTrigger: true } : {}),
            },
          ],
          isSidebarOpen: true,
        };
      }),
      
      removeEvent: (eventId) => set((state) => ({
        plannedEvents: state.plannedEvents.filter(e => e.id !== eventId)
      })),
      
      toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      
      // 拖曳排序現在是認「絕對日期」
      reorderEvents: (startIndex, endIndex, targetDate) => set((state) => {
        const otherEvents = state.plannedEvents.filter(e => e.assigned_date !== targetDate);
        const targetEvents = state.plannedEvents.filter(e => e.assigned_date === targetDate);
        
        const [removed] = targetEvents.splice(startIndex, 1);
        targetEvents.splice(endIndex, 0, removed);
        
        return { plannedEvents: [...otherEvents, ...targetEvents] };
      }),

      // 更改日期也是直接更新「絕對日期」字串
      updateEventDate: (eventId, newDate) => set((state) => ({
        plannedEvents: state.plannedEvents.map(e =>
          e.id === eventId ? { ...e, assigned_date: newDate } : e
        )
      })),

      // 更新預計停留時間（分鐘）
      updateStayDuration: (eventId, minutes) => set((state) => ({
        plannedEvents: state.plannedEvents.map(e =>
          e.id === eventId ? { ...e, stay_duration: minutes } : e
        )
      })),

      // 累加停留時間（多留一下功能），上限 240 分鐘，同時觸發 flash 綠色動畫 + 開啟 Sidebar
      extendStayDuration: (eventId, minutes) => set((state) => ({
        plannedEvents: state.plannedEvents.map(e =>
          e.id === eventId
            ? { ...e, stay_duration: Math.min(240, (e.stay_duration ?? 90) + minutes) }
            : e
        ),
        flashEventId: eventId,
        isSidebarOpen: true,
      })),

      // 將整趟行程延長一天（多留一下 → 增加天數版本）
      // 使用 new Date(y, m-1, d) 本地時間建構，規避 UTC 解析時區偏移問題
      addTripDay: () => set((state) => {
        if (!state.tripEndDate) return state;
        const [y, m, d] = state.tripEndDate.split('-').map(Number);
        const next = new Date(y, m - 1, d + 1);
        const nextStr = [
          next.getFullYear(),
          String(next.getMonth() + 1).padStart(2, '0'),
          String(next.getDate()).padStart(2, '0'),
        ].join('-');
        return {
          tripEndDate: nextStr,
          flashDayAdded: true,
          isSidebarOpen: true,
        };
      }),

      clearFlash: () => set({ flashEventId: null, flashDayAdded: false }),

      updateVisitTime: (eventId, time) => set((state) => ({
        plannedEvents: state.plannedEvents.map(e =>
          e.id === eventId ? { ...e, visit_time: time || undefined } : e
        ),
      })),
    }),
    {
      name: 'cultur-route-itinerary',
      partialize: (state) => ({ 
        plannedEvents: state.plannedEvents,
        tripStartDate: state.tripStartDate, // 🌟 讓日期就算重整網頁也不會消失
        tripEndDate: state.tripEndDate
      }),
    }
  )
);