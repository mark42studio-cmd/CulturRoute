import os
import re
import time
import json
import argparse
import requests
import hashlib
import urllib3
import unicodedata
from dotenv import load_dotenv, find_dotenv
from playwright.sync_api import sync_playwright
from urllib.parse import urljoin, urlparse, urlencode, parse_qs, urlunparse
from bs4 import BeautifulSoup
from google import genai
from google.genai import types
from playwright_stealth import Stealth
from supabase import create_client, Client
from venue_whitelist import lookup_venue_coords
from db_utils import upsert_event

# 🌟 關閉煩人的 SSL 憑證黃字警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 自動尋找 .env，並加入 utf-8-sig 破解隱形字元
load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

supabase_url = os.getenv("SUPABASE_URL").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY").strip()
gemini_key       = os.getenv("GEMINI_API_KEY").strip()
google_maps_key  = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()

if not supabase_url or not supabase_key:
    print("❌ 嚴重錯誤：讀不到 SUPABASE_URL，請檢查 .env 檔案！")
    exit()

client = genai.Client(api_key=gemini_key)
supabase: Client = create_client(supabase_url, supabase_key)

# ── Geocoding：白名單 + Google Places API ────────────────────────────────────

_TAITUNG_KEYWORDS = ("台東", "臺東")
_YELLOW = "\033[33m"
_RESET  = "\033[0m"


def get_coordinates(location_name: str) -> tuple:
    """
    查詢場館座標。優先層級：白名單 > Google Places API。
    地址不含台東 → 回傳哨兵 ("FILTERED", None)，呼叫端應捨棄該活動。
    """
    if not location_name or location_name in ("未提供", ""):
        return None, None

    lat, lng = lookup_venue_coords(location_name)
    if lat and lng:
        return lat, lng

    if not google_maps_key:
        return None, None

    query = (location_name if any(k in location_name for k in _TAITUNG_KEYWORDS)
             else f"台東 {location_name}")
    api_url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type":     "application/json",
        "X-Goog-Api-Key":   google_maps_key,
        "X-Goog-FieldMask": "places.displayName.text,places.location,places.formattedAddress",
    }
    body = {"textQuery": query, "languageCode": "zh-TW", "maxResultCount": 1}
    try:
        resp = requests.post(api_url, json=body, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if "places" in data and data["places"]:
            place          = data["places"][0]
            loc            = place.get("location", {})
            lat            = loc.get("latitude")
            lng            = loc.get("longitude")
            name           = place.get("displayName", {}).get("text", "")
            formatted_addr = place.get("formattedAddress", "")
            if formatted_addr and not any(k in formatted_addr for k in _TAITUNG_KEYWORDS):
                print(f"{_YELLOW}  [過濾] 地點不在台東 (地址: {formatted_addr})，已捨棄。{_RESET}")
                return "FILTERED", None  # type: ignore[return-value]
            if lat and lng:
                print(f"  📍 Google Places：{name} ({formatted_addr}) → ({lat:.5f}, {lng:.5f})")
                return lat, lng
    except Exception as e:
        print(f"  ⚠️ Google Places 查詢失敗 ({location_name}): {e}")
    return None, None


# ── 語意去重：Embedding 向量生成 ─────────────────────────────────────────────

def generate_embedding(text: str) -> list | None:
    """
    呼叫 Gemini models/gemini-embedding-001（google.genai 新版 SDK），
    將文字轉為浮點向量。
    失敗時回傳 None，主流程繼續但該筆不做語意去重。
    """
    max_retries = 3
    for attempt in range(max_retries):
        try:
            result = client.models.embed_content(
                model="models/gemini-embedding-001",
                contents=text,
            )
            return list(result.embeddings[0].values)
        except Exception as e:
            err = str(e)
            if "429" in err or "RESOURCE_EXHAUSTED" in err:
                print(f"⏳ Embedding rate limit，等待 60s... ({attempt + 1}/{max_retries})")
                time.sleep(60)
            elif any(c in err for c in ("500", "503", "INTERNAL", "UNAVAILABLE")):
                wait = 5 * (2 ** attempt)  # 5 → 10 → 20 秒
                print(f"⏳ Embedding 暫時錯誤，{wait}s 後重試... ({attempt + 1}/{max_retries})")
                time.sleep(wait)
            else:
                print(f"⚠️  Embedding 生成失敗（不中斷主流程）：{e}")
                return None
    return None


def check_semantic_duplicate(
    embedding: list,
    new_start_date: str | None = None,
    new_title: str | None = None,
    threshold: float = 0.88,
) -> tuple:
    """
    呼叫 Supabase match_events RPC，比對餘弦相似度。
    回傳 (is_duplicate: bool, matched_title: str)。

    語意相似時依序走「雙重豁免」，只有三條件全中才真正跳過：

      豁免 1 — 日期不同：系列活動共用海報導致向量相近，但不同場次日期不同。
                new_start_date ≠ matched start_time[:10] → 放行。

      豁免 2 — 標題不同（終極防線）：AI 萃取出同一日期但標題含場次後綴
                （例：「山海有聲 (2/14場)」vs「山海有聲 (3/7場)」）。
                new_title ≠ matched title（完全比對）→ 放行。

      三條件全中（語意高相似 + 同日 + 同標題）→ 真正重複，跳過。

    RPC 失敗時回傳 (False, '')，確保不誤殺正常寫入。
    """
    try:
        result = supabase.rpc("match_events", {
            "query_embedding": embedding,
            "match_threshold":  threshold,
            "match_count":      1,
        }).execute()
        if result.data:
            matched       = result.data[0]
            matched_title = matched.get("title", "")

            # ── 豁免 1：日期不同 → 不同場次，放行 ──────────────────────────────
            if new_start_date:
                matched_start = matched.get("start_time") or ""
                matched_date  = matched_start[:10] if matched_start else ""
                if matched_date and matched_date != new_start_date:
                    print(f"🗓️  語意相似但日期不同（{new_start_date} ≠ {matched_date}），"
                          f"同系列不同場次，放行：{matched_title}")
                    return False, matched_title

            # ── 豁免 2：標題不同 → AI 萃取盲點（同日不同場次後綴），放行 ────────
            if new_title and matched_title and new_title != matched_title:
                print(f"🏷️  語意相似但標題不同，同系列不同場次，放行")
                print(f"   ↳ 新進：{new_title}")
                print(f"   ↳ 既有：{matched_title}")
                return False, matched_title

            return True, matched_title
        return False, ""
    except Exception as e:
        print(f"⚠️  向量查重 RPC 呼叫失敗（不中斷主流程）：{e}")
        return False, ""

# ==========================================
# 🌟 多站台目標配置清單
# ==========================================
TARGET_SITES = [
    {
        "name": "台東藝文平台",
        "base_url": "https://culture.taitung.gov.tw/",
        "list_url": "https://culture.taitung.gov.tw/activity",
        "next_selector": 'button[aria-label="下一頁"], a[aria-label="下一頁"]',
        "max_pages": 20,
        "keywords": ['活動', '展演', 'activity'],
        "schema_v2": True,
        "deep_crawl": True,   # 深度爬取：逐頁取連結、逐頁處理內頁、再翻頁
    },
    # ⚠️ 美學館已有專屬爬蟲 ttcsec_scraper.py（處理 JS 輪播與主從時間分離）
    # 此條目保留供首頁快速掃描補漏；正式全量抓取請執行 python ttcsec_scraper.py
    {
        "name": "台東生活美學館",
        "base_url": "https://www.ttcsec.gov.tw/",
        "keywords": ['活動', '展覽', '最新消息', '報名', 'event']
    },
    {
        "name": "東管處 (東部海岸國家風景區)",
        "base_url": "https://www.eastcoast-nsa.gov.tw/",
        "keywords": ['活動', '展演', '節慶', 'news', 'event']
    },
    {
        "name": "史前文化博物館",
        "base_url": "https://www.nmp.gov.tw/",
        "keywords": ['特展', '活動', '教育推廣', 'exhibition']
    },
    {
        "name": "台東縣立圖書館",
        "base_url": "https://library.taitung.gov.tw/",
        "keywords": ['活動', '講座', '推廣', 'news']
    }
    # ⚠️ 台東美術館目前防火牆較嚴格，暫時註解掉不抓
    # {
    #     "name": "台東美術館",
    #     "base_url": "https://tm.ccl.ttct.edu.tw/",
    #     "keywords": ['展覽', '最新消息', 'event', 'news']
    # }
]

# ── Timestamp 清洗工具 ────────────────────────────────────────────────────────
# 允許尾部帶時區偏移（如 +08:00）；.match() 只驗開頭，偏移量會被完整保留
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")

def sanitize_timestamp(val) -> str | None:
    """
    AI 回傳的時間值可能是字串 "None"、""、"null" 或格式不合規的值。
    只接受符合 YYYY-MM-DDTHH:MM 開頭的 ISO 8601 字串；其餘一律轉為 None，
    讓 psycopg2 / Supabase 正確轉成 SQL NULL，避免 invalid timestamp 崩潰。
    """
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "未提供", ""):
        return None
    if not _ISO_RE.match(s):
        return None
    return s

