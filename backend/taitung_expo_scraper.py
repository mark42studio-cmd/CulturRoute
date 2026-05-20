"""
2026 台東博覽會 (Taitung Expo 2026) 爬蟲
目標：https://taitungexpo2026.com.tw/about/overview?zone=1#list

pip install requests beautifulsoup4 playwright
playwright install chromium  # 僅 Playwright fallback 需要
"""

import json
import re
import time
import logging
from datetime import datetime
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

# ── 設定 ──────────────────────────────────────────────────────────────────────
BASE_URL    = "https://taitungexpo2026.com.tw"
EXPO_YEAR   = 2026
# 展覽預設時間：7/3 ~ 8/20（若頁面未提供日期則沿用）
EXPO_DEFAULT_START = f"{EXPO_YEAR}-07-03T00:00:00"
EXPO_DEFAULT_END   = f"{EXPO_YEAR}-08-20T23:59:59"

REQUEST_DELAY = 0.8   # 每次請求間隔秒數，禮貌爬蟲
MAX_RETRIES   = 3

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-TW,zh;q=0.9",
}

# 防呆攔截：含這些字串的欄位值不可進入日期欄位
DATE_BLOCKLIST = ["休館", "休息", "公休", "閉館", "暫停"]

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ── 日期轉換工具 ───────────────────────────────────────────────────────────────

def _is_blocked_date_str(s: str) -> bool:
    """偵測「每週一休館」等非日期字串，回傳 True 表示應攔截。"""
    return any(kw in s for kw in DATE_BLOCKLIST)


