"""
run_all_scrapers.py — 一鍵依序執行所有 CulturRoute 爬蟲

用法：
  python run_all_scrapers.py           # 全量執行
  python run_all_scrapers.py --skip 4  # 跳過第 4 項（Apify，需付費 key）
"""

import subprocess
import sys
import time
from datetime import datetime

SCRAPERS = [
    (1, "官方網站爬蟲（scraper.py）",                    "scraper.py"),
    (2, "美學館輪播爬蟲（ttcsec_scraper.py）",           "ttcsec_scraper.py"),
    (3, "鄉鎮公所爬蟲（township_scraper.py）",           "township_scraper.py"),
    (4, "台東觀光旅遊網（taitung_tourism_scraper.py）",  "taitung_tourism_scraper.py"),
    (5, "Apify FB/IG 爬蟲（apify_scraper.py）",          "apify_scraper.py"),
    (6, "Threads 巡邏爬蟲（threads_scraper.py）",        "threads_scraper.py"),
    (7, "AI 清洗待處理貼文（process_pending.py）",       "process_pending.py"),
    (8, "Google Maps 景點/美食（Maps_scraper.py）",      "Maps_scraper.py"),
]

def parse_skip(args: list[str]) -> set[int]:
    skip: set[int] = set()
    for i, arg in enumerate(args):
        if arg == "--skip" and i + 1 < len(args):
            for s in args[i + 1].split(","):
                if s.strip().isdigit():
                    skip.add(int(s.strip()))
    return skip


def main() -> None:
    skip_set = parse_skip(sys.argv[1:])

    print("=" * 60)
    print("  CulturRoute 一鍵爬蟲啟動器")
    print(f"  啟動時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if skip_set:
        print(f"  跳過階段：{sorted(skip_set)}")
    print("=" * 60)

    results: list[tuple[int, str, bool | None]] = []
    total_start = time.time()

    for num, label, script in SCRAPERS:
        if num in skip_set:
            print(f"\n⏭️  [跳過] 第 {num} 項：{label}")
            results.append((num, label, None))
            continue

        print(f"\n▶  正在執行第 {num} 項：{label}")
        print(f"   開始時間：{datetime.now().strftime('%H:%M:%S')}")
        t0 = time.time()
        result = subprocess.run([sys.executable, script], cwd=".", text=True)
        elapsed = time.time() - t0

        ok = result.returncode == 0
        status = "✅ 執行完畢" if ok else f"❌ 失敗（exit {result.returncode}）"
        print(f"   {status}  耗時 {elapsed:.1f}s")
        results.append((num, label, ok))

    total_elapsed = time.time() - total_start

    print(f"\n{'=' * 60}")
    print("  執行結果摘要")
    print(f"{'=' * 60}")
    success, fail, skip = 0, 0, 0
    for num, label, ok in results:
        if ok is None:
            print(f"  ⏭️   第 {num} 項：{label}（跳過）")
            skip += 1
        elif ok:
            print(f"  ✅  第 {num} 項：{label}")
            success += 1
        else:
            print(f"  ❌  第 {num} 項：{label}")
            fail += 1

    print(f"\n  總耗時：{total_elapsed / 60:.1f} 分鐘")
    print(f"  成功 {success} ／ 失敗 {fail} ／ 跳過 {skip}")
    print(f"{'=' * 60}\n")

    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
