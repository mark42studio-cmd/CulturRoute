"""
taitung_tourism_scraper.py — 台東觀光旅遊網活動行事曆爬蟲

目標：https://tour.taitung.gov.tw/zh-tw/event-calendar/2026
策略：
  1. 逐月巡覽 2026 全年（1–12 月），收集活動詳情連結
  2. 逐頁 AI 萃取結構化活動資訊
  3. 向量語意去重後寫入 Supabase

用法：
  python taitung_tourism_scraper.py
  python taitung_tourism_scraper.py --dry-run   # 預覽不寫入
  python taitung_tourism_scraper.py --month 4   # 只抓指定月份
"""

import os
import re
import sys
import time
import json
import argparse
import requests
import urllib3
from datetime import datetime
from urllib.parse import urljoin

from dotenv import load_dotenv, find_dotenv
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
from playwright_stealth import Stealth

# ── 共用函式匯入 ─────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))
from scraper import (
    ai_data_cleaner,
    client,       # genai.Client
    supabase,     # Supabase Client
)
from db_utils import upsert_event, map_legacy_fields

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

# ── 常數 ──────────────────────────────────────────────────────────────────────

BASE_URL      = "https://tour.taitung.gov.tw"
CALENDAR_BASE = f"{BASE_URL}/zh-tw/event-calendar/2026"

# 台東觀光旅遊網活動行事曆在 URL 以 ?month=N 切換月份
# 若網站改版可在此調整
MONTH_PARAM   = "month"

# 活動詳情連結通常包含 /event/ 或 /activity/ 路徑片段
EVENT_PATH_PATTERNS = ["/event", "/activity", "/EventCalendar", "/event-calendar/"]

# 判定為「非活動詳情頁」的路徑（避免抓到列表頁本身）
EXCLUDE_PATHS = ["/event-calendar/2026"]


# ── 輔助函式 ──────────────────────────────────────────────────────────────────

def is_event_detail_url(url: str) -> bool:
    """判斷 URL 是否為活動詳情頁（而非列表頁）。"""
    path = url.replace(BASE_URL, "")
    if any(path.startswith(ex) and path == ex for ex in EXCLUDE_PATHS):
        return False
    # 詳情頁通常含數字 ID 或 /event/ 路徑
    has_event_path = any(p.lower() in url.lower() for p in EVENT_PATH_PATTERNS)
    has_numeric_id = bool(re.search(r"/\d{4,}", url))
    return has_event_path or has_numeric_id


def collect_event_links_from_page(soup: BeautifulSoup, already_seen: set) -> list[str]:
    """從單一列表頁 HTML 蒐集活動詳情連結（去重）。"""
    found = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        full = urljoin(BASE_URL, href) if not href.startswith("http") else href
        # 只保留同域連結
        if not full.startswith(BASE_URL):
            continue
        if full in already_seen:
            continue
        if not is_event_detail_url(full):
            continue
        found.append(full)
        already_seen.add(full)
    return found


# ── 核心：逐月列表爬取 ────────────────────────────────────────────────────────

def collect_all_event_links(page, target_months: list[int]) -> list[str]:
    """
    依序載入每個月份的行事曆頁，蒐集所有活動詳情連結。
    target_months：要抓的月份清單，例如 list(range(1, 13))。
    """
    all_links: list[str] = []
    seen: set[str] = set()

    for month in target_months:
        month_url = f"{CALENDAR_BASE}?{MONTH_PARAM}={month}"
        print(f"\n📅 載入 {month} 月行事曆：{month_url}")

        try:
            page.goto(month_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)  # 等待動態內容渲染
        except Exception as e:
            print(f"   ⚠️  {month} 月頁面載入失敗：{e}")
            continue

        # 嘗試點擊「載入更多」或滾動以觸發懶載入
        for _ in range(3):
            try:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(1200)
            except Exception:
                break

        soup = BeautifulSoup(page.content(), "html.parser")
        new_links = collect_event_links_from_page(soup, seen)
        all_links.extend(new_links)
        print(f"   → 本月新增 {len(new_links)} 筆連結，累計 {len(all_links)} 筆")

        time.sleep(2)  # 避免對伺服器過度請求

    return all_links


# ── 圖片擷取（與 scraper.py 一致）────────────────────────────────────────────

