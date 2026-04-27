/**
 * 全域型別定義 — CultureRoute 唯一型別來源
 * 所有元件、Store、頁面請從這裡引入，不要在各自檔案內重複定義。
 */

/** 分潤連結結構（CLAUDE.md 規定必須保留） */
export interface AffiliateLinks {
  rental:        { label: string; url: string | null };
  ticket:        { label: string; url: string | null };
  accommodation: { label: string; url: string | null };
}

/** 來自 Supabase events 表的活動資料 */
export interface Event {
  id: string;
  title: string;
  description: string;
  long_description?: string;
  start_time: string;       // ISO 8601
  end_time?: string;        // ISO 8601
  end_date?: string;        // YYYY-MM-DD，跨日展覽/活動的最後日期
  opening_hours?: string;   // 例："09:00–17:00"
  closing_days?: string[];  // 例：["Monday"] 或 ["週一", "週二"]
  venue_name: string;
  address?: string;         // 完整地址（比 venue_name 更精確）
  latitude?: number;
  longitude?: number;
  vibe_tags: string[];
  target_audience?: string[];
  weather_resilience: number; // 1–5
  is_free: boolean;
  image_captured?: string;
  /** @deprecated 舊資料結構，請改用頂層 image_captured */
  engagement_metrics?: { image_captured: string };
  ticket_url?: string;
  source_url?: string;
  affiliate_links?: AffiliateLinks;
}

/** 加入行程後的活動（附帶使用者指定的日期與預計停留時間） */
export interface PlannedEvent extends Event {
  assigned_date: string;       // YYYY-MM-DD
  stay_duration: number;       // 分鐘，預設 60
  isExtraDayTrigger?: boolean; // 由「多留一下」合併按鈕加入時為 true，用於側邊欄顯示訂房提醒
  /** 展覽/長期活動的使用者自訂前往時間（HH:MM），優先用於時間軸排序 */
  visit_time?: string;
}
