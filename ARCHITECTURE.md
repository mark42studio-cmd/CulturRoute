# ARCHITECTURE.md
# CulturRoute — 系統架構文件

> 最後更新：2026-04-13

---

## 一、系統產線全景圖

```
┌─────────────────────────────────────────────────────────────────────┐
│                         資料來源層                                    │
│  台東藝文平台  台東生活美學館  東管處  史前博物館  台東縣立圖書館         │
│  台東美術館（暫停）           Threads 平台          Google Places API  │
└──────────────┬──────────────────────┬─────────────────┬─────────────┘
               │ HTTP / Playwright     │ Playwright      │ REST API
               ▼                      ▼                  ▼
┌─────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
│    scraper.py        │  │  threads_scraper.py   │  │ Maps_scraper.py  │
│  (主爬蟲 5 站台)     │  │  (Threads 關鍵字巡邏) │  │ (景點/美食同步)  │
│  + playwright-stealth│  │  + geopy 地理編碼     │  │                  │
└────────┬────────────┘  └──────────┬───────────┘  └────────┬─────────┘
         │ 原始 HTML                 │ 原始貼文               │ Places JSON
         ▼                          ▼                        │
┌─────────────────────┐  ┌──────────────────────┐           │
│  ai_data_cleaner()   │  │  AI 過濾 + 結構化     │           │
│  Gemini 2.5-flash-   │  │  Gemini 2.5-flash-   │           │
│  lite（文字+海報圖）  │  │  lite（文字判讀）     │           │
│  系列活動自動拆解    │  │  raw_threads_posts   │           │
└────────┬────────────┘  └──────────┬───────────┘           │
         │ 結構化 JSON               │ approved              │
         ▼                          ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Supabase (PostgreSQL)                              │
│   events 表          raw_threads_posts 表    places 表   foods 表    │
└─────────────────────────────┬───────────────────────────────────────┘
                               │ Supabase JS Client
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Next.js 前端（cultur-route/）                      │
│  App Router + Server Components + Zustand + Leaflet + Tailwind CSS  │
│                                                                       │
│  /               → EventBrowser（活動列表）                           │
│  /itinerary      → 行程規劃（三種模式，見下方）                        │
│  /event/[id]     → 活動詳情頁                                         │
│  /admin          → 後台管理                                           │
│  /api/places     → Server-side 代理（Google Places Key 保護）         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、後端模組詳解

### 2.1 `scraper.py` — 主爬蟲

**資料流**：Playwright 抓 HTML → BeautifulSoup 解析連結 → 逐頁 Playwright 讀取詳細內容 → `ai_data_cleaner()` → `save_to_supabase()`

**核心特性**：
- 使用 `playwright-stealth` 繞過反爬蟲偵測
- 支援「系列活動自動拆解」：AI 分析海報圖片後，一個系列拆為多筆 events
- Gemini rate limit 自動 retry（最多 3 次 × 60 秒）
- 寫入前以 `title + start_time` 查重，防止髒資料

**目前啟用站台**：
1. 台東藝文平台
2. 台東生活美學館
3. 東管處（東部海岸國家風景區）
4. 史前文化博物館
5. 台東縣立圖書館

### 2.2 `threads_scraper.py` — Threads 巡邏爬蟲

**資料流**：載入 `threads_cookies.json` 模擬登入 → 搜尋 11 組台東關鍵字 → 原始貼文入庫（`raw_status='pending'`） → Gemini AI 過濾 → 通過者升格寫入 `events` 表

**核心特性**：
- 雙階段寫入：先存原始貼文，再做 AI 審核，保留稽核軌跡
- 使用 Nominatim（geopy）作為座標查詢第二道防線
- 以 `permalink` 為唯一鍵，整個 session 預載已處理清單，避免重複抓取

### 2.3 `Maps_scraper.py` — Google Maps 同步

**資料流**：硬編碼景點/美食清單 → Google Places API v1（`searchText`） → `save_to_places()` / `save_to_foods()`

**核心特性**：
- 抓取 `editorialSummary`（景點簡介）、`regularOpeningHours`（營業時間）、`rating`（評分）
- 分寫兩張資料表：`places`（景點）、`foods`（美食）

---

## 三、前端架構詳解

### 3.1 路由結構

```
cultur-route/app/
├── page.tsx              # 首頁：EventBrowser 活動列表 + 日期篩選器
├── layout.tsx            # 全域 Layout（字型、Metadata）
├── itinerary/
│   └── page.tsx          # 行程規劃主頁
├── event/
│   └── [id]/page.tsx     # 活動詳情頁（Server Component 抓資料）
├── admin/
│   └── page.tsx          # 後台管理頁
└── api/
    └── places/route.ts   # Server-side 代理：Google Places API
