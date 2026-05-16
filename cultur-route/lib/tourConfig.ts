import type { DriveStep } from 'driver.js';

// 每次大改版步驟時請更新版本號，讓老使用者也能看到最新導引
export const HOME_TOUR_KEY = 'cultrRoute_homeTour_v5';
export const ITINERARY_TOUR_KEY = 'cultrRoute_itineraryTour_v2';
export const ITINERARY_TOUR_KEY_V3 = 'hasSeenTour_v3';

// ── 首頁 6 步驟（照 UI 由上到下的真實動線）─────────────────────────────────
export const homeSteps: DriveStep[] = [
  {
    element: '#tour-date-filter',
    popover: {
      title: '📅 Step 1 — 設定旅程',
      description: '第一步，請先設定您預計在台東停留的時間，系統將為您建立專屬行事曆。',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#tour-event-type-filter',
    popover: {
      title: '🎭 Step 2 — 探索',
      description: '接著，根據您的興趣篩選展覽、演出或工作坊。',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#tour-event-grid',
    popover: {
      title: '➕ Step 3 — 文化口袋',
      description: '點擊「+」，就能將想去的活動收進您的文化口袋。',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#tour-bottom-nav-route',
    popover: {
      title: '🗺️ Step 4 — 智慧行程',
      description: '在這裡，我們會自動排好每日行程，並聰明地幫您偵測潛在的時間衝突。',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '.tour-exhibition-card',
    popover: {
      title: '🎨 Step 5 — 展覽插隊',
      description: '展覽行程最彈性！選擇您打算前往的時間，系統會自動幫您插隊排入最順暢的順序。',
      side: 'right',
    },
  },
  {
    element: '#tour-action-buttons',
    popover: {
      title: '📢 Step 6 — 平台生態',
      description: '如果您是主辦單位想上架活動，或是發現資料有誤需要報修，功能都完整收錄在這裡喔！',
      side: 'top',
      align: 'center',
    },
    onHighlightStarted: () => {
      // 最後一步在頁面最底部，自動滾下去讓使用者看清楚
      setTimeout(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      }, 200);
    },
  },
];

// ── 行程頁 3 步驟 ────────────────────────────────────────────────────────────
export const itinerarySteps: DriveStep[] = [
  {
    element: '.tour-fixed-event-card',
    popover: {
      title: '🔒 Step 1 — 鎖定',
      description: '演出與講座時間是固定的，我們已為您釘死在時間軸上，確保您不撲空。',
      side: 'right',
    },
  },
  {
    element: '.tour-exhibition-card',
    popover: {
      title: '🎨 Step 2 — 展覽排序',
      description: '展覽行程最彈性！選擇您打算前往的時間，系統會自動幫您排入當天最順的順序。',
      side: 'right',
    },
  },
  {
    element: '#tour-generate-route-btn',
    popover: {
      title: '✨ Step 3 — 完成',
      description: '一切就緒！生成您的專屬文化地圖，開始台東之旅吧。',
      side: 'top',
      align: 'center',
    },
    onHighlightStarted: (element: Element | undefined) => {
      setTimeout(() => {
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    },
  },
];