def _parse_date_token(token: str) -> Optional[datetime]:
    """
    支援格式：
      2026.7.3（週五）  →  datetime(2026,7,3)
      2026/7/3          →  datetime(2026,7,3)
      7/3               →  datetime(2026,7,3)   # 預設年份 EXPO_YEAR
      7-3               →  datetime(2026,7,3)
    """
    token = token.strip()
    if _is_blocked_date_str(token):
        return None

    # 全年份格式 YYYY.M.D 或 YYYY/M/D 或 YYYY-M-D
    m = re.search(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', token)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    # 短格式 M/D 或 M.D 或 M-D（補上 EXPO_YEAR）
    m = re.search(r'(\d{1,2})[/.\-](\d{1,2})', token)
    if m:
        return datetime(EXPO_YEAR, int(m.group(1)), int(m.group(2)))

    return None


def parse_date_range(raw: str) -> tuple[str, str]:
    """
    將 '2026.7.3（週五） ~ 2026.8.20（週四）' 等格式轉為
    (start_iso, end_iso)，例如
    ('2026-07-03T00:00:00', '2026-08-20T23:59:59')。
    若無法解析則回傳展覽預設日期。
    """
    raw = raw.strip()
    if _is_blocked_date_str(raw):
        log.warning("攔截非日期字串：%s，使用預設日期", raw)
        return EXPO_DEFAULT_START, EXPO_DEFAULT_END

    # 嘗試各種分隔符拆成兩段
    for sep in (' ~ ', '～', '–', '-', '至', '~'):
        parts = raw.split(sep, 1)
        if len(parts) == 2:
            start_dt = _parse_date_token(parts[0])
            end_dt   = _parse_date_token(parts[1])
            if start_dt and end_dt:
                return (
                    start_dt.strftime("%Y-%m-%dT00:00:00"),
                    end_dt.strftime("%Y-%m-%dT23:59:59"),
                )

    # 單一日期（點時間活動）
    single = _parse_date_token(raw)
    if single:
        return (
            single.strftime("%Y-%m-%dT00:00:00"),
            single.strftime("%Y-%m-%dT23:59:59"),
        )

    log.warning("無法解析日期：%r，使用預設日期", raw)
    return EXPO_DEFAULT_START, EXPO_DEFAULT_END


# ── HTTP 取頁工具 ──────────────────────────────────────────────────────────────

def fetch_html(url: str, use_playwright: bool = False) -> Optional[str]:
    """先嘗試 requests，失敗時自動切換 Playwright。"""
    if not use_playwright:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = requests.get(url, headers=HEADERS, timeout=15)
                resp.raise_for_status()
                # 確認內容是否已渲染（檢查關鍵 CSS class）
                if 'datas__item' in resp.text or 'project-thumbnails' in resp.text:
                    return resp.text
                log.info("requests 取到空頁，切換 Playwright：%s", url)
                break
            except requests.RequestException as e:
                log.warning("requests 失敗 [%d/%d] %s: %s", attempt, MAX_RETRIES, url, e)
                if attempt < MAX_RETRIES:
                    time.sleep(2 ** attempt)
        else:
            return None
        use_playwright = True

    # Playwright fallback
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(extra_http_headers={"Accept-Language": "zh-TW"})
            page.goto(url, wait_until="networkidle", timeout=30_000)
            # 等待展品列表元素出現
            try:
                page.wait_for_selector(".datas__item, .project-thumbnails, a[href*='/detail/']",
                                       timeout=10_000)
            except Exception:
                pass
            html = page.content()
            browser.close()
            return html
    except ImportError:
        log.error("playwright 未安裝，請執行：pip install playwright && playwright install chromium")
        return None
    except Exception as e:
        log.error("Playwright 失敗：%s - %s", url, e)
        return None


# ── 概覽頁：收集所有 detail 連結 ──────────────────────────────────────────────

def collect_detail_urls() -> list[str]:
    """巡覽 zone=1~8 的展覽概覽頁，收集所有 /about/overview/detail/{id} 的絕對 URL。"""
    seen: set[str] = set()
    result: list[str] = []

    for zone in range(1, 9):
        url = f"{BASE_URL}/about/overview?zone={zone}"
        log.info("掃描 zone=%d：%s", zone, url)
        html = fetch_html(url)
        if not html:
            log.warning("zone=%d 取頁失敗，略過", zone)
            continue

        soup = BeautifulSoup(html, "html.parser")
        for a in soup.find_all("a", href=re.compile(r"/about/overview/detail/\d+")):
            abs_url = urljoin(BASE_URL, a["href"])
            # 去掉 query/fragment，保留純路徑
            abs_url = abs_url.split("?")[0].split("#")[0]
            if abs_url not in seen:
                seen.add(abs_url)
                result.append(abs_url)
                log.debug("  找到：%s", abs_url)

        time.sleep(REQUEST_DELAY)

    log.info("共收集 %d 個展覽頁", len(result))
    return result


# ── 詳細頁：解析單一展覽 ──────────────────────────────────────────────────────

def _clean_text(el) -> str:
    """BeautifulSoup element → 去除多餘空白的純文字。"""
    return re.sub(r'\s+', ' ', el.get_text(separator=' ')).strip()


def parse_detail_page(url: str, html: str) -> Optional[dict]:
    """從展覽詳細頁 HTML 解析出結構化資料。"""
    soup = BeautifulSoup(html, "html.parser")

    # ── 標題 ──
    title_el = soup.select_one("div.title.f-title-primary, div.f-title-primary.is-pageTitle")
    if not title_el:
        # fallback：<h1> 或 og:title
        title_el = soup.find("h1")
    if not title_el:
        log.warning("找不到標題：%s", url)
        return None
    title = _clean_text(title_el)

    # ── 日期 ──
    date_el = soup.select_one("li.datas__item--date .content__text")
    if date_el:
        raw_date = _clean_text(date_el)
    else:
        raw_date = ""
    start_time, end_time = parse_date_range(raw_date) if raw_date else (EXPO_DEFAULT_START, EXPO_DEFAULT_END)

    # ── 時間（僅供參考，目前不存入獨立欄位）──
    time_el = soup.select_one("li.datas__item--time .content__text")
    open_hours = _clean_text(time_el) if time_el else ""

    # ── 地點 ──
    venue_el = soup.select_one("li.datas__item--location .content__text")
    venue_name = _clean_text(venue_el) if venue_el else "台東博覽會展區"

    # ── 性質標籤 ──
    natures = [
        _clean_text(s)
        for s in soup.select("li.datas__item--natures .content__list span")
    ]

    # ── 描述：合併「計畫概述」與「展覽簡介」──
    desc_blocks = []
    for section in soup.select(".m-subPage__summary"):
        section_title_el = section.select_one(".f-title-secondary")
        section_title = _clean_text(section_title_el) if section_title_el else ""
        editor = section.select_one(".customEditor")
        if editor:
            block_text = editor.get_text(separator="\n").strip()
            if section_title:
                desc_blocks.append(f"{section_title}\n{block_text}")
            else:
                desc_blocks.append(block_text)

    long_description = "\n\n".join(desc_blocks)
    # 短描述：跳過「▌計畫概述」等 section 標題，取第一段實際內容，上限 200 字
    description = ""
    for line in long_description.split("\n"):
        line = line.strip()
        if line and not line.startswith("▌"):
            description = line[:200] + ("…" if len(line) > 200 else "")
            break

    # ── 縮圖圖片 ──
    hero_img_el = soup.select_one(".m-subPage__hero img, .imageList--editor img")
    image_url = hero_img_el["src"] if hero_img_el and hero_img_el.get("src") else None

    # ── 組合輸出 ──
    return {
        "title":            title,
        "description":      description,
        "long_description": long_description,
        "start_time":       start_time,
        "end_time":         end_time,
        "open_hours":       open_hours,
        "venue_name":       venue_name,
        "source_url":       url,
        "image_captured":   image_url,
        "natures":          natures,
        # 架構師強制帶入的狀態鎖定欄位
        "time_type":        "期間限定",
        "category":         "展覽",
        # 預留分潤欄位（CLAUDE.md 規範）
        "affiliate_links": {
            "rental":        {"label": "租車/租機車",  "url": None},
            "ticket":        {"label": "售票連結",      "url": None},
            "accommodation": {"label": "周邊住宿",      "url": None},
        },
    }


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    log.info("=== 台東博覽會 2026 爬蟲啟動 ===")

    # Step 1：收集所有 detail URL
    detail_urls = collect_detail_urls()
    if not detail_urls:
        log.error("未取得任何展覽連結，中止")
        return

    # Step 2：逐頁抓取並解析
    results = []
    for i, url in enumerate(detail_urls, 1):
        log.info("[%d/%d] 抓取：%s", i, len(detail_urls), url)
        html = fetch_html(url)
        if not html:
            log.warning("取頁失敗，略過：%s", url)
            continue

        item = parse_detail_page(url, html)
        if item:
            results.append(item)
            log.info("  ✓ %s | %s | %s ~ %s",
                     item["title"], item["venue_name"],
                     item["start_time"][:10], item["end_time"][:10])
        else:
            log.warning("  ✗ 解析失敗：%s", url)

        time.sleep(REQUEST_DELAY)

    # Step 3：輸出 JSON
    output_path = "taitung_expo_2026.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    log.info("=== 完成！共 %d 筆，已寫入 %s ===", len(results), output_path)

    # 印出預覽
    print(f"\n共爬取 {len(results)} 筆展覽資料，輸出至 {output_path}")
    for item in results[:3]:
        print(f"  - {item['title']} | {item['venue_name']} | {item['start_time'][:10]}")
    if len(results) > 3:
        print(f"  ... 以及另外 {len(results) - 3} 筆")


if __name__ == "__main__":
    main()
