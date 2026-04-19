-- migration_add_event_columns.sql
-- 在 Supabase SQL Editor 執行此檔案
-- 新增 Phase 2~3 期間規劃的所有欄位（全部使用 IF NOT EXISTS，可安全重複執行）
-- ─────────────────────────────────────────────────────────────

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS long_description  TEXT,
  ADD COLUMN IF NOT EXISTS end_date          DATE,
  ADD COLUMN IF NOT EXISTS address           TEXT,
  ADD COLUMN IF NOT EXISTS opening_hours     TEXT,
  ADD COLUMN IF NOT EXISTS closing_days      TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ticket_url        TEXT,
  ADD COLUMN IF NOT EXISTS source_url        TEXT,
  ADD COLUMN IF NOT EXISTS image_captured    TEXT,
  ADD COLUMN IF NOT EXISTS affiliate_links   JSONB;

-- 驗證新增結果
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'events'
  AND column_name IN (
    'long_description', 'end_date', 'address',
    'opening_hours', 'closing_days',
    'ticket_url', 'source_url', 'image_captured', 'affiliate_links'
  )
ORDER BY column_name;
