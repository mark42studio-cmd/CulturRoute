-- ============================================================
-- CulturRoute：語意去重 pgvector 設定
-- 執行順序：在 Supabase SQL Editor 依序貼入並執行
-- ============================================================

-- ── Step 0：啟用 pgvector Extension ──────────────────────────
-- 如果 Dashboard → Database → Extensions 已啟用可跳過
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Step 1：為 events 表加入 embedding 欄位 ──────────────────
-- text-embedding-004 輸出 768 維向量
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- ── Step 2：建立 IVFFlat 餘弦相似度索引 ─────────────────────
-- ⚠️ 建議在資料表已有 ≥ 100 筆帶 embedding 的資料後才執行此步驟
-- lists 參數：小表建議 sqrt(rows)，100 為合理起點
CREATE INDEX IF NOT EXISTS events_embedding_idx
  ON events
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Step 3：建立 match_events RPC 函數 ───────────────────────
-- 輸入：query_embedding（待比對向量）、match_threshold（相似度閾值）、match_count（最多回傳幾筆）
-- 輸出：id, title, start_time, similarity（餘弦相似度 0–1，越接近 1 越像）
--
-- 使用方式（Python）：
--   supabase.rpc('match_events', {
--       'query_embedding': [0.1, 0.2, ...],   # 768 維 list
--       'match_threshold': 0.88,
--       'match_count': 5
--   }).execute()
CREATE OR REPLACE FUNCTION match_events(
  query_embedding  vector(768),
  match_threshold  float   DEFAULT 0.88,
  match_count      int     DEFAULT 5
)
RETURNS TABLE (
  id         uuid,
  title      text,
  start_time timestamptz,
  similarity float
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    id,
    title,
    start_time,
    1 - (embedding <=> query_embedding) AS similarity
  FROM events
  WHERE
    embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── 驗證：查詢函數是否建立成功 ───────────────────────────────
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name = 'match_events';
