"""
fix_dates.py
將資料庫中 start_time 在 2026 年之前的活動，全部修正到 2026 年 4 月份，
確保測試 4/12 ~ 4/17 區間時能看到資料。

用法：
  python backend/fix_dates.py          # Dry-run，只顯示會修改的資料
  python backend/fix_dates.py --apply  # 實際寫入 Supabase
"""

import os, sys, random
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
DRY_RUN = '--apply' not in sys.argv

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 將舊事件映射到 2026 年 4 月的起始日（隨機分佈在 4/1 ~ 4/20 之間）
APRIL_2026_START = datetime(2026, 4, 1)
APRIL_2026_END   = datetime(2026, 4, 20)


def random_april_date() -> datetime:
    delta = (APRIL_2026_END - APRIL_2026_START).days
    return APRIL_2026_START + timedelta(days=random.randint(0, delta))


def fix_event(event: dict) -> dict | None:
    """
    若 start_time 不在 2026 年，回傳需要更新的 payload；否則回傳 None。
    """
    start_str = event.get('start_time', '')
    if not start_str:
        return None

    try:
        # 支援帶時區的 ISO 字串
        start_dt = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
    except ValueError:
        print(f"  [SKIP] 無法解析時間: {event['id']} — {start_str!r}")
        return None

    if start_dt.year == 2026:
        return None  # 已是 2026，不需更新

    # 計算活動原本持續天數
    end_str = event.get('end_time') or start_str
    try:
        end_dt = datetime.fromisoformat(end_str.replace('Z', '+00:00'))
        duration = end_dt - start_dt
    except ValueError:
        duration = timedelta(hours=2)

    # 產生新起始時間（保留原有時分秒，只換日期）
    new_start = random_april_date().replace(
        hour=start_dt.hour, minute=start_dt.minute, second=0, microsecond=0
    )
    new_end = new_start + duration

    # 格式化（加上 +08:00 台灣時區）
    def fmt(dt: datetime) -> str:
        return dt.strftime('%Y-%m-%dT%H:%M:%S+08:00')

    payload: dict = {
        'start_time': fmt(new_start),
        'end_time':   fmt(new_end),
    }

    # 若有 end_date 欄位，也一起更新
    if event.get('end_date'):
        try:
            old_end_date = datetime.fromisoformat(event['end_date'])
            diff = old_end_date - start_dt.replace(tzinfo=None)
            new_end_date = new_start + diff
            payload['end_date'] = new_end_date.strftime('%Y-%m-%d')
        except ValueError:
            pass

    return payload


def main():
    print(f"{'[DRY-RUN] ' if DRY_RUN else '[APPLY] '}掃描資料庫中 2026 年以前的活動...")

    # 取得所有活動（只取必要欄位）
    result = supabase.table('events').select('id, title, start_time, end_time, end_date').execute()
    events = result.data or []
    print(f"共 {len(events)} 筆活動")

    to_fix = []
    for ev in events:
        payload = fix_event(ev)
        if payload:
            to_fix.append((ev, payload))

    if not to_fix:
        print("沒有需要修正的活動，全部已在 2026 年。")
        return

    print(f"\n需要修正：{len(to_fix)} 筆")
    print("-" * 70)
    for ev, payload in to_fix:
        print(f"  [{ev['id'][:8]}…] {ev['title'][:40]}")
        print(f"    舊 start_time: {ev['start_time']}")
        print(f"    新 start_time: {payload['start_time']}")
        if 'end_date' in payload:
            print(f"    新 end_date:   {payload['end_date']}")
    print("-" * 70)

    if DRY_RUN:
        print("\n[DRY-RUN] 未實際修改。加上 --apply 參數來寫入。")
        return

    print("\n寫入中...")
    success = 0
    for ev, payload in to_fix:
        try:
            supabase.table('events').update(payload).eq('id', ev['id']).execute()
            print(f"  ✓ {ev['title'][:40]}")
            success += 1
        except Exception as e:
            print(f"  ✗ {ev['title'][:40]} — 錯誤: {e}")

    print(f"\n完成！成功更新 {success}/{len(to_fix)} 筆活動。")


if __name__ == '__main__':
    main()