def extract_end_date(end_time_iso: str | None) -> str | None:
    """從合法的 ISO end_time 取出 YYYY-MM-DD 作為 end_date 欄位。"""
    if not end_time_iso:
        return None
    return end_time_iso[:10]


def normalize_title(s: str) -> str:
    """
    標題純化：去除標點、括號、空白、全半形差異，只保留漢字與英數字。

    用於跨平台去重比對。不同來源可能在標題加入不同的標點、空格或括號，
    例如「筆墨馳想—2026」vs「筆墨馳想-2026」vs「筆墨馳想 2026」，
    純化後皆為「筆墨馳想2026」，能正確比對為同一活動。
    """
    s = unicodedata.normalize("NFKC", s)          # 全形→半形（Ａ→A、１→1）
    s = re.sub(r"[^\u4e00-\u9fff\w]", "", s)      # 只留漢字 + 英數底線
    s = s.replace("_", "").lower()                 # 移除底線、統一小寫
    return s


# ── URL 標準化與確定性 ID 產生 ────────────────────────────────────────────────

_TRACKING_PARAMS = frozenset({
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'yclid', 'mc_cid', 'mc_eid', '_ga', 'ref',
})

def normalize_url(url: str) -> str:
    """移除 tracking 參數並統一格式（小寫 scheme/host、去除尾斜線、無 fragment）。"""
    try:
        p = urlparse(url.strip())
        clean_qs = {k: v for k, v in parse_qs(p.query).items()
                    if k.lower() not in _TRACKING_PARAMS}
        return urlunparse((
            p.scheme.lower(),
            p.netloc.lower(),
            p.path.rstrip('/'),
            p.params,
            urlencode(clean_qs, doseq=True),
            '',
        ))
    except Exception:
        return url.strip()


def generate_event_id(source_name: str, normalized_url: str) -> str:
    """SHA256(source_name::normalized_url) → 64-char hex，作為跨批次去重主鍵。"""
    raw = f"{source_name}::{normalized_url}"
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def html_to_markdown_links(html: str) -> str:
    """
    將 HTML 轉為純文字，但將 <a href="...">文字</a> 保留為 [文字](URL) 格式，
    確保 Gemini 看到的文本包含真實的 ticket_url / source_url，而非只看到按鈕文字。
    """
    soup = BeautifulSoup(html, 'html.parser')
    for a in soup.find_all('a', href=True):
        href = a['href']
        if not href.startswith('http'):
            continue
        text = a.get_text(strip=True)
        a.replace_with(f' [{text}]({href}) ' if text else f' ({href}) ')
    return soup.get_text(separator='\n', strip=True)


# ── 共用：從當前頁面 HTML 蒐集活動連結 ──────────────────────────────────────
def _collect_links_from_soup(
    soup, base_url: str, keywords: list,
    already_seen: set, exclude_url_fragments: set
) -> list[tuple[str, str]]:
    """
    從 BeautifulSoup 解析的 HTML 中，篩選出符合 keywords 的活動連結。
    already_seen：已蒐集的 URL 集合（去重）
    exclude_url_fragments：正規化後需排除的 URL（列表頁本身、已造訪分頁）
    """
    BLACKLIST_PATHS = ['/history', '/archive', '/calendar', '/search']
    found = []
    for a in soup.find_all('a', href=True):
        href = a['href']
        text = a.get_text(strip=True)
        if not any(k in href.lower() or k in text.lower() for k in keywords):
            continue
        full = urljoin(base_url, href)
        if not full.startswith(base_url):
            continue
        norm_full = full.split('?')[0].rstrip('/')
        if norm_full in exclude_url_fragments:
            continue
        if any(bl in full for bl in BLACKLIST_PATHS):
            continue
        if full in already_seen:
            continue
        found.append((text, full))
        already_seen.add(full)
    return found


# ── 分頁列表蒐集器 ────────────────────────────────────────────────────────────
def paginate_and_collect(
    page, list_url: str, base_url: str,
    keywords: list, next_selector: str = None,
    max_pages: int = 50,
) -> list:
    """
    從 list_url 出發，穿越所有分頁，回傳 (link_text, full_url) 活動連結清單。

    ┌─ 模式 A：URL 翻頁（next_selector=None）─────────────────────────────────┐
    │  在 <a> 標籤中尋找 >, ›, >>, 下一頁 等文字，取其 href 導航至下一頁。     │
    │  若 href 為 javascript:… 嘗試點擊後等待 URL 改變。                       │
    │  visited_pages（正規化 URL）防止無限迴圈。                                │
    └─────────────────────────────────────────────────────────────────────────┘

    ┌─ 模式 B：Button-click 翻頁（next_selector 已設）────────────────────────┐
    │  適用於 SPA / 前端框架（Vue/React）的 <button> 分頁。                    │
    │  URL 翻頁後不變，改用內容變化偵測：                                       │
    │    1. 點擊前記錄當前頁所有活動連結 URL（prev_hrefs）                      │
    │    2. 點擊 next_selector 按鈕                                             │
    │    3. 等待 networkidle（AJAX 完成）+ 額外 1.5 秒渲染緩衝                  │
    │    4. 若點擊後第一個活動連結 URL 與 prev_hrefs 完全相同 → 末頁，停止      │
    │  停止條件：按鈕不存在、disabled、aria-disabled=true、內容未變、超過上限   │
    └─────────────────────────────────────────────────────────────────────────┘
    """
    collected: list[tuple[str, str]] = []
    already_seen: set[str] = set()

    # ════════════════════════════════════════════════════════════
    # 模式 B：Button-click（SPA，URL 不變）
    # ════════════════════════════════════════════════════════════
    if next_selector:
        MAX_PAGES = max(1, max_pages)  # 每日排程可傳 1，只抓首頁
        page_num = 0

        print(f"   🖱️  Button-click 分頁模式（selector: {next_selector}）")
        try:
            page.goto(list_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2500)
        except Exception as e:
            print(f"   ⚠️  列表頁載入失敗：{e}")
            return collected

        while page_num < MAX_PAGES:
            page_num += 1
            soup = BeautifulSoup(page.content(), 'html.parser')

            # 記錄點擊前的第一個活動 URL（用來偵測內容是否真的換頁了）
            prev_first_href = None
            for a in soup.find_all('a', href=True):
                href = a['href']
                if any(k in href.lower() for k in keywords):
                    prev_first_href = urljoin(base_url, href)
                    break

            # 蒐集本頁連結
            new_links = _collect_links_from_soup(soup, base_url, keywords, already_seen, set())
            collected.extend(new_links)
            print(f"   📄 列表第 {page_num} 頁 → +{len(new_links)} 筆，累計 {len(collected)} 筆")

            # ── 檢查下一頁按鈕狀態 ────────────────────────────────────────────
            try:
                btn = page.locator(next_selector).first
                if btn.count() == 0:
                    print("   🏁 找不到下一頁按鈕，列表掃描完成")
                    break
                if btn.is_disabled():
                    print("   🏁 下一頁按鈕已 disabled，列表掃描完成")
                    break
                aria = btn.get_attribute('aria-disabled') or ''
                if aria.lower() == 'true':
                    print("   🏁 下一頁 aria-disabled=true，列表掃描完成")
                    break

                # ── 點擊並等待非同步內容更新 ──────────────────────────────────
                btn.click()
                try:
                    # networkidle：等到 AJAX 請求都結束才繼續
                    page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass  # networkidle 逾時不致命，繼續往下等
                page.wait_for_timeout(1500)  # 額外緩衝：等 Vue/React 渲染完成

                # ── 內容變化驗證：若第一筆活動連結和點擊前相同 → 末頁 ─────────
                new_soup = BeautifulSoup(page.content(), 'html.parser')
                new_first_href = None
                for a in new_soup.find_all('a', href=True):
                    href = a['href']
                    if any(k in href.lower() for k in keywords):
                        new_first_href = urljoin(base_url, href)
                        break

                if prev_first_href and new_first_href and new_first_href == prev_first_href:
                    print("   🏁 內容未變化（已到末頁），列表掃描完成")
                    break

            except Exception as e:
                print(f"   ⚠️  翻頁按鈕操作失敗：{e}")
                break

        if page_num >= MAX_PAGES:
            print(f"   ⚠️  已達最大分頁上限（{MAX_PAGES} 頁），停止掃描")

        return collected

    # ════════════════════════════════════════════════════════════
    # 模式 A：URL 翻頁（<a href> 換頁，URL 會改變）
    # ════════════════════════════════════════════════════════════
    visited_pages: set[str] = set()
    current_url = list_url
    page_num = 0
    NEXT_TOKENS = {'>', '›', '»', '>>', '下一頁', 'next', 'Next'}

    while True:
        norm_url = current_url.split('?')[0].rstrip('/')
        if norm_url in visited_pages:
            print("   ⚠️  偵測到 URL 循環，停止翻頁")
            break
        visited_pages.add(norm_url)
        page_num += 1

        print(f"   📄 列表第 {page_num} 頁：{current_url}")
        try:
            page.goto(current_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)
        except Exception as e:
            print(f"   ⚠️  列表頁載入失敗：{e}")
            break

        soup = BeautifulSoup(page.content(), 'html.parser')
        new_links = _collect_links_from_soup(soup, base_url, keywords, already_seen, visited_pages)
        collected.extend(new_links)
        print(f"      → 本頁 +{len(new_links)} 筆，累計 {len(collected)} 筆")

        # ── 尋找下一頁 <a> ────────────────────────────────────────────────────
        next_url = None
        use_click = False

        for a in soup.find_all('a'):
            if a.get_text(strip=True) not in NEXT_TOKENS:
                continue
            href = a.get('href', '')
            if not href:
                use_click = True
                break
            if href.lower().startswith('javascript'):
                use_click = True
                break
            candidate = urljoin(base_url, href)
            if candidate.split('?')[0].rstrip('/') not in visited_pages:
                next_url = candidate
                break

        if use_click and not next_url:
            try:
                sel = ', '.join(
                    f'a:text-is("{t}"), button:text-is("{t}")' for t in NEXT_TOKENS
                )
                btn = page.locator(sel).first
                if btn.count() == 0 or btn.is_disabled():
                    print("   🏁 下一頁按鈕已 disabled，列表掃描完成")
                    break
                if (btn.get_attribute('aria-disabled') or '').lower() == 'true':
                    print("   🏁 下一頁 aria-disabled=true，列表掃描完成")
                    break
                btn.click()
                page.wait_for_load_state("domcontentloaded", timeout=15000)
                page.wait_for_timeout(2000)
                current_url = page.url
            except Exception as e:
                print(f"   ⚠️  JS 翻頁失敗：{e}")
                break
        elif next_url:
            current_url = next_url
            time.sleep(2)
        else:
            print("   🏁 找不到下一頁連結，列表掃描完成")
            break

    return collected


