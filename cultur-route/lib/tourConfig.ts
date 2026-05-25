import type { DriveStep } from 'driver.js';

// 每次大改版步驟時請更新版本號，讓老使用者也能看到最新導引
export const HOME_TOUR_KEY = 'cultrRoute_homeTour_v6';
export const ITINERARY_TOUR_KEY = 'cultrRoute_itineraryTour_v2';
export const ITINERARY_TOUR_KEY_V3 = 'hasSeenTour_v3';

// ── 首頁 4 步驟（一般藝文探索者新手導覽）──────────────────────────────────
export const homeSteps: DriveStep[] = [
  {
    element: '#tour-home-header',
    popover: {
      title: '📍 Step 1 — 歡迎入站',
      description: '歡迎來到 CulturRoute！讓我們花 1 分鐘帶您快速了解平台，開始您的藝文探索之旅。',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#tour-event-grid',
    popover: {
      title: '📍 Step 2 — 探索展覽與動態',
      description: '這裡匯整了近期的藝文展覽與活動路線。您可以透過分類與地圖，快速找到感興趣的文化現場。',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#tour-submit-event-btn',
    popover: {
      title: '📍 Step 3 — 活動投件分享',
      description: '發現了很棒的活動但地圖上沒有？點擊這裡，您可以將資訊投稿給我們，讓更多人看見這個美好的展演！',
      side: 'top',
      align: 'start',
    },
    onHighlightStarted: () => {
      setTimeout(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      }, 200);
    },
  },
  {
    element: '#tour-pwa-install-btn',
    popover: {
      title: '📍 Step 4 — 安裝專屬捷徑',
      description: '點擊這裡將網站「加入主畫面」！隨時隨地都能像開啟 App 一樣，一鍵探索最新的文化路徑。導覽結束，開始探索吧！',
      side: 'left',
      align: 'center',
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
