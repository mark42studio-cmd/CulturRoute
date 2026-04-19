"""
reset_db.py
───────────
清空 Supabase 中的 events 與 raw_threads_posts 資料表，保留結構。
執行前會要求二次確認，避免誤刪。

執行方式：
  python reset_db.py           # 互動確認後刪除
  python reset_db.py --yes     # 跳過確認（CI/自動化使用）
"""

import os
import argparse
from dotenv import load_dotenv, find_dotenv
from supabase import create_client, Client

load_dotenv(find_dotenv(), encoding="utf-8-sig")

supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
supabase: Client = create_client(supabase_url, supabase_key)

TABLES = ["events", "raw_threads_posts"]


def count_rows(table: str) -> int:
    try:
        result = supabase.table(table).select("id", count="exact").execute()
        return result.count or 0
    except Exception:
        return -1


def clear_table(table: str):
    """刪除表內所有資料（使用 neq id=0 避免 Supabase 的 RLS 限制）"""
    try:
        # Supabase REST API：delete 必須帶過濾條件，用 gt id=0 涵蓋所有正整數 id
        supabase.table(table).delete().gte("id", 0).execute()
        print(f"  ✅ {table} 已清空")
    except Exception as e:
        # fallback：有些表 id 非整數，改用 neq
        try:
            supabase.table(table).delete().neq("id", "___impossible___").execute()
            print(f"  ✅ {table} 已清空（fallback）")
        except Exception as e2:
            print(f"  ❌ {table} 清空失敗: {e2}")


def main(skip_confirm: bool = False):
    print("🗑️  資料庫重置工具")
    print("─" * 40)

    # 顯示目前筆數
    for table in TABLES:
        n = count_rows(table)
        label = f"{n} 筆" if n >= 0 else "（無法查詢）"
        print(f"  {table}: {label}")

    print()

    if not skip_confirm:
        ans = input("⚠️  確定要清空以上兩張表嗎？輸入 yes 確認：").strip().lower()
        if ans != "yes":
            print("已取消。")
            return

    print("\n開始清空...")
    for table in TABLES:
        clear_table(table)

    print("\n✅ 完成。資料庫已重置，可重新執行爬蟲。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="清空 events 與 raw_threads_posts")
    parser.add_argument("--yes", action="store_true", help="跳過互動確認（自動化用）")
    args = parser.parse_args()
    main(skip_confirm=args.yes)