```

### 3.2 狀態管理（Zustand）

`store/useItineraryStore.ts` 管理全域行程狀態：

| 狀態 | 型別 | 說明 | 持久化 |
|------|------|------|--------|
| `plannedEvents` | `PlannedEvent[]` | 使用者已加入行程的活動清單 | ✅ |
| `tripStartDate` | `string` | 旅遊起始日（YYYY-MM-DD） | ✅ |
| `tripEndDate` | `string` | 旅遊結束日（YYYY-MM-DD） | ✅ |
| `isSidebarOpen` | `boolean` | 行程側邊欄開關狀態 | ❌ |
| `flashEventId` | `string \| null` | 正在閃爍動畫的活動 ID | ❌ |

### 3.3 行程規劃三種模式（`/itinerary`）

| 模式 | 說明 |
|------|------|
| **多日 Tab 模式** | 依 `assigned_date` 分組，每日一個 Tab |
| **DnD 拖拉排序** | 使用 `@hello-pangea/dnd`，同日內自由排序，跨日需切換 Tab |
| **Leaflet 地圖模式** | 所有行程活動在地圖上標點顯示，元件以 `dynamic(..., { ssr: false })` 載入 |

### 3.4 地圖元件 SSR 保護模式

```typescript
// 所有 Leaflet 元件必須這樣載入
const ItineraryMap = dynamic(() => import('@/components/ItineraryMap'), {
  ssr: false,
  loading: () => <div>地圖載入中...</div>
});
```

---

## 四、環境變數清單

### 後端（根目錄 `.env`）

| 變數名 | 說明 |
|--------|------|
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key（具寫入權限） |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `GOOGLE_MAPS_API_KEY` | Google Maps / Places API Key |

### 前端（`cultur-route/.env.local`）

| 變數名 | 說明 |
|--------|------|
| `GOOGLE_PLACES_API_KEY` | 同上方 `GOOGLE_MAPS_API_KEY`，但名稱不同，供前端代理路由使用 |

> **注意**：`NEXT_PUBLIC_` 前綴的變數會暴露在瀏覽器端。Google API Key 一律透過 `/api/places` Server Route 代理，不加 `NEXT_PUBLIC_` 前綴。

---

## 五、各腳本執行指令速查

```bash
# 後端
cd backend
python scraper.py                    # 主爬蟲（5 個官方站台）
python threads_scraper.py            # Threads 關鍵字巡邏
python Maps_scraper.py               # Google Maps 景點/美食同步
python process_pending.py            # 處理 raw_threads_posts pending 貼文

# 前端
cd cultur-route
npm run dev                          # 啟動開發伺服器（http://localhost:3000）
npm run build                        # 正式 build
npm run lint                         # ESLint 檢查
```

---

## 六、已知限制與待辦事項

| 項目 | 狀態 | 說明 |
|------|------|------|
| 台東美術館爬蟲 | ⏸️ 暫停 | 反爬蟲機制較嚴，在 `TARGET_SITES` 中已註解 |
| `backend/main.py` | 📋 預留 | 目前為空白，預留給未來 FastAPI 路由使用 |
| `affiliate_links` 實際連結 | 🔜 待串接 | 欄位已預留，實際分潤服務尚未接入 |
| iOS App | 🔜 規劃中 | 未來與 Web 共用 Supabase 後端，需統一 `affiliate_links` 欄位格式 |
| `weather_resilience` 前端應用 | 🔜 規劃中 | DB 欄位已存在，前端尚未實作天氣篩選功能 |
