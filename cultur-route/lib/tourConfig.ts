import type { DriveStep } from 'driver.js';

export const HOME_TOUR_KEY = 'cultrRoute_homeTour_v3';
export const ITINERARY_TOUR_KEY = 'cultrRoute_itineraryTour_v2';
export const ITINERARY_TOUR_KEY_V3 = 'hasSeenTour_v3';

// ── 首頁 3 步驟（Step 1-3）────────────────────────────────────────────────────
export const homeSteps: DriveStep[] = [
  {
    element: '#tour-event-type-filter',
    popover: {
      title: '🎭 Step 1 — 探索',
      description: '根據您的興趣，快速篩選展覽、演出或工作坊。',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#tour-event-grid',
    popover: {
      title: '➕ Step 2 — 加入',
      description: '點擊「+ 加入行程」，將喜歡的活動放入您的文化口袋。記得先選好日期喔！',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#tour-bottom-nav-route',
    popover: {
      title: '🗺️ Step 3 — 規劃',
      description: '在這裡，我們為您整理好每日行程，並偵測潛在的時間衝突。',
      side: 'top',
      align: 'center',
    },
  },
];

// ── 行程頁 3 步驟（Step 4-6）─────────────────────────────────────────────────
export const itinerarySteps: DriveStep[] = [
  {
    element: '.tour-fixed-event-card',
    popover: {
      title: '🔒 Step 4 — 鎖定',
      description: '演出與講座時間是固定的，我們已為您釘死在時間軸上，確保您不撲空。',
      side: 'right',
    },
  },
  {
    element: '.tour-exhibition-card',
    popover: {
      title: '🎨 Step 5 — 展覽排序',
      description: '展覽行程最彈性！選擇您打算前往的時間，系統會自動幫您排入當天最順的順序。',
      side: 'right',
    },
  },
  {
    element: '#tour-generate-route-btn',
    popover: {
      title: '✨ Step 6 — 完成',
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
