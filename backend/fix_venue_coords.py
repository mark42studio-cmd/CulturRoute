"""
fix_venue_coords.py
────────────────────────────────────────────────────────────────────────────────
一次性座標清洗腳本。

問題根因：爬蟲在找不到活動場地座標時，誤用了「發布來源網站（公所/館舍）」的
預設固定座標，導致地圖 Marker 偏移到錯誤位置。

本腳本做兩件事：
  1. WHITELIST 掃描：用場館名稱關鍵字從 Supabase 撈出受影響記錄，
     以精確硬編碼座標（venue_whitelist.py 同步來源）覆蓋更新。
  2. NULL 清洗：找出 latitude/longitude 與任何「已知錯誤固定點」完全吻合
     的記錄，將座標改為 NULL，讓前端 Geocoding 重新定位。

執行方式：
  cd backend
  python fix_venue_coords.py              # 完整執行（會寫入 DB）
  python fix_venue_coords.py --dry-run    # 只印出計劃，不寫入
"""

import os
import sys
import argparse
from dotenv import load_dotenv, find_dotenv
from supabase import create_client, Client

# ── 初始化 ────────────────────────────────────────────────────────────────────

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

load_dotenv(find_dotenv(), encoding="utf-8-sig")

supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()

if not supabase_url or not supabase_key:
    print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY not found. Check .env")
    sys.exit(1)

supabase: Client = create_client(supabase_url, supabase_key)


# ── 場館白名單（關鍵字 → 正確座標）─────────────────────────────────────────────
# 格式：("搜尋關鍵字（部分符合 venue_name）", 正確lat, 正確lng)
# 所有座標均以 Google Maps 人工核對。
KEYWORD_COORD_MAP: list[tuple[str, float, float]] = [
    # ── 台東市區主要場館 ──────────────────────────────────────────────────────
    ("台東生活美學館",      22.7576, 121.1445),
    ("生活美學館",          22.7576, 121.1445),
    ("台東美術館",          22.7561, 121.1498),
    ("台東縣立美術館",      22.7561, 121.1498),
    ("史前文化博物館",      22.7595, 121.1416),
    ("史前館",              22.7595, 121.1416),
    ("台東縣立圖書館",      22.7548, 121.1436),
    ("縣立圖書館",          22.7548, 121.1436),
    ("鐵花村",              22.7503, 121.1489),
    ("鐵花村音樂聚落",      22.7503, 121.1489),
    ("台東森林公園",        22.7473, 121.1680),
    ("活水湖",              22.7473, 121.1680),
    ("台東火車站",          22.7993, 121.1028),
    ("台東轉運站",          22.7993, 121.1028),
    # ── 獨立空間 ──────────────────────────────────────────────────────────────
    ("晃晃書店",            22.7545, 121.1452),
    ("晃晃二手書店",        22.7545, 121.1452),
    ("就藝會",              22.7533, 121.1481),
    ("the ARK",             22.7528, 121.1463),
    ("the ARK 方舟",        22.7528, 121.1463),
    # ── 都蘭聚落 ──────────────────────────────────────────────────────────────
    ("都蘭糖廠",            23.1278, 121.3768),
    ("好的擺",              23.1295, 121.3762),
    ("月光小棧",            23.1302, 121.3755),
    # ── 池上 ──────────────────────────────────────────────────────────────────
    ("江賢二藝術園區",      23.0985, 121.2255),
    ("池上穀倉藝術館",      23.0979, 121.2271),
    ("池上穀倉",            23.0979, 121.2271),
    # ── 鹿野 / 關山 ────────────────────────────────────────────────────────────
    ("鹿野高台",            23.0011, 121.1556),
    ("關山親水公園",        23.0530, 121.1666),
    # ── 成功 / 東河 ────────────────────────────────────────────────────────────
    ("成功鎮公所",          23.0989, 121.3741),
    ("東河鄉公所",          23.1015, 121.3645),
]

# ── 已知錯誤固定座標（這些是「發布來源」而非活動場地，應清為 NULL）────────────────
# 當活動的 lat/lng 精確符合這些點時，表示它是從 config_fixed_coords 抓來的假座標，
# 清為 NULL 讓前端 Geocoding 重新定位。
KNOWN_WRONG_FIXED_COORDS: list[tuple[float, float, str]] = [
    # (lat, lng, 說明)
    (22.7576, 121.1445, "台東生活美學館（常被誤用為活動場地預設點）"),
    (22.7593, 121.1430, "台東縣政府大樓"),
    (22.7997, 121.1018, "台東火車站附近公所預設點"),
]


