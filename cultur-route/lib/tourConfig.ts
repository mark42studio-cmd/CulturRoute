import type { DriveStep } from 'driver.js';

export const HOME_TOUR_KEY = 'cultrRoute_homeTour_v1';
export const ITINERARY_TOUR_KEY = 'cultrRoute_itineraryTour_v1';

export const homeSteps: DriveStep[] = [
  {
    element: '#tour-home-header',
    popover: {
      title: '👋 歡迎來到 CulturRoute！',
      description:
        '台東在地藝文活動一站彙整。輸入你的停留日期，探索專屬台東的文化路徑。',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '#tour-date-filter',
    popover: {
      title: '📅 設定旅遊日期',
      description:
        '輸入你預計抵達與離開台東的日期，系統會自動篩選出這段期間舉辦的所有活動。',
      side: 'bottom',
    },
  },
  {
    element: '#tour-event-type-filter',
    popover: {
      title: '🎭 依類型篩選活動',
      description:
        '想看演出、展覽還是講座？點擊膠囊按鈕快速切換，找到你最感興趣的活動類型。',
      side: 'bottom',
    },
  },
  {
    element: '#tour-event-grid',
    popover: {
      title: '🎪 探索藝文活動',
      description:
        '每張卡片代表一個活動。點擊卡片查看詳情，滑鼠停留可出現「加入行程」按鈕，手機用右下角的 ＋ 按鈕。',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '#itinerary-sidebar-btn',
    popover: {
      title: '📋 查看行程清單',
      description:
        '加入的活動都收納在這裡！點擊右下角的日曆圖示，隨時查看與管理你的台東行程。',
      side: 'left',
    },
  },
];

export const itinerarySteps: DriveStep[] = [
  {
    element: '#tour-itinerary-tabs',
    popover: {
      title: '📅 日期分頁',
      description:
        '系統已根據你的旅遊日期自動建立每一天的分頁。點擊分頁切換日期，右側漸層代表還有更多天數可左右滑動。',
      side: 'bottom',
    },
  },
  {
    element: '#tour-itinerary-events',
    popover: {
      title: '✋ 拖拉調整順序',
      description:
        '長按活動卡片並拖拉，可以自由調整當天的參觀順序，打造最順路的行程！',
      side: 'right',
    },
  },
  {
    element: '#tour-itinerary-map',
    popover: {
      title: '🗺️ 路線地圖',
      description:
        '地圖會標示今日所有活動的地點。點擊「時間確認，生成路線圖」即可一鍵規劃最佳移動路線。',
      side: 'left',
    },
  },
  {
    element: '#tour-itinerary-export',
    popover: {
      title: '📤 儲存 ＆ 分享行程',
      description:
        '規劃完成後，可匯出至 Google / Apple 日曆，或下載精美的台東回憶明信片留念！',
      side: 'top',
    },
  },
  {
    element: '#tour-generate-route-btn',
    popover: {
      title: '✨ 最後一步：生成專屬路線！',
      description:
        '排好行程了嗎？千萬別忘了點擊這裡，系統才會幫你畫出完整的地圖與交通路線喔！',
      side: 'top',
    },
  },
];
