# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

**台東藝文展演行程規劃神器 (CulturRoute)**

自動爬取台東在地藝文活動資訊，透過 Gemini AI 清洗結構化資料，提供使用者瀏覽活動並規劃多日行程的平台。未來同時支援 Web 網頁版與 iOS App。

---

## 核心規範（必讀，不可違反）

1. **前後端嚴格分離**：前端只動 `cultur-route/`，後端只動 `backend/`，兩者不互相引入。
2. **AI 模型限制**：核心 AI 邏輯一律使用 **Gemini API**（`google-genai` 套件），嚴禁引入或使用 OpenAI。
3. **分潤欄位保留**：所有從後端輸出的活動 JSON，必須預留 `affiliate_links` 欄位（結構見下方），供 Web/iOS 跨平台分潤使用。未有實際連結時填 `null`，**不可省略欄位**。

```json
"affiliate_links": {
  "rental":        { "label": "租車/租機車", "url": null },
  "ticket":        { "label": "售票連結",   "url": null },
  "accommodation": { "label": "周邊住宿",   "url": null }
}
```

---

## 目錄結構定位

```
E:/CulturRoute/
├── backend/          ← Python 後端（爬蟲 + AI 清洗 + 寫入 Supabase）
└── cultur-route/     ← Next.js 前端（唯一前端目錄）
```

`frontend/` 已刪除，`cultur-route/` 是唯一的前端目錄。

---

## 常用指令

### 前端 (cultur-route/)
```bash
cd cultur-route
npm run dev      # 啟動開發伺服器
npm run build    # 正式 build（會重建 .next/）
npm run lint     # 執行 ESLint
```

### 後端 (backend/)
```bash
cd backend
python scraper.py          # 執行主爬蟲（5 個台東官方網站）
python threads_scraper.py  # 執行 Threads 關鍵字巡邏爬蟲
python Maps_scraper.py     # 同步 Google Maps 景點/美食資料

# 初次安裝環境
pip install -r requirements.txt
playwright install chromium
```

---

## 架構說明

### 資料流

```
爬蟲 (Playwright) → 原始 HTML
    → Gemini AI 清洗 → 結構化 JSON（含 affiliate_links）
    → Supabase (PostgreSQL) 寫入
    → Next.js 前端讀取顯示
```

### 後端爬蟲架構 (backend/)

| 檔案 | 用途 |
|------|------|
| `scraper.py` | 主爬蟲。`ai_powered_spider()` 用 Playwright + `playwright-stealth` 繞過反爬蟲；`ai_data_cleaner()` 呼叫 Gemini 將原始文字+海報圖片轉為結構化 JSON，支援系列活動自動拆解 |
| `threads_scraper.py` | Threads 關鍵字巡邏。載入 `threads_cookies.json` 模擬登入，搜尋台東相關關鍵字，AI 過濾並寫入 Supabase |
| `Maps_scraper.py` | 呼叫 Google Places API，同步景點（`places` 表）與美食（`foods` 表）資料 |

Gemini 呼叫一律使用 `gemini-2.5-flash-lite` 模型，rate limit 時自動 retry（最多 3 次，每次等 60 秒）。

### 前端架構 (cultur-route/)

採用 **Next.js App Router**。

| 路由 | 說明 |
|------|------|
| `app/page.tsx` | 首頁，透過 `EventBrowser` 元件展示活動列表 |
| `app/itinerary/page.tsx` | 行程規劃頁，支援多日 Tab、DnD 拖拉排序（`@hello-pangea/dnd`）、Leaflet 地圖 |
| `app/admin/page.tsx` | 後台管理頁 |
| `app/event/[id]/` | 活動詳情頁 |
| `app/api/places/route.ts` | Server-side 代理，轉發 Google Places API 請求（避免 Key 外洩） |

**狀態管理**：`store/useItineraryStore.ts` 用 Zustand 管理加入行程的活動清單（`plannedEvents`）、旅遊日期區間（`tripStartDate/tripEndDate`）。

地圖元件（`ItineraryMap`, `EventMapWrapper`）一律透過 `dynamic(..., { ssr: false })` 載入，避免 SSR 與 Leaflet 的 `window` 衝突。

### 資料庫（Supabase）

主要資料表：`events`（藝文活動）、`places`（景點）、`foods`（美食）。

`events` 表的關鍵欄位：`title`, `start_time`, `end_time`, `venue_name`, `latitude`, `longitude`, `is_free`, `ticket_url`, `source_url`, `vibe_tags[]`, `target_audience[]`, `weather_resilience`（1-5）, `engagement_metrics`（JSONB）。

---

## 環境變數

根目錄 `.env`（後端使用）：
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_MAPS_API_KEY`

`cultur-route/.env.local`（前端使用）：
- `GOOGLE_PLACES_API_KEY`（注意：與後端的 `GOOGLE_MAPS_API_KEY` 是同一組金鑰，但環境變數名不同）

---

## 注意事項

- `backend/threads_cookies.json` 含 Threads 登入 Session，已加入 `.gitignore`，**不可提交**。
- `cultur-route/.next/` 已加入 `.gitignore`，可直接刪除節省空間，`npm run dev` 會自動重建。
- `scraper.py` 的 `TARGET_SITES` 清單中，台東美術館因反爬蟲問題被暫時註解，待日後突破。
- `backend/main.py` 目前為空白，預留給未來 FastAPI 路由使用。