def flush_crawl_log(run_id: str, source_name: str, run_stats: dict, duration_ms: int):
    """每站台爬取完成後，將執行統計寫入 crawl_logs 表。"""
    try:
        supabase.table("crawl_logs").insert({
            "run_id":         run_id,
            "source_name":    source_name,
            "found_count":    run_stats.get('found', 0),
            "inserted_count": run_stats.get('inserted', 0),
            "updated_count":  run_stats.get('updated', 0),
            "skipped_count":  run_stats.get('skipped', 0),
            "error_count":    run_stats.get('error', 0),
            "duration_ms":    duration_ms,
        }).execute()
        print(
            f"📊 crawl_log：{source_name} ｜"
            f" ✅ {run_stats.get('inserted', 0)} 新"
            f" 🔄 {run_stats.get('updated', 0)} 更新"
            f" ⏩ {run_stats.get('skipped', 0)} 跳過"
            f" ❌ {run_stats.get('error', 0)} 失敗"
        )
    except Exception as e:
        print(f"⚠️  crawl_log 寫入失敗（不中斷主流程）：{e}")


def save_event_upsert(event_data, run_stats: dict, source_name: str = "", dry_run: bool = False):
    """
    統一入庫接口（Phase 2 重構）：Layer 3 語意去重後委派至 db_utils.upsert_event。
    Layer 1（event_id upsert 去重）由 db_utils 負責。
    """
    from db_utils import upsert_event, map_legacy_fields

    events_to_process = event_data if isinstance(event_data, list) else [event_data]
    VENUE_BLACKLIST = ['南科', '南科考古館']

    for single_event in events_to_process:
        title = single_event.get('event_name', '未提供')
        venue = single_event.get('location', '') or single_event.get('venue_name', '') or ''

        if any(kw in title or kw in venue for kw in VENUE_BLACKLIST):
            print(f"🚫 跳過（外縣市黑名單）：{title}｜地點：{venue}")
            run_stats['skipped'] += 1
            continue

        # ── Layer 3：語意向量去重 ────────────────────────────────────────────
        start_prefix = (single_event.get('iso_start_time') or '')[:10]
        embed_text = (
            f"{title} {start_prefix} "
            f"{single_event.get('card_summary', single_event.get('description', ''))}"
        ).strip()
        embedding = generate_embedding(embed_text)

        if embedding:
            is_semantic_dup, matched_title = check_semantic_duplicate(
                embedding, new_start_date=start_prefix, new_title=title,
            )
            if is_semantic_dup:
                print(f"🧠 語意重複，跳過：{title}\n   ↳ 相似：{matched_title}")
                run_stats['skipped'] += 1
                continue
        else:
            print(f"⚠️  Embedding 失敗，跳過語意去重（仍寫入）：{title}")

        # ── 對映舊欄位 → 新 Schema，委派 db_utils.upsert_event ─────────────
        mapped = map_legacy_fields(single_event)
        result = upsert_event(
            llm_data=mapped,
            system_fields={
                "source_url":  single_event.get('source_url', ''),
                "source_name": source_name,
                "image_url":   single_event.get('image_url', ''),
            },
            supabase=supabase,
            google_maps_key=google_maps_key,
            embedding=embedding,
            dry_run=dry_run,
        )

        if result == "inserted":
            run_stats['inserted'] += 1
        elif result == "updated":
            run_stats['updated'] += 1
        elif result == "skipped":
            run_stats['skipped'] += 1
        elif result == "error":
            run_stats['error'] += 1

