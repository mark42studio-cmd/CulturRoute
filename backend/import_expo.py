"""
import_expo.py — 將 taitung_expo_2026.json 匯入 Supabase events 表

pip install python-dotenv supabase requests

用法：
  python import_expo.py               # 正式匯入
  python import_expo.py --dry-run     # 試跑，不寫入 DB
  python import_expo.py --json other.json  # 指定其他 JSON 檔
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Windows PowerShell 預設 cp950，強制切換為 UTF-8 避免 emoji print 噴錯
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import find_dotenv, load_dotenv
from supabase import create_client

from db_utils import upsert_event

# ── 載入環境變數 ──────────────────────────────────────────────────────────────
load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = (os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY") or "").strip()
GOOGLE_MAPS_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()

SOURCE_NAME = "2026台東博覽會"
DEFAULT_JSON = Path(__file__).parent / "taitung_expo_2026.json"


def _build_llm_data(item: dict) -> dict:
    """
    將爬蟲 JSON 欄位對應到 upsert_event 期望的 llm_data 格式。
    欄位差異：
      open_hours      → opening_hours
      natures (list)  → sub_category（濾掉全形 ＃ 前綴）
    """
    # 清理 natures 標籤（去除 ＃ 前綴），作為 sub_category 陣列
    raw_natures = item.get("natures") or []
    sub_category = [n.lstrip("＃#").strip() for n in raw_natures if n.strip()]

    return {
        "title":            item.get("title", "").strip(),
        "description":      item.get("description", "").strip(),
        "long_description": item.get("long_description", "").strip(),
        "start_time":       item.get("start_time"),
        "end_time":         item.get("end_time"),
        "end_date":         (item.get("end_time") or "")[:10] or None,
        "opening_hours":    item.get("open_hours"),        # 欄位名稱轉換
        "venue_name":       item.get("venue_name", "").strip(),
        "time_type":        item.get("time_type", "期間限定"),
        "category":         item.get("category", "展覽"),
        "sub_category":     sub_category,
        "is_free":          item.get("is_free", True),
        "region":           item.get("region"),
        "address":          item.get("address"),
        "latitude":         item.get("latitude"),
        "longitude":        item.get("longitude"),
    }


def _build_system_fields(item: dict) -> dict:
    return {
        "source_url":  item.get("source_url", "").strip(),
        "source_name": SOURCE_NAME,
        "image_url":   (item.get("image_captured") or "").strip(),
    }


def main():
    parser = argparse.ArgumentParser(description="匯入 2026 台東博覽會資料至 Supabase")
    parser.add_argument("--dry-run", action="store_true", help="試跑模式，不寫入資料庫")
    parser.add_argument("--json", dest="json_path", default=str(DEFAULT_JSON),
                        help=f"JSON 檔案路徑（預設：{DEFAULT_JSON.name}）")
    args = parser.parse_args()

    # ── 前置檢查 ──────────────────────────────────────────────────────────────
    json_path = Path(args.json_path)
    if not json_path.exists():
        print(f"[ERR] 找不到 JSON 檔案：{json_path}")
        sys.exit(1)

    if not args.dry_run:
        if not SUPABASE_URL:
            print("[ERR] 找不到 SUPABASE_URL，請確認 .env 檔案")
            sys.exit(1)
        if not SUPABASE_KEY:
            print("[ERR] 找不到 SUPABASE_SERVICE_KEY，請確認 .env 檔案")
            sys.exit(1)

    # ── 讀取 JSON ─────────────────────────────────────────────────────────────
    with open(json_path, encoding="utf-8") as f:
        events = json.load(f)

    if not isinstance(events, list):
        print("[ERR] JSON 格式錯誤：預期為陣列")
        sys.exit(1)

    print(f"[INFO] 讀取 {len(events)} 筆展覽資料：{json_path.name}")
    if args.dry_run:
        print("[INFO] DRY RUN 模式 — 不會寫入資料庫\n")

    # ── 建立 Supabase 連線 ────────────────────────────────────────────────────
    supabase = None
    if not args.dry_run:
        try:
            supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        except Exception as e:
            print(f"[ERR] Supabase 連線失敗：{e}")
            sys.exit(1)

    # ── 逐筆 upsert ───────────────────────────────────────────────────────────
    counts = {"inserted": 0, "updated": 0, "skipped": 0, "error": 0}

    for i, item in enumerate(events, 1):
        title_preview = (item.get("title") or "（無標題）")[:30]
        print(f"[{i:02d}/{len(events)}] {title_preview}")

        llm_data     = _build_llm_data(item)
        system_fields = _build_system_fields(item)

        result = upsert_event(
            llm_data,
            system_fields,
            supabase,                      # dry_run 時傳 None，upsert_event 有 dry_run 旗標處理
            google_maps_key=GOOGLE_MAPS_KEY,
            dry_run=args.dry_run,
        )
        counts[result] = counts.get(result, 0) + 1

    # ── 結果摘要 ──────────────────────────────────────────────────────────────
    total_ok = counts["inserted"] + counts["updated"]
    print()
    if args.dry_run:
        print(f"[DRY RUN] 預計可匯入 {total_ok} 筆（新增 {counts['inserted']}，更新 {counts['updated']}）")
    else:
        print(f"[OK] 成功匯入了 {total_ok} 筆資料（新增 {counts['inserted']}，更新 {counts['updated']}）")
    if counts["skipped"]:
        print(f"[SKIP] 略過 {counts['skipped']} 筆（title/start_time 缺失）")
    if counts["error"]:
        print(f"[ERR] 失敗 {counts['error']} 筆（請查看上方錯誤訊息）")


if __name__ == "__main__":
    main()