EXTRACT_IMAGE_JS = """() => {
    const BLACKLIST = ['banner', 'default', 'logo', 'bg', 'footer', 'header', 'icon', 'placeholder'];
    const isBlacklisted = (src) => {
        if (!src) return true;
        const lower = src.toLowerCase();
        return BLACKLIST.some(kw => lower.includes(kw));
    };
    const getSrc = (el) => el.getAttribute('data-src') || el.getAttribute('data-original') || el.src || '';
    const area = (img) => (img.naturalWidth || img.width) * (img.naturalHeight || img.height);

    const contentImgs = new Set();
    const selectors = [
        'article img', '.content img', '.editor img',
        '.post-content img', '.activity img', '.main-content img',
        '.news-content img', '.detail img', 'main img'
    ];
    for (const sel of selectors)
        document.querySelectorAll(sel).forEach(img => contentImgs.add(img));

    let best = null, maxArea = 0;
    for (const img of contentImgs) {
        const src = getSrc(img);
        if (isBlacklisted(src)) continue;
        const a = area(img);
        if (a > maxArea) { maxArea = a; best = img; }
    }
    if (best) return getSrc(best);

    const ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg && ogImg.content && !isBlacklisted(ogImg.content)) return ogImg.content;

    for (const img of document.querySelectorAll('img')) {
        if (contentImgs.has(img)) continue;
        const src = getSrc(img);
        if (isBlacklisted(src)) continue;
        const a = area(img);
        if (a > maxArea) { maxArea = a; best = img; }
    }
    return best ? getSrc(best) : '';
}"""


# ── 核心：逐頁 AI 萃取並寫入 ─────────────────────────────────────────────────

def scrape_and_store(event_urls: list[str], dry_run: bool = False, limit: int = 0):
    """
    逐一造訪活動詳情頁，呼叫 AI 萃取後寫入 Supabase。
    """
    cap = limit if limit > 0 else len(event_urls)
    targets = event_urls[:cap]

    print(f"\n🚀 開始逐頁萃取，共 {len(targets)} 筆活動")

    with Stealth().use_sync(sync_playwright()) as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            for i, url in enumerate(targets, 1):
                print(f"\n[{i}/{len(targets)}] 🚪 潛入活動頁：{url}")
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(2500)

                    img_url = page.evaluate(EXTRACT_IMAGE_JS) or ""
                    if img_url and not img_url.startswith("http"):
                        img_url = urljoin(url, img_url)
                    print(f"   🖼️  圖片：{img_url or '（未取得）'}")

                    raw_text = page.locator("body").inner_text()
                    event_json = ai_data_cleaner(raw_text, img_url, url)

                    if event_json is None:
                        print("   ⚠️  AI 回傳空值，略過")
                    elif isinstance(event_json, dict) and event_json.get("status") == "ignore":
                        print("   🚫 AI 守門員：無效內容，跳過")
                    else:
                        print("   ✨ 準備寫入資料庫...")
                        events = event_json if isinstance(event_json, list) else [event_json]
                        for ev in events:
                            mapped = map_legacy_fields(ev)
                            upsert_event(
                                llm_data=mapped,
                                system_fields={
                                    "source_url":  url,
                                    "source_name": "台東觀光旅遊網",
                                    "image_url":   ev.get("image_url", img_url),
                                },
                                supabase=supabase,
                                google_maps_key=os.getenv("GOOGLE_MAPS_API_KEY", ""),
                                dry_run=dry_run,
                            )

                except Exception as e:
                    print(f"   ⚠️  頁面處理失敗（跳過）：{e}")
                    try:
                        page = context.new_page()
                        print("   🔄 已重建頁面，繼續下一站")
                    except Exception:
                        try:
                            page = browser.new_context().new_page()
                        except Exception as rebuild_err:
                            print(f"   🚨 瀏覽器已崩潰，中止觀光網爬取：{rebuild_err}")
                            break

                time.sleep(12)

        finally:
            try:
                browser.close()
            except Exception:
                pass  # 瀏覽器已崩潰，忽略關閉失敗


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="台東觀光旅遊網 2026 活動行事曆爬蟲")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="執行爬取與 AI 清洗，但不寫入資料庫（安全預覽）",
    )
    parser.add_argument(
        "--month", type=int, default=0,
        help="只抓指定月份（1–12），預設抓全年",
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="最多處理幾筆連結（0 = 無限制）",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("⚠️  [DRY-RUN 模式] 本次不寫入資料庫")

    target_months = [args.month] if args.month else list(range(1, 13))
    print(f"🗓️  目標月份：{target_months}")
    print(f"🔗 入口：{CALENDAR_BASE}")

    # Phase 1：收集所有活動連結
    all_links: list[str] = []
    with Stealth().use_sync(sync_playwright()) as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        try:
            all_links = collect_all_event_links(page, target_months)
        except Exception as e:
            print(f"❌ 連結收集階段發生錯誤：{e}")
        finally:
            try:
                browser.close()
            except Exception:
                pass  # 瀏覽器已崩潰，忽略關閉失敗

    print(f"\n🔎 全年共蒐集 {len(all_links)} 筆活動連結")

    if not all_links:
        print("⚠️  未蒐集到任何連結，請確認網站結構或 VPN 連線狀態")
        return

    # Phase 2：逐頁萃取並寫入
    scrape_and_store(all_links, dry_run=args.dry_run, limit=args.limit)

    print(f"\n✅ 台東觀光旅遊網爬蟲完成  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == "__main__":
    main()
