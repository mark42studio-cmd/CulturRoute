import os
import re
import time
import json
import argparse
import requests
import urllib3
import unicodedata
from dotenv import load_dotenv, find_dotenv
from playwright.sync_api import sync_playwright
from urllib.parse import urljoin
from bs4 import BeautifulSoup
from google import genai
from google.genai import types
from playwright_stealth import Stealth
from supabase import create_client, Client
from venue_whitelist import lookup_venue_coords

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
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"⏳ Embedding API 頻率限制，等待 60 秒... ({attempt + 1}/{max_retries})")
                time.sleep(60)
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
        # list_url：活動列表頁（含分頁導覽）。
        # ⚠️ 若實際 URL 有語系前綴（如 /zh-tw/Activity/C0），請在此更新。
        "list_url": "https://culture.taitung.gov.tw/activity",
        # next_selector：分頁按鈕為 <button> SPA 元素，點擊後非同步更新 DOM。
        # 由 DevTools 確認：button[aria-label="下一頁"]
        "next_selector": 'button[aria-label="下一頁"]',
        # 每日排程只抓第一頁（最新活動）；歷史回溯請用 scraper_backfill.py
        "max_pages": 1,
        "keywords": ['活動', '展演', 'activity']
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


def save_to_supabase(event_data, dry_run: bool = False):
    """
    支援單筆或系列活動 (List) 的自動拆解寫入。

    去重邏輯（兩層）：
      Layer 1 — 複合鍵（source_url + title）：
        同網址的多場次系列活動 title 各不同（含 (M/N場) 後綴），
        因此必須兩欄都相符才算重複，確保每場都能寫入。
      Layer 2 — 跨平台模糊比對（start_time + title[:6].ilike）：
        捕捉不同網站刊登的同場活動（標題略有差異）。

    其他：
      - timestamp 清洗：start_time/end_time "None" 字串 → SQL NULL
      - end_date 寫入：展覽的結束日期單獨存到 end_date 欄位
      - dry_run 硬鎖：dry_run=True 時絕對不呼叫 Supabase insert
    """
    events_to_process = event_data if isinstance(event_data, list) else [event_data]

    for single_event in events_to_process:
        title = single_event.get('event_name', '未提供')
        try:
            # ── 清洗時間欄位 ──────────────────────────────────────────────────
            start_time = sanitize_timestamp(single_event.get('iso_start_time'))
            end_time   = sanitize_timestamp(single_event.get('iso_end_time'))
            end_date   = single_event.get('end_date') or extract_end_date(end_time)

            # start_time 為 NULL → 資料無效，直接跳過
            if not start_time:
                print(f"⚠️  跳過（無有效 start_time）：{title}")
                continue

            # ── 去重（兩層）────────────────────────────────────────────────────
            source_url = single_event.get('source_url', '')

            # Layer 1：複合鍵（source_url + title）
            # 同一頁面拆解出的多場次活動，source_url 相同但 title 不同（帶 (M/N場) 後綴）
            # → 必須兩者都相符才算重複，確保系列場次全部寫入
            if source_url:
                dup = (supabase.table("events").select("id")
                       .eq("source_url", source_url).eq("title", title).execute())
                if dup.data:
                    print(f"⏩ 已存在（source_url+title 重複），跳過：{title}")
                    continue
            else:
                # 無 source_url 時降級：用 title + start_time 查重
                dup = (supabase.table("events").select("id")
                       .eq("title", title).eq("start_time", start_time).execute())
                if dup.data:
                    print(f"⏩ 已存在（title+time 重複），跳過：{title}")
                    continue

            # Layer 2：跨平台正規化比對（純化標題 + 相同日期）
            # 純化後比較，解決不同站台在標題加入不同標點/括號/空格而誤放行的問題。
            # 策略：抓同一天的所有活動，在 Python 端做正規化字串比對。
            date_prefix = start_time[:10]                    # YYYY-MM-DD
            norm_new    = normalize_title(title)
            same_day = (supabase.table("events")
                        .select("id, title")
                        .gte("start_time", f"{date_prefix}T00:00:00")
                        .lte("start_time", f"{date_prefix}T23:59:59")
                        .execute())
            fuzzy_matched = False
            for ev in same_day.data:
                norm_ev = normalize_title(ev["title"])
                # 判定為同一活動：一方為另一方子字串，或共享 ≥ 8 字純化字元前綴
                if norm_new and norm_ev and (
                    norm_new in norm_ev
                    or norm_ev in norm_new
                    or (len(norm_new) >= 8 and len(norm_ev) >= 8
                        and norm_new[:8] == norm_ev[:8])
                ):
                    fuzzy_matched = True
                    break
            if fuzzy_matched:
                print(f"⏩ 已存在（跨平台正規化比對），跳過：{title}")
                continue

            # ── Layer 3：語意向量去重（跨平台、跨日期）──────────────────────
            # 將「標題 + 日期 + 簡介」組合成語意文字，透過 Gemini Embedding 比對
            # 能捕捉官網與 FB 以不同文字描述同一活動的情況
            embed_text = (
                f"{title} "
                f"{start_time[:10]} "
                f"{single_event.get('card_summary', single_event.get('description', ''))}"
            ).strip()
            embedding = generate_embedding(embed_text)

            if embedding:
                is_semantic_dup, matched_title = check_semantic_duplicate(
                    embedding, new_start_date=start_time[:10], new_title=title
                )
                if is_semantic_dup:
                    print(f"🧠 偵測到語意重複活動，跳過寫入：{title}")
                    print(f"   ↳ 相似既有活動：{matched_title}")
                    continue
            else:
                # Embedding 失敗 → 略過語意比對，繼續寫入（不犧牲資料完整性）
                print(f"⚠️  Embedding 失敗，跳過語意去重（仍寫入）：{title}")

            # ── 座標補全（白名單 / Google Places）──────────────────────────────
            lat = single_event.get('latitude')
            lon = single_event.get('longitude')
            if not lat or not lon:
                lat, lon = get_coordinates(single_event.get('location', ''))
            if lat == "FILTERED":
                print(f"⚠️  地點不在台東（geocoding 過濾），跳過：{title}")
                continue

            # ── 組 payload ────────────────────────────────────────────────────
            payload = {
                "title":            title,
                "description":      single_event.get('card_summary', ''),
                "long_description": single_event.get('long_description', ''),
                "image_captured":   single_event.get('image_url', ''),
                "start_time":       start_time,
                "end_time":         end_time,
                "end_date":         end_date,        # ← 展覽區間核心欄位
                "venue_name":       single_event.get('location', '未提供'),
                "latitude":         lat,
                "longitude":        lon,
                "is_free":          single_event.get('is_free', False),
                "ticket_url":       single_event.get('ticket_url'),
                "source_url":       source_url,
                "vibe_tags":        single_event.get('vibe_tags', []),
                "target_audience":  single_event.get('target_audience', []),
                "indoor_or_outdoor": single_event.get('indoor_or_outdoor'),
                "weather_resilience": single_event.get('weather_resilience', 3),
                "engagement_metrics": {"score": 0},
                "affiliate_links": {
                    "rental":        {"label": "租車/租機車", "url": None},
                    "ticket":        {"label": "售票連結",   "url": None},
                    "accommodation": {"label": "周邊住宿",   "url": None},
                },
                "embedding": embedding,  # None 時 Supabase 寫入 NULL，不影響其他欄位
            }

            if dry_run:
                print(f"[DRY-RUN] 預覽 payload（不寫入）：")
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                supabase.table("events").insert(payload).execute()
                date_label = start_time[:10]
                end_label  = f" ~ {end_date}" if end_date and end_date != start_time[:10] else ""
                print(f"✅ 存入：{title} ({date_label}{end_label})")

        except Exception as e:
            print(f"❌ 存入失敗 [{title}]: {e}")

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
    "ticket_url":     "購票連結或 null",
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
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"⏳ 撞到頻率限制！罰站 60 秒... (第 {attempt+1}/{max_retries} 次)")
                time.sleep(60)
            else:
                print(f"🧠 AI 處理出錯: {e}")
                return None
    return None

