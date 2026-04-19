"""
fix_dulan.py
─────────────────────────────────────────────────────────────────
修正 events 表中被誤標為「台東美術館」的都蘭相關活動。

問題根源：
  - 台東美術館座標約 (22.757, 121.154)，位於台東市
  - 都蘭文創園區（都蘭糖廠）座標約 (22.903, 121.240)，位於東河鄉
  - 若某筆活動標題/描述含「都蘭」卻被定位到美術館座標，即為誤標

執行方式：
  python fix_dulan.py           # 預覽模式（dry-run，不寫入）
  python fix_dulan.py --apply   # 實際寫入 Supabase
"""

import os
import argparse
from dotenv import load_dotenv, find_dotenv
from supabase import create_client, Client

load_dotenv(find_dotenv(), encoding="utf-8-sig")

supabase: Client = create_client(
    os.getenv("SUPABASE_URL").strip(),
    os.getenv("SUPABASE_SERVICE_KEY").strip(),
)

# ── 正確的都蘭文創園區資訊 ────────────────────────────────────────────────────
DULAN_CORRECT = {
    "venue_name": "都蘭文創園區",
    "address":    "台東縣東河鄉都蘭村44號",   # 都蘭糖廠舊址
    "latitude":   22.9027,
    "longitude":  121.2398,
}

# 美術館座標的容忍範圍（若活動座標落在此範圍內視為誤標）
MUSEUM_LAT_RANGE = (22.74, 22.77)
MUSEUM_LON_RANGE = (121.14, 121.17)


def is_museum_coords(lat, lon) -> bool:
    if lat is None or lon is None:
        return False
    return (MUSEUM_LAT_RANGE[0] <= lat <= MUSEUM_LAT_RANGE[1] and
            MUSEUM_LON_RANGE[0] <= lon <= MUSEUM_LON_RANGE[1])


def main(apply: bool):
    mode = "✍️  套用模式" if apply else "👁️  預覽模式（加 --apply 才會寫入）"
    print(f"🔍 都蘭活動資料修正工具 — {mode}\n")

    # 抓取標題或場地名稱含「都蘭」的活動
    resp = supabase.table("events").select(
        "id, title, venue_name, address, latitude, longitude"
    ).execute()

    candidates = [
        row for row in (resp.data or [])
        if "都蘭" in (row.get("title") or "") or "都蘭" in (row.get("venue_name") or "")
    ]

    if not candidates:
        print("✨ 找不到含「都蘭」的活動，無需修正。")
        return

    fixed_count = 0
    for row in candidates:
        lat = row.get("latitude")
        lon = row.get("longitude")
        venue = row.get("venue_name", "")

        needs_coord_fix  = is_museum_coords(lat, lon)
        needs_venue_fix  = "美術館" in venue

        issues = []
        if needs_coord_fix:  issues.append(f"座標誤指美術館 ({lat:.4f}, {lon:.4f})")
        if needs_venue_fix:  issues.append(f"場館名稱誤標為「{venue}」")

        if not issues:
            print(f"  ✅ id={row['id']}「{row['title']}」— 無需修正")
            continue

        print(f"  ⚠️  id={row['id']}「{row['title']}」")
        for issue in issues:
            print(f"       問題：{issue}")
        print(f"       修正為：{DULAN_CORRECT['venue_name']}  ({DULAN_CORRECT['latitude']}, {DULAN_CORRECT['longitude']})")

        if apply:
            patch = {
                "venue_name": DULAN_CORRECT["venue_name"],
                "address":    DULAN_CORRECT["address"],
                "latitude":   DULAN_CORRECT["latitude"],
                "longitude":  DULAN_CORRECT["longitude"],
            }
            supabase.table("events").update(patch).eq("id", row["id"]).execute()
            print("       → 已更新 ✔")
            fixed_count += 1

    if apply:
        print(f"\n✅ 共修正 {fixed_count} 筆")
    else:
        print("\nℹ️  預覽完畢。執行 python fix_dulan.py --apply 套用修正。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="修正都蘭活動被誤標為美術館的座標與名稱")
    parser.add_argument("--apply", action="store_true", help="實際寫入 Supabase（預設只預覽）")
    args = parser.parse_args()
    main(apply=args.apply)