# ── 核心函數 ──────────────────────────────────────────────────────────────────

def fetch_all_events() -> list[dict]:
    """分頁拉取 events 表所有資料（Supabase 單次上限 1000）。"""
    rows = []
    page = 0
    page_size = 1000
    while True:
        resp = (
            supabase.table("events")
            .select("id, venue_name, address, latitude, longitude")
            .range(page * page_size, (page + 1) * page_size - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return rows


def fix_by_venue_keyword(events: list[dict], dry_run: bool) -> int:
    """
    Pass 1：關鍵字掃描。
    venue_name 包含白名單關鍵字 → 更新為精確座標。
    """
    updated = 0
    for keyword, correct_lat, correct_lng in KEYWORD_COORD_MAP:
        matches = [
            e for e in events
            if (e.get("venue_name") or "") and keyword in (e.get("venue_name") or "")
        ]
        if not matches:
            continue

        for event in matches:
            cur_lat = event.get("latitude")
            cur_lng = event.get("longitude")
            # 已是正確座標（容忍 0.0001° ≈ 11m 誤差）→ 跳過
            if (cur_lat and cur_lng and
                    abs(cur_lat - correct_lat) < 0.0001 and
                    abs(cur_lng - correct_lng) < 0.0001):
                continue

            print(f"  ✏️  [{keyword}] {event['id'][:8]}…  "
                  f"({cur_lat}, {cur_lng})  →  ({correct_lat}, {correct_lng})")
            if not dry_run:
                supabase.table("events").update({
                    "latitude":  correct_lat,
                    "longitude": correct_lng,
                }).eq("id", event["id"]).execute()
            updated += 1

    return updated


def nullify_wrong_fixed_coords(events: list[dict], dry_run: bool) -> int:
    """
    Pass 2：已知錯誤固定點清除。
    lat/lng 精確符合「發布來源預設點」→ 改為 NULL（前端 Geocoding 接管）。
    """
    nullified = 0
    for wrong_lat, wrong_lng, desc in KNOWN_WRONG_FIXED_COORDS:
        matches = [
            e for e in events
            if (e.get("latitude") and e.get("longitude") and
                abs(e["latitude"] - wrong_lat) < 0.0001 and
                abs(e["longitude"] - wrong_lng) < 0.0001)
        ]
        if not matches:
            continue

        print(f"\n  🧹 清除已知錯誤固定點：{desc} ({wrong_lat}, {wrong_lng})")
        for event in matches:
            venue = event.get("venue_name", "未知")
            print(f"     → {event['id'][:8]}…  venue='{venue}'")
            if not dry_run:
                supabase.table("events").update({
                    "latitude":  None,
                    "longitude": None,
                }).eq("id", event["id"]).execute()
            nullified += 1

    return nullified


# ── 主程式 ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Supabase 場館座標清洗工具")
    parser.add_argument("--dry-run", action="store_true",
                        help="只印出計劃，不實際寫入 Supabase")
    args = parser.parse_args()

    dry_run: bool = args.dry_run
    mode_label = "[DRY-RUN]" if dry_run else "[LIVE]"
    print(f"\n{'='*60}")
    print(f"  fix_venue_coords.py  {mode_label}")
    print(f"{'='*60}\n")

    print("⬇️  拉取 events 表...")
    events = fetch_all_events()
    print(f"   共 {len(events)} 筆活動\n")

    # Pass 1：關鍵字修正
    print("─── Pass 1：場館關鍵字座標修正 ───────────────────────────────────")
    fixed = fix_by_venue_keyword(events, dry_run)
    print(f"   Pass 1 完成：{fixed} 筆更新{'（dry-run，未寫入）' if dry_run else ''}\n")

    # Pass 2：清除已知錯誤固定座標
    print("─── Pass 2：已知錯誤固定座標清除（→ NULL）────────────────────────")
    nullified = nullify_wrong_fixed_coords(events, dry_run)
    print(f"\n   Pass 2 完成：{nullified} 筆清除{'（dry-run，未寫入）' if dry_run else ''}\n")

    print("="*60)
    print(f"  總計：更新 {fixed} 筆 / 清除 {nullified} 筆")
    if dry_run:
        print("  ⚠️  Dry-run 模式，以上變更均未寫入資料庫。")
        print("  執行 python fix_venue_coords.py 以實際套用。")
    print("="*60)


if __name__ == "__main__":
    main()