# ==========================================
# 🌟 核心主爬蟲函數 (已修正縮進與邏輯)
# ==========================================
def ai_powered_spider(site_config, dry_run: bool = False, limit: int = 0):
    site_name = site_config["name"]
    base_url = site_config["base_url"]
    list_url = site_config.get("list_url")   # 可選：已知的活動列表頁（有分頁）
    keywords = site_config["keywords"]

    print(f"\n🚢 駛入大廳：{site_name} ({base_url})")

    with Stealth().use_sync(sync_playwright()) as p:
        browser = p.chromium.launch(headless=False)

        context = browser.new_context(
            viewport={'width': 1280, 'height': 800},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        page = context.new_page()

        try:
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

                    raw_content = page.locator("body").inner_text()
                    event_json = ai_data_cleaner(raw_content, main_img_url, url)
                    
                    if event_json is None:
                        print("⚠️  AI 回傳為空，略過此頁")
                    elif isinstance(event_json, dict) and event_json.get("status") == "ignore":
                        print("🚫 AI 守門員判定為無效內容（徵件/租場/公告），跳過")
                    else:
                        print("✨ 準備寫入資料庫...")
                        save_to_supabase(event_json, dry_run=dry_run)
                    
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
        help="每個站台最多處理幾筆連結（0 = 無限制，預設 0）"
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
            ai_powered_spider(site, dry_run=args.dry_run, limit=args.limit)
        except Exception as e:
            print(f"🚨 站台 {site['name']} 發生嚴重錯誤: {e}")

    print("\n💡 所有站台海巡任務完成。")