def ai_data_cleaner(raw_text, image_url, source_url):
    image_data = None
    if image_url and image_url.startswith("http"):
        try:
            print("👁️ 正在將海報交給 AI 分析時間表...")
            img_res = requests.get(image_url, timeout=10, verify=False)
            if img_res.status_code == 200:
                image_data = types.Part.from_bytes(
                    data=img_res.content,
                    mime_type="image/jpeg"
                )
        except Exception as e:
            print(f"⚠️ 圖片下載失敗，僅使用文字分析: {e}")

    prompt = f"""
你是專業的台灣在地文化策展人。請閱讀下方文字與【海報圖片】，萃取出活動資訊。

═══════════════════════════════════════════
【垃圾守門員（最優先判斷）】

若此頁面內容屬於以下任一類型，請立即回傳：{{"status": "ignore"}}
不需回傳任何其他內容。

  ✗ 非台東縣的活動（活動地點明確標示為台北、新北、高雄、花蓮、國家檔案館等其他縣市）
  ✗ 場地租借公告 / 開放預約場地
  ✗ 徵件 / 公開招募 / 報名表單（無明確演出者）
  ✗ 人員招募 / 徵才 / 工作機會
  ✗ 行政公告 / 採購公告 / 法規說明
  ✗ 無明確日期或無明確演出內容的空白節目單

  ⚠️ 【日期豁免原則，不可違反】
  即使活動的開始日期已是過去，只要 end_date（結束日期）在今天之後，
  代表展覽或活動「仍在進行中」，必須正常萃取，絕對不可因「活動已開始」而判為過期忽略。
  例：某展覽 2026-03-01 開展、2026-07-31 閉幕 → 今天（2026-04-16）仍在進行 → 必須萃取。

═══════════════════════════════════════════
【地點誠實原則（Anti-Hallucination，最高優先）】

location 欄位的唯一合法來源：活動正文、海報圖片、活動專屬的地址欄位。
以下來源的場館名稱一律忽略，不得作為 location：
  ✗ 網站頂部導覽列或 sidebar 裡的場館連結清單
  ✗ 頁面底部「相關活動」、「推薦場館」區塊
  ✗ 你自己的訓練知識對「這類活動通常在哪辦」的推測
若活動正文沒有明確場館，location 填 null，latitude/longitude 也填 null。
「不確定」永遠優於「猜測」。

═══════════════════════════════════════════
【展覽與跨日活動規則（Critical）】

若活動是「展覽」、「特展」、「長期展示」或任何跨越多日的活動：
  • iso_start_time：填展覽第一天的開始時間，例如 "2026-03-30T09:00:00+08:00"
  • end_date：填展覽最後一天的 YYYY-MM-DD，例如 "2026-06-28"
  ⚠️ 嚴禁將展覽的 iso_end_time 留空或設為 null！

【展覽結束時間：營業時間優先規則】
iso_end_time 的時間基準請依以下優先順序決定：
  ① 活動專屬時間（最優先）：若該活動本身另外註明獨立結束時間
    （例：園區 17:00 關門，但「星空電影院」寫明 19:00-21:00）→ 以活動專屬時間為準
  ② 場館營業/開放時間：若內文提及場館打烊時間（如「開放時間 09:00-17:00」）
    → 以打烊時間作為每日 iso_end_time 基準，例如 "2026-06-28T17:00:00+08:00"
  ③ 備援（極端情況）：完全找不到場館營業時間且無活動具體時間
    → 才可使用 23:59:59+08:00 作為最後備援

═══════════════════════════════════════════
【多場次與系列活動拆解規則（Critical）】

⚠️ 核心禁令：若內文或海報列出「多個不連續的特定日期」（場次表、不同週末演出），
   絕對禁止將其合併為一個橫跨數月的單一長效活動（start→end 橫跨多月）。

觸發條件（符合任一即須拆解）：
  • 明確場次表：列出多個不連續日期（如：2/14、3/7、5/9）
  • 不同週末演出：每週六或隔週等週期性但各場獨立的演出
  • 系列活動：總期間長達數月，各場有不同演出者或主題

拆解規則：
  • 每個具體舉辦日期 → 獨立輸出一個 JSON 物件
  • event_name 後加場次識別，格式：「主名稱 (MM/DD場)」
    例：「大坡池懷舊情歌 (5/9場)」、「山海有聲 - 南王姊妹花 (3/7場)」
  • 每筆 iso_end_time 填該場次當日結束時間+08:00，end_date 留 null
  • 若場次時間未明確標注 → 套用「展覽結束時間：營業時間優先規則」推算

═══════════════════════════════════════════
【多場地處理規則（Anti-Concatenation）】

若文本為系列節目單或包含多個不同展演場地：
  • 請挑選「最具代表性的主場地」或「首場活動場地」填入 location。
  • 絕對不可將多個場地名稱串接成一個過長的字串（例：「A場 / B場 / C場」禁止出現）。
  • 若真的無法判斷單一場地，location 填「多個場地 (詳見內文)」，latitude/longitude 填 null。

═══════════════════════════════════════════
【台灣民國紀年轉換規則（Taiwan Minguo Calendar, Critical）】

內文若出現「114年」、「115年」、「116年」等字樣，這是台灣民國紀年，請自動加上 1911 轉換為西元年：
  • 114年 = 2025年　115年 = 2026年　116年 = 2027年（依此類推）
  ⚠️ 嚴禁因「無法辨識民國年份」而退而求其次改抓沒有年份的寬泛宣傳期。
     若文中有民國年份，務必轉換後精確填入，不可省略或用曖昧的月日範圍代替。

═══════════════════════════════════════════
【報名期 vs. 活動期嚴格區分規則（Registration vs. Event Period, Critical）】

許多活動海報同時包含「報名/索票期間」與「實際演出時間」，你必須極度警覺！
  • 常見陷阱：海報大字寫「4/23 ~ 5/20 報名中」→ 這是報名截止日，絕對不是活動 iso_start_time！
  • 判斷原則：
    ① 若內文深處有具體的單日時間（例：「115年5月20日 13:30-17:30」「5月20日（四）下午2點」）
       → 無條件捨棄任何長區間，以該單日具體時間為 iso_start_time，time_type 設為「單日活動」
    ② 若標題或內文明確出現「報名期間」「索票期間」「徵件截止」等字眼後接日期範圍
       → 該日期範圍是行政期限，非活動時間，禁止填入 iso_start_time
    ③ 若同時存在「報名期」與「活動日」，永遠以「活動日」為準

═══════════════════════════════════════════
【時間來源優先規則（Header-Field Priority, Critical）】

網頁通常同時包含「表頭屬性區塊（如：活動時間、地點等結構化欄位）」與「內文敘述區」。
  • 若表頭屬性區塊含有具體日期+時間 → 絕對優先採用，不得被內文覆蓋。
  • 若內文提及寬泛的「巡迴期間」（如「1/31-11/21 全台巡迴」）→ 請忽略，以表頭的該場次具體時間為主。
  • 「巡迴期間」是整個系列的宣傳範圍，不是單一場次的 start_time，禁止直接填入。

【休館日禁止填入時間欄位（Anti-Closure-Hallucination, Critical）】

  ⚠️ 嚴禁將「每週一休館」、「週一公休」、「每逢週一不開放」、「逢週二休館」等
     「定期休館說明」誤填為 iso_start_time 或 iso_end_time！
  • 此類字串是場館的例行公告，不代表活動的開始或結束時間。
  • 若發現文中有定期休館說明，請將其忽略，繼續從實際活動時間資訊萃取 iso_start_time。
  • 若確實找不到活動具體時間，iso_start_time 仍必須填入展覽開幕日+09:00:00+08:00，
    iso_end_time 填入閉幕日+17:00:00+08:00，休館資訊一律不得干擾時間欄位的值。

═══════════════════════════════════════════
【URL 格式強制規則（Anti-Fake-URL + Intent-Capture, Critical）】

ticket_url 依以下優先順序填入（三擇一）：
  ① 在文本中找到以 http:// 或 https:// 開頭的購票/報名連結 → 直接填入該網址
  ② 活動內文明確提及「索票」、「報名」、「登記」、「預約」、「領票」等需要預先確保名額的字眼，
     但找不到任何外部連結 → 必須將活動原始網頁網址「{source_url}」填入 ticket_url。
     此規則確保前端按鈕必定渲染，引導使用者回原頁面查看索票細節。絕對不可設為 null！
  ③ 下列任一情況 → 必須設為 null，不得填入來源網址：
     • 內文出現「自由入場」「免票參觀」「無票入場」「無需事先報名」「憑票免費入場」等字眼
     • 純展覽/純展示，內文無任何「需事前確認名額」的流程說明（如純走入即看類展覽）
     ⚠️ 「免費」本身不等於「需要索票」：即使是免費活動，若無需事前預約或領取票券，一律填 null。
        只有「免費索票」（需事前領取票券方可入場）才啟動規則②。
  ✗ 嚴禁將純中文文字（如「免費索票網站」、「官網索票」）填入 ticket_url。
  ✗ 嚴禁填入相對路徑或 # 開頭的片段連結。
  若在轉換後的文字中看到 [按鈕文字](https://...) 格式 → 括號內的 https 連結才是 ticket_url 的正確值。

═══════════════════════════════════════════
【回傳格式】

正常活動 → 回傳純 JSON Array（不含 ```json 標籤）：
[
  {{
    "event_name": "標題（系列活動請含子標題）",
    "iso_start_time": "YYYY-MM-DDTHH:MM:SS+08:00（必填，展覽填首日，禁止省略時區）",
    "iso_end_time":   "YYYY-MM-DDTHH:MM:SS+08:00（展覽填末日 23:59:59+08:00，單日演出可 null）",
    "end_date":       "YYYY-MM-DD（展覽必填末日；單日演出填 null）",
    "location":       "【嚴格規則】必須從內文或海報精確擷取展出場館名稱（例：都蘭文創園區展覽館、台東生活美學館）。來源只能是活動本身的正文、海報、地址欄位。若找不到明確場館名稱，填 null。絕對禁止從網站導覽列、側邊欄、相關活動清單等非活動本身的區塊取值。絕對禁止填寫任何預設場館（如臺東美術館、文化處等）或自行推測。",
    "latitude":       緯度數字或 null（只有在你確定 location 準確時才填，否則填 null）,
    "longitude":      經度數字或 null（只有在你確定 location 準確時才填，否則填 null）,
    "is_free":        true 或 false,
    "ticket_url":     "購票或報名連結（三擇一）：① 文本中有真實 http/https 連結 → 直接填入；② 活動提及「索票/報名/登記/預約/領票」但無外部連結 → 必須填入活動原始網址「{source_url}」，絕對不可設為 null；③ 純自由入場、無需報名 → null。嚴禁填入純中文文字或相對路徑。",
    "image_url":      "{image_url}",
    "vibe_tags":      ["從以下擇1-5個：音樂演出, 視覺藝術, 傳統工藝, 原住民文化, 在地節慶, 戶外體驗, 親子活動, 靜態展覽, 講座工作坊, 市集, 電影放映, 舞蹈, 戲劇表演, 祭典儀式, 生態旅遊, 書法文學, 藝術裝置, 官方展演, 社區活動。⚠️ 規則：真正的畫展/藝術展/博物館展覽才可標『靜態展覽』；多日節慶、嘉年華、市集、音樂節等動態活動嚴禁標『靜態展覽』"],
    "target_audience": ["親子", "情侶", "獨旅", "銀髮"],
    "indoor_or_outdoor": "indoor" | "outdoor" | "semi-outdoor",
    "weather_resilience": 1到5的整數,
    "card_summary":   "15-30字吸睛簡介",
    "long_description": "完整活動介紹內文，越詳細越好",
    "source_url":     "{source_url}"
  }}
]

垃圾內容 → 回傳：{{"status": "ignore"}}

═══════════════════════════════════════════
網頁文字：
{raw_text[:3000]}
"""
    
    max_retries = 3 
    for attempt in range(max_retries):
        try:
            api_contents = [prompt]
            if image_data:
                api_contents.append(image_data)
                
            response = client.models.generate_content(
                model='gemini-2.5-flash-lite',
                contents=api_contents
            )
            clean_text = response.text.replace("```json", "").replace("```", "").strip()
            return json.loads(clean_text)
            
        except Exception as e:
            err = str(e)
            if "429" in err or "RESOURCE_EXHAUSTED" in err:
                print(f"⏳ 撞到頻率限制！罰站 60 秒... (第 {attempt+1}/{max_retries} 次)")
                time.sleep(60)
            elif any(c in err for c in ("500", "503", "INTERNAL", "UNAVAILABLE")):
                wait = 5 * (2 ** attempt)  # 5 → 10 → 20 秒
                print(f"⏳ Gemini 暫時錯誤，{wait}s 後重試... (第 {attempt+1}/{max_retries} 次)")
                time.sleep(wait)
            else:
                print(f"🧠 AI 處理出錯: {e}")
                return None
    return None

