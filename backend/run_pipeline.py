"""
run_pipeline.py — CulturRoute 終極指揮官

依序啟動所有爬蟲階段，任一階段失敗不中斷後續。

階段一覽：
  1  官方網站爬蟲（多站台）  scraper.py
  2  美學館專屬爬蟲（輪播）  ttcsec_scraper.py
  3  鄉鎮公所爬蟲           township_scraper.py
  4  Apify FB/IG 爬蟲       apify_scraper.py
  5  Threads 巡邏爬蟲       threads_scraper.py
  6  AI 清洗待處理貼文       process_pending.py

用法：
  python run_pipeline.py                  # 全量執行（各爬蟲使用預設 limit）
  python run_pipeline.py --limit 15       # 壓力測試：每個爬蟲限制 15 筆
  python run_pipeline.py --limit 5        # 快速冒煙測試：每個爬蟲限制 5 筆
  python run_pipeline.py --skip 3,4       # 跳過第 3、4 階段
  python run_pipeline.py --only 2         # 只執行第 2 階段（美學館）
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime

# ── 階段定義 ──────────────────────────────────────────────────────────────────
# 每個 stage 格式：(序號, 名稱, 腳本, 額外固定參數)
# --limit 會由 run_pipeline 統一注入，格式依各腳本規格

STAGES = [
    (1, "🏛️  官方網站爬蟲（多站台）",    "scraper.py",          []),
    (2, "🎨  美學館專屬爬蟲（輪播）",    "ttcsec_scraper.py",   []),
    (3, "🏘️  鄉鎮公所爬蟲",            "township_scraper.py", []),
    (4, "📘  Apify FB/IG 爬蟲",        "apify_scraper.py",    []),
    (5, "🧵  Threads 巡邏爬蟲",        "threads_scraper.py",  []),
    (6, "🤖  AI 清洗待處理貼文",        "process_pending.py",  []),
]

# ── 各腳本 --limit 預設值（不帶 --limit 時的行為）───────────────────────────
# 0 / None = 不限制；正整數 = 預設上限
STAGE_DEFAULT_LIMIT = {
    "scraper.py":          0,    # 0 = 不限制
    "ttcsec_scraper.py":   0,    # 0 = 不限制（輪播會自動停在末頁）
    "township_scraper.py": 15,   # 壓力測試：每目標 15 筆
    "apify_scraper.py":    15,   # 壓力測試：每目標 15 筆
    "threads_scraper.py":  0,    # 0 = 不限制
    "process_pending.py":  None, # None = 不限制
}


def build_cmd(script: str, limit: int | None, extra: list[str]) -> list[str]:
    """組合呼叫指令，依各腳本規格注入 --limit。"""
    cmd = [sys.executable, script] + extra
    if limit is not None and limit > 0:
        cmd += ["--limit", str(limit)]
    return cmd


def run_stage(num: int, label: str, script: str, extra: list[str], limit: int | None) -> bool:
    """執行單一階段，回傳是否成功（returncode == 0）。"""
    cmd = build_cmd(script, limit, extra)
    print(f"\n{'─' * 60}")
    print(f"  階段 {num}：{label}")
    print(f"  指令：{' '.join(cmd)}")
    print(f"  開始：{datetime.now().strftime('%H:%M:%S')}")
    print(f"{'─' * 60}\n")

    start = time.time()
    result = subprocess.run(cmd, cwd=".", text=True)
    elapsed = time.time() - start

    status = "✅ 成功" if result.returncode == 0 else f"❌ 失敗（exit {result.returncode}）"
    print(f"\n  [{status}]  耗時 {elapsed:.1f}s")
    return result.returncode == 0


def parse_int_list(s: str) -> list[int]:
    return [int(x.strip()) for x in s.split(",") if x.strip().isdigit()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="CulturRoute 全流程爬蟲指揮官",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="覆蓋各爬蟲的 --limit 值（0 = 不限制；不填則用各爬蟲預設值）",
    )
    parser.add_argument(
        "--skip", type=str, default="",
        help="以逗號分隔的階段序號，略過這些階段（例：--skip 3,4）",
    )
    parser.add_argument(
        "--only", type=str, default="",
        help="只執行指定階段（例：--only 2 或 --only 1,5）",
    )
    args = parser.parse_args()

    skip_set = set(parse_int_list(args.skip)) if args.skip else set()
    only_set = set(parse_int_list(args.only)) if args.only else set()

    print("╔══════════════════════════════════════════════════════════╗")
    print("║        CulturRoute 全流程指揮官  🗺️   台東藝文爬蟲        ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print(f"  啟動時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if args.limit is not None:
        print(f"  全域 --limit：{args.limit if args.limit > 0 else '不限制（0）'}")
    if skip_set:
        print(f"  跳過階段：{sorted(skip_set)}")
    if only_set:
        print(f"  僅執行階段：{sorted(only_set)}")

    results: list[tuple[int, str, bool | None]] = []

    total_start = time.time()

    for num, label, script, extra in STAGES:
        # 篩選要執行的階段
        if only_set and num not in only_set:
            results.append((num, label, None))  # None = 跳過
            continue
        if num in skip_set:
            results.append((num, label, None))
            continue

        # 決定 limit：CLI 覆蓋 > 各腳本預設
        effective_limit = args.limit if args.limit is not None else STAGE_DEFAULT_LIMIT.get(script)

        ok = run_stage(num, label, script, extra, effective_limit)
        results.append((num, label, ok))

    total_elapsed = time.time() - total_start

    # ── 結果摘要 ──────────────────────────────────────────────────────────────
    print(f"\n\n{'═' * 60}")
    print("  執行結果摘要")
    print(f"{'═' * 60}")
    success_count = 0
    fail_count = 0
    skip_count = 0
    for num, label, ok in results:
        if ok is None:
            icon = "⏭️ "
            skip_count += 1
        elif ok:
            icon = "✅"
            success_count += 1
        else:
            icon = "❌"
            fail_count += 1
        print(f"  {icon}  階段 {num}：{label}")

    print(f"\n  總耗時：{total_elapsed / 60:.1f} 分鐘")
    print(f"  成功 {success_count} ／ 失敗 {fail_count} ／ 跳過 {skip_count}")
    print(f"{'═' * 60}\n")

    # 若有任一階段失敗，以非零碼退出（方便 CI/排程器感知）
    sys.exit(0 if fail_count == 0 else 1)


if __name__ == "__main__":
    main()
