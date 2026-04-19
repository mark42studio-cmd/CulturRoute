-- raw_threads_posts：Threads 爬蟲原始貼文暫存表
-- 在 Supabase SQL Editor 執行此腳本建立資料表
--
-- raw_status 生命週期：
--   pending    → 已抓取，尚未送 AI
--   processed  → AI 判斷為活動並已寫入 events 表
--   not_event  → AI 判斷非活動（閒聊、招募等）
--   ai_failed  → AI 呼叫失敗（可稍後重跑）

CREATE TABLE IF NOT EXISTS raw_threads_posts (
    id            bigserial PRIMARY KEY,
    platform      text        NOT NULL DEFAULT 'threads',
    keyword       text        NOT NULL,
    permalink     text        UNIQUE,          -- 貼文永久連結，唯一索引防重複入庫
    source_url    text        NOT NULL,        -- 同 permalink；無 permalink 時為搜尋頁 URL
    raw_text      text        NOT NULL,
    raw_status    text        NOT NULL DEFAULT 'pending',
    created_at    timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz
);

-- 加速依狀態查詢（補跑 ai_failed 時使用）
CREATE INDEX IF NOT EXISTS idx_raw_threads_posts_status
    ON raw_threads_posts (raw_status);