# ── 新版 15 欄位 AI 清洗器（Phase 3 schema_v2）────────────────────────────────
def ai_data_cleaner_v2(
    raw_text: str,
    source_name: str,
    source_url: str,
    image_url: str = "",
) -> list[dict] | None:
    """
    Phase 3 新版 Gemini 清洗器。
    輸出直接對應 Supabase events 表新 Schema（15 欄位），
    由呼叫端透過 upsert_event 直接入庫，不需 map_legacy_fields 中間轉換。
    """
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    image_data = None
    if image_url and image_url.startswith("http"):
        try:
            img_res = requests.get(image_url, timeout=10, verify=False)
            if img_res.status_code == 200:
                mime = img_res.headers.get("Content-Type", "image/jpeg").split(";")[0]
                image_data = types.Part.from_bytes(data=img_res.content, mime_type=mime)
        except Exception as e:
            print(f"   ⚠️  圖片下載失敗，僅用文字分析：{e}")

    prompt = f"""
你是台灣在地文化策展人兼資料工程師。
以下內容來自「{source_name}」（台東官方藝文平台）。
今天日期：{today}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【過濾規則（優先判斷）】
下列情況請回傳 [{{"is_event": false}}]，不輸出活動：
- 場地租借公告 / 開放預約
- 人員招募 / 徵才 / 志工
- 行政採購公告 / 法規說明
- 活動地點明確在台東縣以外
- 無明確日期或無明確演出內容

【日期豁免原則】
即使活動開始日期已過，只要結束日期在今天 {today} 之後，代表仍在進行中，必須正常萃取。

【展覽與跨日活動】
若為展覽/特展/長期展示：
  • start_time：首日開始時間
  • end_time：末日閉館時間（依場館開放時間推算）
  • time_type 填「常態展覽」

【時間萃取最高指導原則（Anti-Promo-Period, Critical）】

⚠️ 「宣傳期間」與「真實場次時間」必須嚴格區分：

「宣傳期間」（禁止作為 start_time/end_time）辨識特徵：
  • 出現在標題旁、副標題、報名截止日、或首頁活動卡片的標籤中
  • 跨越多週或多月（例：4/23 ~ 5/20、即日起 ~ 6月底）
  • 通常格式為「X/X ~ X/X 開放報名」或「活動期間」標示

「真實場次時間」（唯一合法 start_time 來源）辨識特徵：
  • 出現在活動內文的「節目時刻表」、「場次表」、「活動流程」段落
  • 格式含具體時分：「X月X日（週X）HH:MM–HH:MM」或「X/X HH:MM」
  • 通常伴隨具體表演者、節目名稱、場地出現

處理規則：
  1. 找到真實場次時間 → 以場次時間填 start_time/end_time，宣傳期完全忽略
  2. 找到同日多個場次（如 10:00-12:00 和 14:00-16:00）→ 必須拆成兩個獨立 JSON 物件
     title 後加場次識別：「主標題 (10:00場)」、「主標題 (14:00場)」
  3. 只有宣傳期，找不到任何具體場次時間 → 宣傳期第一天為 start_time，
     time_type 填「期間限定」，時間部分填 T00:00:00+08:00

【海報圖片優先原則（Vision Priority, Critical）】

若附上了海報圖片，你必須優先從圖片中萃取資訊：
  • 節目時刻表、場次時間（最重要！）
  • 場地名稱、詳細地址
  • 演出者名單、節目說明
  • 免費/需購票資訊

若文字與圖片資訊衝突 → 以海報圖片為準（海報是主要宣傳媒介）。
若文字找不到具體時間，但海報圖片有 → 必須從圖片讀取，絕對不可留空。

【多場次拆分（核心規則）】
⚠️ 輸出格式固定為 JSON Array（即使只有一場，也必須回傳長度為 1 的陣列）。

若活動內文或海報列出「多個不連續的特定日期」（場次表、不同週末演出、系列活動），
請拆分為多個獨立 JSON 物件，每個物件對應一個場次：
  • start_time / end_time 分別填該場次的開始與結束時間
  • title 後加場次識別：「主標題 (MM/DD場)」，例：「大坡池懷舊情歌 (5/9場)」
  • 其餘欄位（venue_name、is_free、description 等）各場相同，只有時間不同
觸發條件（符合任一即需拆分）：
  • 明確場次表列出不同日期
  • 不同週末演出（每週六/隔週等）
  • 系列活動總期多月、各場獨立
  • 同一天有多個不連續時段（上午場/下午場）

【地點誠實原則】venue_name 只能來自活動正文本身，不得從導覽列或推測填入。

【多場地處理規則】若活動涵蓋多個不同場地：
  • 請填「最具代表性的主場地」或「首場活動場地」於 venue_name。
  • 絕對不可將多個場地串接成一個過長字串（例：「A館 / B館 / C館」禁止）。
  • 若真的無法判斷單一場地，venue_name 填「多個場地 (詳見內文)」，address 設為 null。

【時間來源優先規則（Header-Field Priority, Critical）】
網頁通常同時包含「表頭屬性區塊（活動時間、地點等結構化欄位）」與「內文敘述區」。
  • 表頭屬性區塊含具體日期+時間 → 絕對優先採用，不得被內文覆蓋。
  • 內文若出現寬泛的「巡迴期間」（如「1/31-11/21 全台巡迴」）→ 忽略之，以表頭的具體場次時間為主。
  • 「巡迴期間」是系列宣傳範圍，不是單場 start_time，禁止填入。

【徵件/比賽活動特殊分類規則（Critical）】

若活動內容屬於「徵件」「公開徵選」「作品投稿」「比賽報名」「評選」「選拔」等類型：
  • category 必須設為「其他」
  • time_type 必須強制設為「期間限定」（日期為徵件/報名的開始到截止期間）
  • start_time 填徵件開始日，end_time 填截止日
  • 絕對不可將徵件截止日判定為「單日演出」或單次 start_time
  此類活動沒有「演出場次」概念，請勿套用場次拆分邏輯。

【URL 格式強制規則（Anti-Fake-URL + Intent-Capture, Critical）】

ticket_url 依以下優先順序填入（三擇一）：
  ① 在文本中找到以 http:// 或 https:// 開頭的購票/報名連結 → 直接填入該網址
  ② 活動內文明確提及「索票」、「報名」、「登記」、「預約」、「領票」等需要預先確保名額的字眼，
     但找不到任何外部連結 → 必須將活動原始網頁網址「{source_url}」填入 ticket_url。
     此規則確保前端按鈕必定渲染，引導使用者回原頁面查看索票細節。絕對不可設為 null！
  ③ 下列任一情況 → 必須設為 null，不得填入來源網址：
     • 內文出現「自由入場」「免票參觀」「無票入場」「無需事先報名」「憑票免費入場」等字眼
     • 純展覽/純展示，內文無任何「需事前確認名額」的流程說明（如純走入即看類展覽）
     ⚠️ 「免費」本身不等於「需要索票」：即使是免費活動，若無需事前預約或領取票券，一律填 null。
        只有「免費索票」（需事前領取票券方可入場）才啟動規則②。
  ✗ 嚴禁將純中文文字（如「免費索票網站」、「官網索票」）填入 ticket_url。
  ✗ 嚴禁填入相對路徑或 # 開頭的片段連結。
  若在轉換後的文字中看到 [按鈕文字](https://...) 格式 → 括號內的 https 連結才是 ticket_url 的正確值。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
請嚴格回傳純 JSON Array（不含 ```json 標籤）：
[
  {{
    "is_event": true,
    "title": "活動標題",
    "category": "展覽 | 演出 | 講座 | 工作坊 | 節慶活動 | 其他",
    "sub_category": ["從以下選1-3個：音樂, 舞蹈, 戲劇, 視覺藝術, 傳統工藝, 原住民文化, 電影, 親子, 講座, 市集, 祭典, 書法文學, 生態旅遊, 社區活動"],
    "time_type": "單日活動 | 期間限定 | 常態展覽",
    "start_time": "YYYY-MM-DDTHH:mm:ss+08:00（無具體時間填 null）",
    "end_time": "YYYY-MM-DDTHH:mm:ss+08:00（單日可 null；長期展覽填末日閉館時間）",
    "opening_hours": "展覽開放時段說明（如無填 null）",
    "venue_name": "實際活動場地名稱（不確定填 null）",
    "address": "完整地址（如無填 null）",
    "region": "市區 | 縱谷山線 | 東海岸線 | 南迴線 | 離島（無法判斷填 null）",
    "is_free": true 或 false,
    "ticket_url": "購票或報名連結（三擇一）：① 文本中有真實 http/https 連結 → 直接填入；② 活動提及「索票/報名/登記/預約/領票」但無外部連結 → 必須填入活動原始網址「{source_url}」，絕對不可設為 null；③ 純自由入場、無需報名 → null。嚴禁填入純中文文字或相對路徑。",
    "indoor_or_outdoor": "室內 | 室外（無法判斷填 null）",
    "description": "50字以內短摘要，吸引人參與",
    "long_description": "完整活動說明"
  }}
]

垃圾內容 → [{{"is_event": false}}]

來源：{source_name}
網址：{source_url}
內文：
{raw_text[:3500]}
"""
    api_contents: list = [prompt]
    if image_data:
        api_contents.append(image_data)

    for attempt in range(3):
        try:
            resp = client.models.generate_content(
                model="gemini-2.5-flash-lite", contents=api_contents
            )
            clean = resp.text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean)
            return result if isinstance(result, list) else [result]
        except Exception as e:
            err = str(e)
            if "429" in err or "RESOURCE_EXHAUSTED" in err:
                print(f"   ⏳ Gemini rate limit，等待 60s... ({attempt+1}/3)")
                time.sleep(60)
            elif any(c in err for c in ("500", "503", "INTERNAL", "UNAVAILABLE")):
                wait = 5 * (2 ** attempt)  # 5 → 10 → 20 秒
                print(f"   ⏳ Gemini 暫時錯誤 ({err[:60]})，{wait}s 後重試... ({attempt+1}/3)")
                time.sleep(wait)
            else:
                print(f"   ⚠️  AI 解析失敗：{e}")
                return None
    return None


