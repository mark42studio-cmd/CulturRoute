# SCHEMA.md
# CulturRoute — Supabase 資料庫 Schema 定義

> 最後更新：2026-04-13
> 資料庫：Supabase (PostgreSQL)
> 時區慣例：所有時間欄位儲存 ISO 8601 格式，offset `+08:00`（Asia/Taipei）

---

## 資料表總覽

| 資料表 | 用途 |
|--------|------|
| `events` | 藝文活動主表（爬蟲 + AI 清洗寫入） |
| `places` | 台東景點（Google Places API 同步） |
| `foods` | 台東美食（Google Places API 同步） |
| `raw_threads_posts` | Threads 原始貼文暫存（AI 過濾前） |

---

## 1. `events` 表

主要藝文活動資料，由 `scraper.py` 與 `threads_scraper.py` 寫入。

| 欄位名稱 | 型別 | 說明 |
|----------|------|------|
| `id` | `uuid` | 主鍵，Supabase 自動產生 |
| `created_at` | `timestamptz` | 建立時間，自動填入 |
| `title` | `text` | 活動標題（系列活動會含子標題，如「山海有聲 - 南王姊妹花」） |
| `description` | `text` | 短摘要（15–30 字，對應 AI 的 `card_summary`） |
| `long_description` | `text` | 完整活動介紹內文，越詳細越好 |
| `image_captured` | `text` | 海報圖片 URL（對應 AI 的 `image_url`） |
| `start_time` | `timestamptz` | 活動開始時間（ISO 8601, `+08:00`） |
| `end_time` | `timestamptz` | 活動結束時間（可為 null） |
| `venue_name` | `text` | 地點名稱（如「鐵花村」） |
| `latitude` | `float8` | 緯度（台東合理範圍：21.9–23.2） |
| `longitude` | `float8` | 經度（台東合理範圍：120.7–121.6） |
| `is_free` | `boolean` | 是否免費入場 |
| `ticket_url` | `text` | 購票/報名連結（可為 null） |
| `source_url` | `text` | 原始來源網頁 URL |
| `vibe_tags` | `text[]` | 氛圍標籤陣列（如 `["#音樂", "#戶外", "#部落文化"]`） |
| `target_audience` | `text[]` | 適合族群（如 `["親子", "情侶", "獨旅", "銀髮"]`） |
| `indoor_or_outdoor` | `text` | 室內/室外：`"indoor"` / `"outdoor"` / `"semi-outdoor"` |
| `weather_resilience` | `int2` | 防雨指數 1–5（5 = 完全室內不受天氣影響） |
| `engagement_metrics` | `jsonb` | 互動數據（預設 `{"score": 0}`，供未來擴充按讚/收藏計數） |
| `affiliate_links` | `jsonb` | 分潤連結，**必填結構如下**，無連結填 `null` |

### `affiliate_links` JSONB 結構（強制格式）

```json
{
  "rental":        { "label": "租車/租機車", "url": null },
  "ticket":        { "label": "售票連結",   "url": null },
  "accommodation": { "label": "周邊住宿",   "url": null }
}
```

> **規範**：此欄位在所有後端輸出的 JSON 中**不可省略**，即使三個 url 均為 null。

### 查重鍵（Deduplication Key）

```sql
UNIQUE (title, start_time)
```

寫入前以 `title + start_time` 確認不重複，已存在則 skip。

---

## 2. `places` 表

台東景點資料，由 `Maps_scraper.py` 透過 Google Places API 同步。

| 欄位名稱 | 型別 | 說明 |
|----------|------|------|
| `id` | `uuid` | 主鍵，自動產生 |
| `created_at` | `timestamptz` | 建立時間 |
| `name` | `text` | 景點名稱（唯一鍵，查重用） |
| `description` | `text` | Google `editorialSummary` 簡介（無則填「尚無簡介」） |
| `latitude` | `float8` | 緯度 |
| `longitude` | `float8` | 經度 |
| `opening_hours` | `text` | 每日營業時間（JSON 陣列序列化為字串，如 `["週一: 09:00–17:00", ...]`） |
| `source_url` | `text` | Google Maps 連結（`https://www.google.com/maps/place/?q=place_id:...`） |

### 查重鍵

```sql
UNIQUE (name)
```

---

## 3. `foods` 表

台東美食資料，由 `Maps_scraper.py` 透過 Google Places API 同步。

| 欄位名稱 | 型別 | 說明 |
|----------|------|------|
| `id` | `uuid` | 主鍵，自動產生 |
| `created_at` | `timestamptz` | 建立時間 |
| `name` | `text` | 店名（唯一鍵，查重用） |
| `cuisine_type` | `text` | 料理類型（來自 Google `primaryTypeDisplayName`，如「海鮮餐廳」） |
| `price_range` | `text` | 價位等級（來自 Google `priceLevel`，如 `PRICE_LEVEL_MODERATE`） |
| `latitude` | `float8` | 緯度 |
| `longitude` | `float8` | 經度 |
| `google_rating` | `float4` | Google 評分（1.0–5.0，可為 null） |
| `opening_hours` | `text` | 每日營業時間（同 `places` 表格式） |

### 查重鍵

```sql
UNIQUE (name)
```

---

## 4. `raw_threads_posts` 表

Threads 爬蟲第一階段暫存表，由 `threads_scraper.py` 寫入。AI 審核通過後才升格寫入 `events` 表。

| 欄位名稱 | 型別 | 說明 |
|----------|------|------|
| `id` | `uuid` | 主鍵，自動產生 |
| `created_at` | `timestamptz` | 建立時間 |
| `platform` | `text` | 來源平台（目前固定為 `"threads"`） |
| `keyword` | `text` | 觸發此筆抓取的搜尋關鍵字 |
| `permalink` | `text` | 貼文永久連結（唯一鍵，查重防重複抓取） |
| `source_url` | `text` | 貼文原始 URL |
| `raw_text` | `text` | 原始貼文文字（上限 5000 字元） |
| `raw_status` | `text` | 處理狀態：`"pending"` / `"approved"` / `"rejected"` |

### 查重鍵

```sql
UNIQUE (permalink)
```

---

## TypeScript 型別對照（cultur-route/types/）

```typescript
// events 表對應的前端型別（需與上方 Schema 保持同步）
export interface Event {
  id: string;
  title: string;
  description: string;
  long_description: string;
  image_captured: string | null;
  start_time: string;        // ISO 8601
  end_time: string | null;   // ISO 8601
  venue_name: string;
  latitude: number | null;
  longitude: number | null;
  is_free: boolean;
  ticket_url: string | null;
  source_url: string;
  vibe_tags: string[];
  target_audience: string[];
  indoor_or_outdoor: 'indoor' | 'outdoor' | 'semi-outdoor' | null;
  weather_resilience: number; // 1–5
  engagement_metrics: { score: number } | null;
  affiliate_links: {
    rental:        { label: string; url: string | null };
    ticket:        { label: string; url: string | null };
    accommodation: { label: string; url: string | null };
  } | null;
}

// Zustand store 用的行程活動型別
export interface PlannedEvent extends Event {
  assigned_date: string;  // YYYY-MM-DD
  stay_duration: number;  // 分鐘，上限 240
}
```
