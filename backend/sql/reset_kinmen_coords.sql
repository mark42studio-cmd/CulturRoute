-- reset_kinmen_coords.sql
-- 將金峰鄉相關活動的座標清為 NULL，
-- 強迫前端 Geocoding 用新的「動態鄉鎮前綴」重新精準定位。
--
-- 執行方式：在 Supabase SQL Editor 貼上並執行
--
-- 涵蓋範圍：
--   1. venue_name 含「金峰」（場館在金峰鄉）
--   2. address 含「金峰」（地址在金峰鄉）
--   3. title 含「金峰」（活動名稱明確指向金峰）

UPDATE events
SET
  latitude  = NULL,
  longitude = NULL
WHERE
  venue_name LIKE '%金峰%'
  OR address  LIKE '%金峰%'
  OR title    LIKE '%金峰%';

-- 執行後可用以下查詢確認筆數：
-- SELECT id, title, venue_name, address, latitude, longitude
-- FROM events
-- WHERE venue_name LIKE '%金峰%' OR address LIKE '%金峰%' OR title LIKE '%金峰%';