# ==========================================
# 🌟 核心主爬蟲函數 (已修正縮進與邏輯)
# ==========================================
def ai_powered_spider(site_config, dry_run: bool = False, limit: int = 0, max_pages_override: int = 0):
    site_name = site_config["name"]
    base_url = site_config["base_url"]
    list_url = site_config.get("list_url")   # 可選：已知的活動列表頁（有分頁）
    keywords = site_config["keywords"]

    run_id    = time.strftime('%Y%m%d_%H%M%S')
    run_stats = {'found': 0, 'inserted': 0, 'updated': 0, 'skipped': 0, 'error': 0}
    t_start   = time.time()

    print(f"\n🚢 駛入大廳：{site_name} ({base_url})")

    with Stealth().use_sync(sync_playwright()) as p:
        browser = p.chromium.launch(headless=False)

        context = browser.new_context(
            viewport={'width': 1280, 'height': 800},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        try:
            if site_config.get("deep_crawl") and site_config.get("list_url"):
                # ════════════════════════════════════════════════════════════
                # 深度爬取模式（page-by-page）
                # list_page 固定停在列表頁負責翻頁；detail_page 負責進入內頁抓資料。
                # 確保每頁的內頁連結全部處理完畢後才點擊「下一頁」。
                # ════════════════════════════════════════════════════════════
                list_url  = site_config["list_url"]
                next_sel  = site_config.get("next_selector")
                max_pages = max_pages_override or site_config.get("max_pages", 50)

                list_page   = context.new_page()
                detail_page = context.new_page()

                print(f"📋 深度爬取模式：{list_url}（最多 {max_pages} 頁）")

                list_loaded = False
                try:
                    list_page.goto(list_url, wait_until="domcontentloaded", timeout=30000)
                    list_page.wait_for_timeout(2500)
                    list_loaded = True
                except Exception as e:
                    print(f"   ⚠️  列表頁載入失敗：{e}")

                if list_loaded:
                    all_seen     = set()
                    page_num     = 0
                    total_detail = 0

                    while page_num < max_pages:
                        page_num += 1
                        print(f"\n{'═'*60}")
                        print(f"📖 正在處理第 {page_num} 頁（活動列表）")
                        print(f"{'═'*60}")

                        soup       = BeautifulSoup(list_page.content(), 'html.parser')
                        page_links = _collect_links_from_soup(soup, base_url, keywords, all_seen, set())

                        # 精準過濾：只保留路徑深度嚴格大於列表頁的連結（排除導覽列錨點）
                        list_path_prefix = urlparse(list_url).path.rstrip('/') + '/'
                        page_links = [(lt, u) for lt, u in page_links
                                      if urlparse(u).path.startswith(list_path_prefix)]

                        run_stats['found'] += len(page_links)
                        print(f"   🔗 本頁發現 {len(page_links)} 個活動內頁連結")

                        cap = (limit - total_detail) if limit > 0 else len(page_links)
                        for link_text, detail_url in page_links[:max(0, cap)]:
                            total_detail += 1
                            print(f"\n   🚪 正在進入內頁 [{total_detail}]：{detail_url}")
                            try:
                                detail_page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
                                detail_page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                                detail_page.wait_for_timeout(2500)

                                main_img_url = detail_page.evaluate("""() => {
                                    const BLACKLIST = ['banner', 'default', 'logo', 'bg', 'footer', 'header', 'icon', 'placeholder'];
                                    const isBlacklisted = (src) => {
                                        if (!src) return true;
                                        const lower = src.toLowerCase();
                                        return BLACKLIST.some(kw => lower.includes(kw));
                                    };
                                    const getSrc = (el) => el.getAttribute('data-src') || el.getAttribute('data-original') || el.src || '';
                                    const area = (img) => (img.naturalWidth || img.width) * (img.naturalHeight || img.height);
                                    const contentImgs = new Set();
                                    const contentSelectors = [
                                        'article img', '.content img', '.editor img',
                                        '.post-content img', '.activity img', '.main-content img',
                                        '.news-content img', '.detail img', 'main img'
                                    ];
                                    for (const sel of contentSelectors)
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
                                    return best ? getSrc(best) : '未提供';
                                }""")

                                if main_img_url and not main_img_url.startswith('http') and main_img_url != '未提供':
                                    main_img_url = urljoin(detail_url, main_img_url)
                                print(f"   🖼️  捕獲圖片：{main_img_url}")

                                raw_html    = detail_page.locator("body").inner_html()
                                raw_content = html_to_markdown_links(raw_html)

                                events_list = ai_data_cleaner_v2(
                                    raw_content, site_name, detail_url,
                                    main_img_url if main_img_url != "未提供" else "",
                                )
                                if events_list is None:
                                    print("   ⚠️  AI 回傳為空，略過此頁")
                                else:
                                    valid = [e for e in events_list if e.get("is_event")]
                                    print(f"   ✨ LLM 回傳了 {len(valid)} 個場次")
                                    if dry_run:
                                        print(f"\n{'─'*65}")
                                        print("  [v2 JSON Preview]：")
                                        print(json.dumps(events_list, ensure_ascii=False, indent=2))
                                        print('─'*65)
                                    for ev in events_list:
                                        if not ev.get("is_event"):
                                            run_stats['skipped'] += 1
                                            continue
                                        result = upsert_event(
                                            llm_data=ev,
                                            system_fields={
                                                "source_url":  detail_url,
                                                "source_name": site_name,
                                                "image_url":   main_img_url if main_img_url != "未提供" else "",
                                            },
                                            supabase=supabase,
                                            google_maps_key=google_maps_key,
                                            dry_run=dry_run,
                                        )
                                        if result == "inserted":   run_stats['inserted'] += 1
                                        elif result == "updated":  run_stats['updated']  += 1
                                        elif result == "skipped":  run_stats['skipped']  += 1
                                        elif result == "error":    run_stats['error']    += 1
                            except Exception as e:
                                print(f"   ⚠️  略過此內頁 (錯誤): {e}")
                                try:
                                    detail_page = context.new_page()
                                    print("   🔄 已重建 detail_page，繼續下一頁")
                                except Exception:
                                    pass
                            time.sleep(3)

                        if limit > 0 and total_detail >= limit:
                            print(f"\n⚠️  已達 --limit 上限 ({limit})，停止")
                            break

                        if not next_sel:
                            print("   🏁 未設 next_selector，掃描完成")
                            break

                        # ── 翻至下一頁列表 ────────────────────────────────────
                        try:
                            btn = list_page.locator(next_sel).first
                            if btn.count() == 0:
                                print("   [PAGINATION] 🏁 找不到下一頁按鈕，掃描完成")
                                break
                            if btn.is_disabled():
                                print("   [PAGINATION] 🏁 下一頁按鈕已 disabled，掃描完成")
                                break
                            aria_val = btn.get_attribute('aria-disabled') or ''
                            if aria_val.lower() == 'true':
                                print("   [PAGINATION] 🏁 下一頁 aria-disabled=true，掃描完成")
                                break

                            # 以已過濾的活動卡片 URL 作比對基準（避免抓到導覽列的 /activity 連結）
                            prev_first_href = page_links[0][1] if page_links else None
                            print(f"   [PAGINATION] 正在點擊第 {page_num + 1} 頁按鈕...")
                            if prev_first_href:
                                print(f"   [PAGINATION] 基準首活動：{prev_first_href}")

                            btn.click()

                            # Explicit Wait：等待 DOM 中第一個活動卡片 URL 改變
                            if prev_first_href:
                                prev_path = urlparse(prev_first_href).path
                                try:
                                    list_page.wait_for_function(
                                        f"""() => {{
                                            const links = [...document.querySelectorAll('a[href]')];
                                            const first = links.find(a => {{
                                                try {{ return new URL(a.href).pathname.startsWith('{list_path_prefix}'); }}
                                                catch {{ return false; }}
                                            }});
                                            return !first || new URL(first.href).pathname !== '{prev_path}';
                                        }}""",
                                        timeout=8000,
                                    )
                                    print("   [PAGINATION] ✅ DOM 偵測到活動卡片已更新")
                                except Exception:
                                    print("   [PAGINATION] ⏳ DOM wait 逾時，fallback 至 3s 靜態等待...")
                                    try:
                                        list_page.wait_for_load_state("networkidle", timeout=5000)
                                    except Exception:
                                        pass
                                    list_page.wait_for_timeout(3000)
                            else:
                                try:
                                    list_page.wait_for_load_state("networkidle", timeout=10000)
                                except Exception:
                                    pass
                                list_page.wait_for_timeout(3000)

                            # 取新頁面的已過濾活動連結（用空 set()，不受 all_seen 污染）
                            new_soup  = BeautifulSoup(list_page.content(), 'html.parser')
                            new_raw   = _collect_links_from_soup(new_soup, base_url, keywords, set(), set())
                            new_links = [(lt, u) for lt, u in new_raw
                                         if urlparse(u).path.startswith(list_path_prefix)]
                            new_first_href = new_links[0][1] if new_links else None

                            if prev_first_href and new_first_href and new_first_href == prev_first_href:
                                print(f"   [PAGINATION] ⚠️ 首活動 URL 仍相同，追加 2s 後重驗...")
                                list_page.wait_for_timeout(2000)
                                retry_soup  = BeautifulSoup(list_page.content(), 'html.parser')
                                retry_raw   = _collect_links_from_soup(retry_soup, base_url, keywords, set(), set())
                                retry_links = [(lt, u) for lt, u in retry_raw
                                               if urlparse(u).path.startswith(list_path_prefix)]
                                retry_first = retry_links[0][1] if retry_links else None
                                if retry_first and retry_first != prev_first_href:
                                    print(f"   [PAGINATION] ✅ 延遲後確認內容更新，開始處理第 {page_num + 1} 頁")
                                else:
                                    print("   [PAGINATION] 🏁 確認已到末頁，掃描完成")
                                    break
                            else:
                                print(f"   [PAGINATION] ✅ 偵測到內容已更新，開始處理第 {page_num + 1} 頁")

                        except Exception as e:
                            print(f"   [PAGINATION] ⚠️ 翻頁操作失敗：{e}")
                            break

                duration_ms = int((time.time() - t_start) * 1000)
                print(f"\n✅ 深度爬取完成，共處理 {total_detail} 個內頁，耗時 {duration_ms//1000}s")
                if not dry_run:
                    flush_crawl_log(run_id, site_name, run_stats, duration_ms)

            else:
                # ════════════════════════════════════════════════════════════
                # 原始淺層爬取模式（collect all → process all）
                # ════════════════════════════════════════════════════════════
                page = context.new_page()

                # ── Phase 1：蒐集所有活動連結 ────────────────────────────────────────
                if list_url:
                    # 已設 list_url → 用分頁爬取器穿越所有分頁
                    next_selector = site_config.get("next_selector")  # None = URL 翻頁模式
                    max_pages     = site_config.get("max_pages", 50)
                    print(f"📋 啟用分頁列表模式：{list_url}（最多 {max_pages} 頁）")
                    potential_links = paginate_and_collect(
                        page, list_url, base_url, keywords, next_selector,
                        max_pages=max_pages,
                    )
                else:
                    # 未設 list_url → 舊邏輯：從首頁掃一層連結
                    print("🏠 使用首頁掃描模式（未設 list_url）")
                    page.goto(base_url, wait_until="domcontentloaded", timeout=90000)
                    page.wait_for_timeout(3000)
                    soup = BeautifulSoup(page.content(), 'html.parser')
                    potential_links = []
                    for link in soup.find_all('a'):
                        href = link.get('href')
                        link_text = link.get_text(strip=True)
                        if href and any(k in href.lower() or k in link_text.lower() for k in keywords):
                            full_url = urljoin(base_url, href)
                            if base_url in full_url and full_url not in [l[1] for l in potential_links]:
                                if not full_url.endswith('/history') and full_url != base_url:
                                    potential_links.append((link_text, full_url))

                run_stats['found'] = len(potential_links)
                print(f"🔎 共蒐集 {len(potential_links)} 個活動連結。")

                # ── Phase 2：逐頁 AI 萃取 ────────────────────────────────────────────
                cap = limit if limit > 0 else len(potential_links)
                for text, url in potential_links[:cap]:
                    print(f"\n🚪 潛入活動頁：{url}")
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        page.wait_for_timeout(2500)

                        main_img_url = page.evaluate("""() => {
                            const BLACKLIST = ['banner', 'default', 'logo', 'bg', 'footer', 'header', 'icon', 'placeholder'];
                            const isBlacklisted = (src) => {
                                if (!src) return true;
                                const lower = src.toLowerCase();
                                return BLACKLIST.some(kw => lower.includes(kw));
                            };
                            const getSrc = (el) => el.getAttribute('data-src') || el.getAttribute('data-original') || el.src || '';
                            const area = (img) => (img.naturalWidth || img.width) * (img.naturalHeight || img.height);

                            // Collect content-area images first (Set deduplicates overlapping selectors)
                            const contentImgs = new Set();
                            const contentSelectors = [
                                'article img', '.content img', '.editor img',
                                '.post-content img', '.activity img', '.main-content img',
                                '.news-content img', '.detail img', 'main img'
                            ];
                            for (const sel of contentSelectors)
                                document.querySelectorAll(sel).forEach(img => contentImgs.add(img));

                            // Pick largest non-blacklisted content image
                            let best = null, maxArea = 0;
                            for (const img of contentImgs) {
                                const src = getSrc(img);
                                if (isBlacklisted(src)) continue;
                                const a = area(img);
                                if (a > maxArea) { maxArea = a; best = img; }
                            }
                            if (best) return getSrc(best);

                            // og:image as fallback (only if not blacklisted)
                            const ogImg = document.querySelector('meta[property="og:image"]');
                            if (ogImg && ogImg.content && !isBlacklisted(ogImg.content)) return ogImg.content;

                            // Last resort: largest non-blacklisted image anywhere (skip already-checked content imgs)
                            for (const img of document.querySelectorAll('img')) {
                                if (contentImgs.has(img)) continue;
                                const src = getSrc(img);
                                if (isBlacklisted(src)) continue;
                                const a = area(img);
                                if (a > maxArea) { maxArea = a; best = img; }
                            }
                            return best ? getSrc(best) : '未提供';
                        }""")

                        if main_img_url and not main_img_url.startswith('http') and main_img_url != '未提供':
                            main_img_url = urljoin(url, main_img_url)

                        print(f"🖼️  捕獲圖片：{main_img_url}")

                        raw_html    = page.locator("body").inner_html()
                        raw_content = html_to_markdown_links(raw_html)

                        if site_config.get("schema_v2"):
                            # ── Phase 3 路徑：新版 15 欄位 Schema，直接 upsert_event ──
                            events_list = ai_data_cleaner_v2(
                                raw_content, site_name, url,
                                main_img_url if main_img_url != "未提供" else "",
                            )
                            if events_list is None:
                                print("⚠️  AI 回傳為空，略過此頁")
                            else:
                                if dry_run:
                                    print(f"\n{'─'*65}")
                                    print("  [v2 JSON Preview] Gemini 完整輸出：")
                                    print(json.dumps(events_list, ensure_ascii=False, indent=2))
                                    print('─'*65)
                                valid = [e for e in events_list if e.get("is_event")]
                                print(f"✨ v2 schema → {len(valid)} 筆活動準備入庫...")
                                for ev in events_list:
                                    if not ev.get("is_event"):
                                        run_stats['skipped'] += 1
                                        continue
                                    result = upsert_event(
                                        llm_data=ev,
                                        system_fields={
                                            "source_url":  url,
                                            "source_name": site_name,
                                            "image_url":   (
                                                main_img_url
                                                if main_img_url and main_img_url != "未提供"
                                                else ""
                                            ),
                                        },
                                        supabase=supabase,
                                        google_maps_key=google_maps_key,
                                        dry_run=dry_run,
                                    )
                                    if result == "inserted":   run_stats['inserted'] += 1
                                    elif result == "updated":  run_stats['updated']  += 1
                                    elif result == "skipped":  run_stats['skipped']  += 1
                                    elif result == "error":    run_stats['error']    += 1
                        else:
                            # ── 舊版路徑（其他站台，保留舊 Schema + map_legacy_fields）─
                            event_json = ai_data_cleaner(raw_content, main_img_url, url)

                            if event_json is None:
                                print("⚠️  AI 回傳為空，略過此頁")
                            elif isinstance(event_json, dict) and event_json.get("status") == "ignore":
                                print("🚫 AI 守門員判定為無效內容（徵件/租場/公告），跳過")
                            else:
                                print("✨ 準備寫入資料庫...")
                                if isinstance(event_json, list):
                                    for ev in event_json:
                                        ev['source_name'] = site_name
                                elif isinstance(event_json, dict):
                                    event_json['source_name'] = site_name
                                save_event_upsert(event_json, run_stats=run_stats,
                                                  source_name=site_name, dry_run=dry_run)

                    except Exception as e:
                        print(f"⚠️ 略過此頁面 (超時或錯誤): {e}")
                        # 頁面或 context 崩潰後嘗試重建，確保後續 URL 不受影響
                        try:
                            page = context.new_page()
                            print("   🔄 已重建頁面，繼續下一站")
                        except Exception:
                            try:
                                page = browser.new_context().new_page()
                            except Exception as rebuild_err:
                                print(f"   🚨 瀏覽器已崩潰，中止此站台：{rebuild_err}")
                                break

                    time.sleep(15)

                # ── 爬蟲結束：寫入執行日誌 ────────────────────────────────────────
                duration_ms = int((time.time() - t_start) * 1000)
                if not dry_run:
                    flush_crawl_log(run_id, site_name, run_stats, duration_ms)

        except Exception as e:
            print(f"❌ 無法連接到站台 {site_name}: {e}")

        finally:
            try:
                browser.close()
            except Exception:
                pass  # 瀏覽器已崩潰，忽略關閉失敗

# ==========================================
# 🌟 大迴圈執行區塊
# ==========================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CulturRoute 多站台聯合海巡爬蟲")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="完整執行爬取與 AI 清洗，但不寫入任何資料庫（安全預覽模式）"
    )
    parser.add_argument(
        "--only", type=str, default=None,
        help="只抓名稱含指定關鍵字的站台，例如 --only 史前"
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="每個站台最多處理幾筆內頁連結（0 = 無限制，預設 0）"
    )
    parser.add_argument(
        "--max-pages", type=int, default=0, dest="max_pages",
        help="覆蓋站台設定的 max_pages（0 = 使用站台預設值），例如 --max-pages 2 限制只抓前 2 頁"
    )
    args = parser.parse_args()

    if args.dry_run:
        print("⚠️  [DRY-RUN 模式] 本次執行不會寫入任何資料庫！")

    print(f"🚀 [CulturRoute 多站台聯合海巡] 啟動時間: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    targets = TARGET_SITES
    if args.only:
        targets = [s for s in TARGET_SITES if args.only in s["name"]]
        print(f"🎯 篩選目標：{[s['name'] for s in targets]}")

    for site in targets:
        try:
            ai_powered_spider(site, dry_run=args.dry_run, limit=args.limit, max_pages_override=args.max_pages)
        except Exception as e:
            print(f"🚨 站台 {site['name']} 發生嚴重錯誤: {e}")

    print("\n💡 所有站台海巡任務完成。")