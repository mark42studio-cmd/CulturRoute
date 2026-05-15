"""
township_scraper.py  v2
───────────────────────────────────────────────────────────────────────
四大強化機制：
  1. 策略模式 (Strategy Pattern)
     依 config["parser_type"] 自動派發解析函數；新增型別只需登記進
     PARSER_REGISTRY，主流程完全不動。

  2. HTTPX + Playwright 雙引擎 + 強制 SSL 防禦
     靜態頁 → httpx (verify=False)
     動態/JS 渲染頁 → Playwright (ignore_https_errors=True)

  3. DOM 輕量化預處理 (Pre-cleaning)
     移除 script/style/nav/footer/aside 等雜訊標籤；
     補全 <img src> / <a href> 的相對路徑為絕對路徑。

  4. 海報與附件即本體防禦
     每頁自動萃取 attachments 陣列（img + .pdf/.jpg/.png 連結），
     供後續 LLM 視覺 OCR 判讀。

執行方式：
  python township_scraper.py                          # 爬全部官方目標
  python township_scraper.py --limit 5                # 每個目標最多處理 5 筆
  python township_scraper.py --only 池上              # 名稱含關鍵字的目標
  python township_scraper.py --target 台東市公所活動訊息          # 精確指定單一目標
  python township_scraper.py --target 台東市公所活動訊息 --dry-run # 完整驗收，不寫 DB

--dry-run 行為：
  完整執行爬取、DOM 預處理、附件萃取、Gemini AI 清洗，
  並在終端機印出「攔截觀測」debug log 與 AI 回傳 JSON，
  但絕對不寫入任何 Supabase 資料表。
"""

import os
import re
import sys
import time
import json
import random
import argparse
import warnings
import urllib3
from urllib.parse import urljoin, urlparse
from dotenv import load_dotenv, find_dotenv
from bs4 import BeautifulSoup
from datetime import datetime, timezone

import httpx
from google import genai
from google.genai import types as genai_types
from supabase import create_client, Client

from venue_whitelist import lookup_venue_coords
from scraper import generate_embedding, check_semantic_duplicate
from db_utils import upsert_event

# ── 初始化 ─────────────────────────────────────────────────────────────────────

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings("ignore", message="Unverified HTTPS request")
load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
gemini_key   = os.getenv("GEMINI_API_KEY", "").strip()

if not supabase_url or not supabase_key:
    print("ERROR: SUPABASE_URL not found. Check .env")
    sys.exit(1)

gemini_client: genai.Client = genai.Client(api_key=gemini_key)
supabase: Client = create_client(supabase_url, supabase_key)

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config", "scraping_targets.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# parser_type 屬於「需要 Playwright」的集合
DYNAMIC_PARSER_TYPES: frozenset[str] = frozenset({"dynamic_scroll", "dynamic_ajax"})

# DOM 預處理：要移除的雜訊標籤
# 注意：故意不含 "form"——Joomla 公所網站的文章列表 table.category
# 包在 <form id="adminForm"> 內，移除 form 會連帶砍掉所有文章連結。
NOISE_TAGS: list[str] = [
    "script", "style", "nav", "footer", "aside",
    "header", "noscript", "iframe", "svg",
]

# 附件副檔名正則（海報即本體防禦）
ATTACHMENT_EXT_RE = re.compile(
    r'\.(pdf|jpg|jpeg|png|gif|webp|doc|docx|xls|xlsx|ppt|pptx)(\?.*)?$', re.I
)

# ── 圖片 URL 格式驗證 ──────────────────────────────────────────────────────────

# 被視為有效圖片的副檔名集合
_IMAGE_EXTS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
)
# 這些路徑片段出現在 URL 中，即使沒有副檔名也判定為有效圖片
# （event.culture.tw 的 CDN 路徑格式 + Facebook / Instagram CDN）
_IMAGE_CDN_HINTS: tuple[str, ...] = (
    "userfiles/", "/upload/", "/uploads/", "/images/",
    "fbcdn.net",          # Facebook 圖片 CDN（scontent.*.fbcdn.net / external.*.fbcdn.net）
    "fbsbx.com",          # Facebook 附件備援 CDN（lookaside.fbsbx.com）
    "cdninstagram.com",   # Instagram 圖片 CDN
)
# 這些特徵出現時直接判定為「非圖片」頁面 URL
_NON_IMAGE_SIGNATURES: tuple[str, ...] = (
    ".ctr", ".php", ".asp", ".aspx", ".html", ".htm",
    "detail.init", "index.init", "/news/", "?id=", "&id=",
    # Facebook 頁面連結特徵（/photo/ 相簿、story、貼文頁等）
    "facebook.com/photo", "facebook.com/photos",
    "facebook.com/permalink", "facebook.com/reel",
    "story_fbid", "/posts/",
)


def is_valid_image_url(url: str | None) -> bool:
    """
    判斷 URL 是否為可直接 <img src> 渲染的圖片檔案網址。

    通過條件（OR）：
      1. URL 路徑的副檔名屬於 _IMAGE_EXTS
      2. URL 包含已知圖片 CDN 路徑片段（_IMAGE_CDN_HINTS）

    拒絕條件（優先）：
      - 不是 http/https 開頭
      - URL 含 _NON_IMAGE_SIGNATURES（頁面 URL 特徵）
    """
    if not url:
        return False
    if not url.startswith(("http://", "https://")):
        return False

    # 去除 query string 後取路徑部份
    path = url.split("?")[0].lower()

    # 非圖片特徵：優先拒絕
    if any(sig in path for sig in _NON_IMAGE_SIGNATURES):
        return False

    # 副檔名比對
    _, ext = os.path.splitext(path)
    if ext in _IMAGE_EXTS:
        return True

    # CDN 路徑比對（event.culture.tw 的 userFiles/ 等）
    if any(hint in path for hint in _IMAGE_CDN_HINTS):
        return True

    return False


# 預設 parser_type（找不到時的 fallback）
DEFAULT_PARSER_TYPE = "static_table"


# ── 設定載入 ───────────────────────────────────────────────────────────────────

def load_targets() -> list[dict]:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)
    # 過濾掉僅含 _note 的佔位物件
    return [t for t in config.get("official_sites", []) if "url" in t]


# ── 工具函數 ───────────────────────────────────────────────────────────────────

def is_pdf_or_download(url: str) -> bool:
    return bool(re.search(r'\.(pdf|doc|docx|xls|xlsx)(\?.*)?$', url, re.I))


def contains_keyword(text: str, keywords: list[str]) -> bool:
    return any(kw in text for kw in keywords)


# ── 引擎 1：HTTPX 靜態引擎（SSL 強制防禦）────────────────────────────────────

def fetch_html_httpx(url: str, timeout: int = 20) -> str | None:
    """
    使用 httpx 抓取靜態 HTML。
    verify=False：政府網站常有 TLS 過舊或憑證過期，強制跳過驗證。
    """
    try:
        with httpx.Client(
            headers=HEADERS,
            timeout=timeout,
            verify=False,           # SSL 強制防禦
            follow_redirects=True,
        ) as client:
            resp = client.get(url)
            resp.raise_for_status()
            # httpx 會從 Content-Type 自動推斷編碼；
            # 政府網站有時仍為 Big5，手動 fallback
            encoding = resp.encoding or "utf-8"
            return resp.content.decode(encoding, errors="replace")
    except Exception as e:
        print(f"  [WARN] httpx fetch failed [{url[:60]}]: {e}")
        return None


# ── 引擎 2：Playwright 動態引擎 ───────────────────────────────────────────────

def fetch_html_playwright(url: str, timeout_ms: int = 30_000) -> str | None:
    """
    對需要 JS 渲染或無限滾動的頁面使用 Playwright。
    ignore_https_errors=True：等同 httpx 的 verify=False。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("  [WARN] playwright not installed.")
        print("         pip install playwright && playwright install chromium")
        return None

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            ctx = browser.new_context(
                ignore_https_errors=True,           # SSL 強制防禦
                user_agent=HEADERS["User-Agent"],
                extra_http_headers={"Accept-Language": "zh-TW,zh;q=0.9"},
            )
            page = ctx.new_page()
            page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            # 觸發懶加載：捲到底部再等一下
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1500)
            html = page.content()
            try:
                browser.close()
            except Exception:
                pass  # 瀏覽器已崩潰，忽略關閉失敗
            return html
    except Exception as e:
        print(f"  [WARN] Playwright fetch failed [{url[:60]}]: {e}")
        return None


def fetch_html(url: str, parser_type: str = DEFAULT_PARSER_TYPE,
               timeout: int = 20) -> str | None:
    """
    雙引擎調度器：依 parser_type 決定使用 httpx 或 Playwright。
    """
    if parser_type in DYNAMIC_PARSER_TYPES:
        print(f"  [ENGINE] Playwright  (parser_type={parser_type})")
        return fetch_html_playwright(url, timeout_ms=timeout * 1000)
    else:
        print(f"  [ENGINE] httpx       (parser_type={parser_type})")
        return fetch_html_httpx(url, timeout=timeout)


# ── DOM 輕量化預處理 ───────────────────────────────────────────────────────────

def preclean_soup(soup: BeautifulSoup, base_url: str) -> BeautifulSoup:
    """
    三步驟預處理，降低後續 AI 的 Token 消耗並提高精準度：
      Step 1  移除雜訊標籤（script / style / nav / footer / aside …）
      Step 2  <img src> 相對路徑 → 絕對路徑
      Step 3  <a href> 相對路徑 → 絕對路徑
    """
    # Step 1
    for tag in soup.find_all(NOISE_TAGS):
        tag.decompose()

    # Step 2
    for img in soup.find_all("img", src=True):
        src = img["src"]
        if src and not src.startswith(("http://", "https://", "data:")):
            img["src"] = urljoin(base_url, src)

    # Step 3
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href and not href.startswith(("http://", "https://", "#", "mailto:", "tel:")):
            a["href"] = urljoin(base_url, href)

    return soup


# ── 附件萃取（海報與附件即本體）──────────────────────────────────────────────

def extract_attachments(soup: BeautifulSoup, base_url: str) -> list[str]:
    """
    「海報與附件即本體」強制擷取邏輯：
      - 所有 <img> src（preclean 後已是絕對路徑）
      - 所有 <a href> 含附件副檔名（.pdf / .jpg / .png 等）的連結

    回傳去重後的 attachments list，供後續 LLM 視覺 OCR 判讀。
    """
    seen: set[str] = set()
    attachments: list[str] = []

    def _add(url: str) -> None:
        url = url.strip()
        if url and url not in seen:
            seen.add(url)
            attachments.append(url)

    # 所有圖片（preclean 後已補全絕對路徑）
    for img in soup.find_all("img", src=True):
        src = img["src"]
        if src and not src.startswith("data:"):
            _add(src)

    # 含附件副檔名的 <a> 連結
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href and ATTACHMENT_EXT_RE.search(href):
            _add(href)

    return attachments


# ── 連結文字多層 Fallback ──────────────────────────────────────────────────────

def _extract_link_text(a_tag) -> str:
    """
    取連結文字，按優先順序嘗試：
    1. <a> 自身的可見文字
    2. <img alt> / <img title>（Banner / Carousel 圖片連結）
    3. 同一 <tr> / <li> / <div> 中第一個有意義的文字（表格式列表）
    4. 空字串（讓呼叫端填 URL basename）
    """
    # 1. 直接文字
    text = a_tag.get_text(separator=" ", strip=True)
    if text:
        return text

    # 2. img alt / title（圖片包在連結內）
    img = a_tag.find("img")
    if img:
        for attr in ("alt", "title"):
            val = (img.get(attr) or "").strip()
            if val and val.lower() not in ("", "image", "photo", "pic", "img", "banner"):
                return val

    # 3. 同一行 / 同一列表項內的文字（表格列表連結文字為「詳情」或空）
    for parent_tag in ("tr", "li", "dd", "div"):
        parent = a_tag.find_parent(parent_tag)
        if parent:
            sibling_text = parent.get_text(separator=" ", strip=True)
            if sibling_text and len(sibling_text) > 2:
                return sibling_text[:100]

    return ""


# ── 策略模式：解析函數 Registry ───────────────────────────────────────────────

def _parse_static_table(soup: BeautifulSoup, config: dict) -> list[tuple[str, str]]:
    """
    選擇器驅動的連結發現（Selector-Driven Link Discovery）。

    config 欄位：
      list_selector          CSS selector，指定列表容器（可多個 selector 用 , 分隔）
                             命中時：只在容器內尋找連結，跳過全域關鍵字過濾
                             未命中時：自動 fallback 到全頁掃描並記錄警告
      link_selector          容器內的連結 CSS selector（預設 "a"）
      url_must_contain       list[str]，URL 必須包含其中至少一個（OR 邏輯）
                             這是最可靠的文章 URL 辨識方式
      url_filter_exclude     list[str]，URL 含這些字串則排除
      url_filter_require_pattern  舊版 regex，向後相容
      keywords               最後防線：無 list_selector & 無 url_must_contain 時才用
    """
    from urllib.parse import unquote

    base_url    = config["base_url"]
    list_url    = config["url"]
    keywords    = config.get("keywords", [])
    url_excl    = config.get("url_filter_exclude", [])
    url_must    = config.get("url_must_contain", [])
    require_pat = config.get("url_filter_require_pattern")
    require_re  = re.compile(require_pat, re.I) if require_pat else None

    list_selector = config.get("list_selector", "")
    link_selector = config.get("link_selector", "a")

    list_url_decoded = unquote(list_url)
    base_netloc      = urlparse(base_url).netloc

    # ── Step 1：定位容器（list_selector 精準模式）─────────────────────────────
    using_scope = False
    if list_selector:
        containers = soup.select(list_selector)
        if containers:
            print(f"  [SCOPE] list_selector='{list_selector}' → {len(containers)} 容器")
            scope_soups = containers
            using_scope = True
        else:
            print(f"  [WARN] list_selector='{list_selector}' 未命中任何元素 → fallback 全頁")
            scope_soups = [soup]
    else:
        scope_soups = [soup]

    # ── Step 2：在容器內蒐集候選連結 ──────────────────────────────────────────
    seen:    set[str]              = set()
    results: list[tuple[str, str]] = []

    for scope in scope_soups:
        try:
            candidates = scope.select(link_selector)
        except Exception:
            candidates = scope.find_all("a", href=True)

        for a in candidates:
            href = a.get("href") or ""
            if not href or href.startswith(("mailto:", "tel:", "javascript:")):
                continue
            # 已是絕對路徑（preclean_soup 確保），但雙重保護
            full_url = href if href.startswith("http") else urljoin(base_url, href)

            parsed = urlparse(full_url)

            # 只取站內連結
            if parsed.netloc != base_netloc:
                continue
            # 排除純錨點結尾
            if full_url.rstrip("/").endswith("#"):
                continue
            # 排除列表頁自身
            if unquote(full_url).rstrip("/") == list_url_decoded.rstrip("/"):
                continue
            # 去重
            norm = unquote(full_url)
            if norm in seen:
                continue

            # ── Step 3：URL 層過濾 ──────────────────────────────────────────
            # 黑名單（明確排除的路徑）
            if any(excl in full_url for excl in url_excl):
                continue
            # url_must_contain：OR 邏輯，URL 路徑必須含其中一個
            if url_must and not any(m in full_url for m in url_must):
                continue
            # 舊版 regex（向後相容）
            if require_re and not require_re.search(full_url):
                continue

            # ── Step 4：文字關鍵字過濾（最後防線，只在無 Selector 且無 URL 過濾時啟用）
            if not using_scope and not url_must and not require_re:
                text_raw = _extract_link_text(a)
                url_path = unquote(parsed.path).lower()
                url_kw   = ["news", "event", "activ", "活動", "公告",
                            "notice", "artc", "culture", "info"]
                if not contains_keyword(text_raw, keywords) and \
                   not any(k in url_path for k in url_kw):
                    continue

            # ── Step 5：取連結文字（多層 fallback）────────────────────────
            text = _extract_link_text(a)
            if not text:
                # 最終 fallback：用 URL 最後一段作為辨識文字
                text = unquote(parsed.path.rstrip("/").split("/")[-1])

            seen.add(norm)
            results.append((text[:120], full_url))

    return results


def _parse_dynamic_scroll(soup: BeautifulSoup, config: dict) -> list[tuple[str, str]]:
    """
    動態滾動 / AJAX 渲染頁策略。
    Playwright 已完成渲染，BeautifulSoup 拿到的是完整 DOM。
    共用同一套選擇器驅動邏輯。
    """
    return _parse_static_table(soup, config)


# ─────────────────────────────────────────────────────────────────────────────
# PARSER_REGISTRY：新增 parser_type 只需在此登記，主流程完全不動。
# ─────────────────────────────────────────────────────────────────────────────
PARSER_REGISTRY: dict[str, callable] = {
    "static_table":   _parse_static_table,
    "dynamic_scroll": _parse_dynamic_scroll,
    "dynamic_ajax":   _parse_dynamic_scroll,
}


def dispatch_parser(soup: BeautifulSoup, config: dict) -> list[tuple[str, str]]:
    """
    策略模式調度器：從 config["parser_type"] 找對應解析函數。
    未知 parser_type 時 fallback 至 static_table 並警告。
    """
    parser_type = config.get("parser_type", DEFAULT_PARSER_TYPE)
    parse_fn = PARSER_REGISTRY.get(parser_type)
    if parse_fn is None:
        print(f"  [WARN] unknown parser_type '{parser_type}', fallback to static_table")
        parse_fn = PARSER_REGISTRY[DEFAULT_PARSER_TYPE]
    return parse_fn(soup, config)


# ── 圖片萃取 ──────────────────────────────────────────────────────────────────

def extract_main_image(soup: BeautifulSoup, page_url: str, base_url: str) -> str | None:
    """
    優先層級：
      1. og:image（需通過 is_valid_image_url 驗證，避免抓到頁面 URL）
      2. userFiles/ 路徑圖片（event.culture.tw CDN，直接高分優先）
      3. 最大面積圖片（排除 icon/logo/UI 控制項等）
      4. CSS 背景圖 fallback

    src 解析：只從 <img> 標籤的 src 系列屬性取值，絕不讀取 <a href>。
    lazy-load 相容：依序嘗試 data-original, data-src, data-lazy-src, original, src。
    尺寸門檻：寬或高 < 100px 且兩者都有數值時，視為 icon 跳過。
    """
    import re as _re

    # og:image：加格式驗證，避免 event.culture.tw 回傳 .ctr 頁面 URL
    og = soup.find("meta", property="og:image")
    if og:
        og_url = og.get("content", "").strip()
        if is_valid_image_url(og_url):
            return og_url
        elif og_url:
            print(f"  [IMG] og:image 非圖片格式，已略過：{og_url[:70]}")

    # URL 黑名單：src 含以下字串的圖片一律排除
    SRC_BLACKLIST = [
        "icon", "logo", "banner_top", "header", "spacer", "blank",
        "accessibility", "aa.png", "facebook", "line", "print",
        "prev", "next", "arrow", "btn", "slid", "chevron", "gui", "theme",
    ]
    # alt 屬性黑名單
    ALT_BLACKLIST = [
        "無障礙", "accessibility", "facebook", "line", "logo", "icon", "列印",
        "上一張", "下一張", "prev", "next", "arrow",
    ]

    # lazy-load 屬性優先順序（前者優先）
    SRC_ATTRS = ["data-original", "data-src", "data-lazy-src", "original", "src"]

    def resolve_src(img_tag) -> str | None:
        """依 lazy-load 屬性優先順序取得圖片 URL，並修正為絕對路徑。"""
        for attr in SRC_ATTRS:
            val = img_tag.get(attr, "").strip()
            if val and not val.startswith("data:"):
                return urljoin(page_url, val)
        return None

    # 優先容器：在這些父元素內的圖加 500 分
    PRIORITY_CONTAINERS = ["figure", ".pic", ".img-container", "#content"]
    priority_imgs: set = set()
    for selector in PRIORITY_CONTAINERS:
        for container in soup.select(selector):
            for img in container.find_all("img"):
                priority_imgs.add(id(img))

    best_url, best_score = None, 0

    for img in soup.find_all("img"):
        src = resolve_src(img)
        if not src:
            continue

        # 格式強校驗：src 不是有效圖片 URL 則跳過（防止 <img src="...Detail.init.ctr..."> 被誤選）
        if not is_valid_image_url(src):
            continue

        lower_src = src.lower()
        lower_alt = img.get("alt", "").lower()

        if any(k in lower_src for k in SRC_BLACKLIST):
            continue
        if any(k in lower_alt for k in ALT_BLACKLIST):
            continue

        # 尺寸門檻：兩者都有數值且任一 < 100 → 跳過（圖示/箭頭）
        try:
            w = int(img.get("width", 0))
            h = int(img.get("height", 0))
        except (ValueError, TypeError):
            w = h = 0
        if w > 0 and h > 0 and (w < 100 or h < 100):
            continue
        area = w * h

        alt_bonus = 300 if any(
            k in (lower_alt + lower_src)
            for k in ["poster", "海報", "活動", "flyer", "kv", "banner", "event"]
        ) else 0

        container_bonus = 500 if id(img) in priority_imgs else 0

        # userFiles/ 路徑額外加 800 分（event.culture.tw CDN 路徑，幾乎一定是海報）
        cdn_bonus = 800 if any(hint in lower_src for hint in _IMAGE_CDN_HINTS) else 0

        score = area + alt_bonus + container_bonus + cdn_bonus
        if score > best_score:
            best_score = score
            best_url = src

    if best_url:
        return best_url

    # ── CSS 背景圖 fallback ──────────────────────────────────────────────────────
    # 掃描含 background-image: url(...) 的 div/section
    bg_pattern = _re.compile(r'background(?:-image)?\s*:\s*url\(["\']?([^"\')\s]+)["\']?\)', _re.I)
    for tag in soup.find_all(["div", "section"], style=True):
        m = bg_pattern.search(tag.get("style", ""))
        if m:
            bg_url = urljoin(page_url, m.group(1))
            lower_bg = bg_url.lower()
            if not any(k in lower_bg for k in SRC_BLACKLIST):
                return bg_url

    return None


def download_image_part(image_url: str) -> genai_types.Part | None:
    """下載圖片並轉成 Gemini Part；使用 httpx + SSL 防禦。"""
    try:
        with httpx.Client(verify=False, timeout=12) as client:
            resp = client.get(image_url)
            if resp.status_code == 200:
                content_type = resp.headers.get("content-type", "image/jpeg")
                mime = content_type.split(";")[0].strip() or "image/jpeg"
                print(f"  [IMG] {len(resp.content)//1024}KB — {image_url[:60]}")
                return genai_types.Part.from_bytes(data=resp.content, mime_type=mime)
    except Exception as e:
        print(f"  [IMG] download failed: {e}")
    return None


# ── DB：暫存無法即時解析的頁面 ────────────────────────────────────────────────

def save_to_raw_posts(source_name: str, source_type: str, url: str,
                      raw_text: str = "", keyword: str = "公所通知") -> bool:
    """把無法直接解析的頁面存入 raw_threads_posts 待 AI 處理。"""
    try:
        existing = (
            supabase.table("raw_threads_posts")
            .select("id")
            .eq("permalink", url)
            .execute()
        )
        if existing.data:
            return False

        supabase.table("raw_threads_posts").insert({
            "keyword":     keyword[:100],
            "permalink":   url,
            "source_url":  url,
            "raw_text":    raw_text[:5000],
            "raw_status":  "pending",
            "source_type": source_type,
        }).execute()
        print(f"  [RAW] queued for AI: {url[:70]}")
        return True
    except Exception as e:
        print(f"  [ERR] save_to_raw_posts failed: {e}")
        return False


# ── AI 清洗（Phase 3：新版 Gemini Schema）────────────────────────────────────

def ai_cleaner_v2(
    raw_text: str,
    source_name: str,
    source_type: str,
    source_url: str,
    venue_hint: str,
    image_url: str | None = None,
    attachments: list[str] | None = None,
) -> list[dict] | None:
    """
    Phase 3 新版 Gemini 清洗器。
    輸出欄位直接對應 Supabase events 表（新版 Gemini Schema），
    由 upsert_event 直接入庫，不再需要中間欄位對映。
    """
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    attachments_note = ""
    if attachments:
        lines = "\n".join(f"  - {a}" for a in attachments[:10])
        attachments_note = f"\n【附件清單（可能含活動日期、地點）】：\n{lines}\n"

    image_part = download_image_part(image_url) if image_url else None

    prompt = f"""
你是台灣在地文化策展人兼資料工程師。
以下內容來自「{source_name}」（台東{venue_hint}地區），類型：{'鄉鎮公所' if source_type == 'township' else '官方機構'}。
今天日期：{today}
{attachments_note}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【過濾規則（優先判斷）】
下列情況請回傳 [{{"is_event": false}}]，不輸出活動：
- 行政通知（停水/停電/施工/招標/人事/政令宣導）
- 志工/攤商/工作招募
- 補助申請/線上徵件（非到場參與類）
- 活動地點明確在台東縣以外
- 無法確認是台東縣舉辦的活動
- 非藝文/文化類公告（社福/教育/民政等）

【台東縣限定】全國巡迴活動只保留台東場次。

【多場次】若有多個不連續日期，每個日期輸出一個獨立物件，標題加上 (MM/DD場)。

【民國年 → 西元年】115年=2026、114年=2025、113年=2024（+1911）

【發布單位 ≠ 活動地點】公所通知常轉知他處活動，嚴禁將「{source_name}」直接填入地點。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
請嚴格回傳純 JSON Array（不含 markdown 標籤）：
[
  {{
    "is_event": true,
    "title": "活動標題（刪除主辦單位名稱、括號附註、行政前綴如【公告】）",
    "category": "展覽 | 演出 | 講座 | 工作坊 | 節慶活動 | 其他",
    "sub_category": ["音樂", "舞蹈", "戲劇", "視覺藝術", "傳統工藝", "原住民文化", "電影", "親子", "講座", "市集", "祭典", "書法文學", "生態旅遊", "社區活動（選1-3個）"],
    "time_type": "單日活動 | 期間限定 | 常態展覽",
    "start_time": "YYYY-MM-DDTHH:mm:ss+08:00（無具體時間填 null）",
    "end_time": "YYYY-MM-DDTHH:mm:ss+08:00（單日可 null；長期展覽填末日閉館時間）",
    "opening_hours": "展覽開放時段說明（如無填 null）",
    "venue_name": "實際活動場地名稱（非發布公所；不確定填 null）",
    "address": "完整地址（如無填 null）",
    "region": "市區 | 縱谷山線 | 東海岸線 | 南迴線 | 離島（無法判斷填 null）",
    "is_free": true 或 false,
    "ticket_url": "購票或報名網址（有則提取，否則 null）",
    "indoor_or_outdoor": "室內 | 室外（無法判斷填 null）",
    "description": "50字以內短摘要，吸引人參與",
    "long_description": "完整活動說明"
  }}
]

來源：{source_name}（{venue_hint}）
網址：{source_url}
內文：
{raw_text[:3500]}
"""
    api_contents: list = [prompt]
    if image_part:
        api_contents.append(image_part)

    for attempt in range(3):
        try:
            resp = gemini_client.models.generate_content(
                model="gemini-2.5-flash-lite", contents=api_contents
            )
            clean = resp.text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean, strict=False)
            return result if isinstance(result, list) else [result]
        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"  [WAIT] Gemini rate limit, sleeping 60s ({attempt+1}/3)")
                time.sleep(60)
            else:
                print(f"  [ERR] AI parse failed: {e}")
                return None
    return None


# ── 攔截觀測 Log（dry-run 專用）──────────────────────────────────────────────

# 終端機輸出用的分隔線寬度
_W = 72

def _log_inspect_pre_ai(
    inner_soup: BeautifulSoup,
    attachments: list[str],
    image_url: str | None,
    raw_text: str,
    item_url: str,
) -> None:
    """
    呼叫 Gemini 之前，在終端機印出攔截觀測資訊：
      Block 1  preclean 後的 HTML 片段（驗證雜訊標籤消失、路徑已補全）
      Block 2  海報主視覺 URL
      Block 3  attachments 完整清單
      Block 4  送入 AI 的 raw_text 前 500 字
    """
    sep  = "─" * _W
    sep2 = "═" * _W

    print(f"\n{sep2}")
    print(f"  [INSPECT] PRE-AI  →  {item_url[:70]}")
    print(sep2)

    # Block 1：清洗後 HTML 片段（前 800 字元）
    html_preview = str(inner_soup)[:800].replace("\n", " ")
    print(f"\n  ┌─ [DOM] preclean HTML snippet (first 800 chars) ─────────────")
    # 每 100 字換行，方便肉眼掃描是否殘留 <nav>/<script>
    for i in range(0, len(html_preview), 100):
        print(f"  │  {html_preview[i:i+100]}")
    print(f"  └{'─' * (_W - 4)}")

    # Block 2：海報主視覺
    print(f"\n  ┌─ [POSTER] og:image / best-score image ──────────────────────")
    print(f"  │  {image_url or '(none)'}")
    print(f"  └{'─' * (_W - 4)}")

    # Block 3：attachments 完整清單
    print(f"\n  ┌─ [ATTACHMENTS]  {len(attachments)} item(s) ────────────────────────────")
    if attachments:
        for i, att in enumerate(attachments, 1):
            print(f"  │  [{i:02d}] {att}")
    else:
        print(f"  │  (empty)")
    print(f"  └{'─' * (_W - 4)}")

    # Block 4：raw_text 前 500 字（確認送進 AI 的文字品質）
    text_preview = raw_text[:500].replace("\n", "↵ ")
    print(f"\n  ┌─ [RAW TEXT] first 500 chars sent to Gemini ─────────────────")
    for i in range(0, len(text_preview), 100):
        print(f"  │  {text_preview[i:i+100]}")
    print(f"  └{'─' * (_W - 4)}\n")


def _log_ai_result(events_list: list[dict] | None, item_url: str) -> None:
    """
    Gemini 回傳後，完整 pretty-print JSON，方便核對時間、地點、圖片網址。
    """
    sep2 = "═" * _W
    print(f"\n{sep2}")
    print(f"  [INSPECT] AI RESULT  →  {item_url[:65]}")
    print(sep2)

    if events_list is None:
        print("  ✗  Gemini returned None (API error or all retries exhausted)")
    elif not events_list:
        print("  ✗  Gemini returned empty list []")
    else:
        for idx, ev in enumerate(events_list, 1):
            is_ev = ev.get("is_event", False)
            marker = "✓" if is_ev else "✗ (not_event)"
            print(f"\n  ── Event [{idx}/{len(events_list)}]  {marker} {'─'*30}")
            print(json.dumps(ev, ensure_ascii=False, indent=4))

    print(f"{sep2}\n")


# ── 淺層爬取：單一目標 ─────────────────────────────────────────────────────────

def scrape_target(config: dict, max_items: int, dry_run: bool) -> dict:
    """
    淺層策略：只抓列表頁第一屏的最新 N 筆連結，不做歷史翻頁。
    四大強化機制在此整合：引擎調度 → 預處理 → 策略派發 → 附件萃取。
    """
    name         = config["name"]
    source_type  = config["source_type"]
    url          = config["url"]
    base_url     = config["base_url"]
    venue_hint   = config.get("venue_hint", "台東")
    fixed_coords = config.get("fixed_coords")
    # CLI --limit 作為硬性上限（min），config max_items 是設計上限
    # 這樣 --limit 2 在測試時能強制壓縮，不被 config 的 10 蓋過
    limit        = min(config.get("max_items", max_items), max_items)
    parser_type  = config.get("parser_type", DEFAULT_PARSER_TYPE)

    stats = {"found": 0, "events": 0, "raw_saved": 0, "skipped": 0}
    mode_tag = "DRY-RUN" if dry_run else "LIVE"
    print(f"\n[TARGET] {name}  [parser={parser_type}]  [{mode_tag}]")
    print(f"         {url}")

    # ── Step A：抓取列表頁（雙引擎調度）──────────────────────────────────
    html = fetch_html(url, parser_type=parser_type)
    if not html:
        print(f"  [ERR] cannot fetch listing page, skipping.")
        return stats

    soup = BeautifulSoup(html, "html.parser")
    soup = preclean_soup(soup, base_url)      # DOM 輕量化預處理

    # ── Step B：策略模式派發 → 取候選連結 ────────────────────────────────
    candidate_links = dispatch_parser(soup, config)
    candidate_links = candidate_links[:limit]
    stats["found"] = len(candidate_links)
    print(f"  [SCAN] {len(candidate_links)} candidate links (cap={limit})")

    # 不論是否 dry-run，都印出完整連結清單供肉眼確認
    for idx, (text, link) in enumerate(candidate_links, 1):
        tag = "[DRY]" if dry_run else "     "
        print(f"  {tag} [{idx:02d}] {text[:40]:40s}  {link}")

    # ── Step C：逐一處理候選內頁 ─────────────────────────────────────────
    for title_text, item_url in candidate_links:
        print(f"\n  [FETCH] {item_url[:80]}")

        # PDF / 附件：dry-run 時只印，不排隊
        if is_pdf_or_download(item_url):
            if dry_run:
                print(f"  [DRY] would queue PDF to raw_posts: {item_url[:70]}")
            else:
                save_to_raw_posts(name, source_type, item_url,
                                  raw_text=f"[PDF/附件] {title_text}",
                                  keyword=title_text[:50])
                stats["raw_saved"] += 1
            time.sleep(1)
            continue

        # 內頁通常為靜態渲染，直接用 httpx；減少不必要的 Playwright 呼叫
        item_html = fetch_html_httpx(item_url)
        if not item_html:
            stats["skipped"] += 1
            continue

        inner_soup = BeautifulSoup(item_html, "html.parser")
        inner_soup = preclean_soup(inner_soup, base_url)   # DOM 輕量化預處理

        # ── 機制 4：海報與附件即本體 ──────────────────────────────────────
        attachments = extract_attachments(inner_soup, base_url)
        if attachments:
            preview = ", ".join(a.split("/")[-1][:28] for a in attachments[:3])
            suffix  = "..." if len(attachments) > 3 else ""
            print(f"  [ATTACH] {len(attachments)} items: {preview}{suffix}")

        # ── 機制 3 延伸：萃取海報主視覺（og:image 優先）─────────────────
        image_url = extract_main_image(inner_soup, item_url, base_url)
        if image_url:
            print(f"  [POSTER] {image_url[:70]}")

        # 嘗試取主要內文（語意標籤優先）
        body_el = (
            inner_soup.select_one(
                "article, main, .article-content, .content, "
                ".news-content, .main-content, #content, .post-body"
            )
            or inner_soup.find("body")
        )
        raw_text = body_el.get_text(separator="\n", strip=True) if body_el else ""

        # ── 容錯深度判讀（Rule 4）─────────────────────────────────────────
        # 有視覺素材（圖片或附件）時，門檻從 80 字降至 30 字
        has_visual   = bool(image_url or attachments)
        min_text_len = 30 if has_visual else 80

        if len(raw_text.strip()) < min_text_len:
            if has_visual:
                print(f"  [SPARSE] text={len(raw_text)}chars → relying on poster/attachments")
                raw_text = f"[文字極少，請主要依賴海報圖片或附件清單判讀]\n{raw_text}"
            else:
                if dry_run:
                    print(f"  [DRY] text too short ({len(raw_text)}chars), no visual — "
                          "would queue to raw_posts")
                else:
                    save_to_raw_posts(name, source_type, item_url,
                                      raw_text=raw_text, keyword=title_text[:50])
                    stats["raw_saved"] += 1
                time.sleep(1)
                continue

        # ── 攔截觀測 Block 1+2+3：AI 呼叫前印出 debug log ────────────────
        if dry_run:
            _log_inspect_pre_ai(inner_soup, attachments, image_url, raw_text, item_url)

        # ── 送 AI 清洗（文字 + 圖片多模態 + attachments 清單）───────────
        events_list = ai_cleaner_v2(
            raw_text, name, source_type, item_url, venue_hint,
            image_url=image_url,
            attachments=attachments if attachments else None,
        )

        # ── 攔截觀測 Block 4：印出 AI 回傳的完整 JSON ────────────────────
        if dry_run:
            _log_ai_result(events_list, item_url)
            # dry-run：絕對不寫 DB，計入模擬統計後繼續下一筆
            if events_list:
                real_events = [e for e in events_list if e.get("is_event")]
                stats["events"] += len(real_events)
                if not real_events:
                    stats["skipped"] += 1
            else:
                stats["skipped"] += 1
        else:
            # ── 正式模式：寫入 DB ─────────────────────────────────────────
            if events_list is None:
                save_to_raw_posts(name, source_type, item_url,
                                  raw_text=raw_text, keyword=title_text[:50])
                stats["raw_saved"] += 1
            else:
                for ev in events_list:
                    if not ev.get("is_event"):
                        stats["skipped"] += 1
                        continue
                    result = upsert_event(
                        llm_data=ev,
                        system_fields={
                            "source_url":  item_url,
                            "source_name": name,
                            "image_url":   image_url or "",
                        },
                        supabase=supabase,
                        google_maps_key=os.getenv("GOOGLE_MAPS_API_KEY", ""),
                        dry_run=False,
                    )
                    if result in ("inserted", "updated"):
                        stats["events"] += 1
                    elif result == "skipped":
                        stats["skipped"] += 1

        time.sleep(random.uniform(6, 12))

    return stats


# ── 主程式 ─────────────────────────────────────────────────────────────────────

def probe_target(config: dict) -> None:
    """
    --probe 模式：只爬列表頁並印出所有候選連結，不進入內頁、不呼叫 AI、不寫 DB。
    用於快速驗證 list_selector / url_must_contain 設定是否正確。
    """
    name        = config["name"]
    url         = config["url"]
    base_url    = config["base_url"]
    parser_type = config.get("parser_type", DEFAULT_PARSER_TYPE)

    print(f"\n{'═'*70}")
    print(f"  [PROBE] {name}")
    print(f"          {url}")
    print(f"          parser_type={parser_type}")
    print(f"          list_selector={config.get('list_selector','(未設定)')}")
    print(f"          link_selector={config.get('link_selector','a（預設）')}")
    print(f"          url_must_contain={config.get('url_must_contain','(未設定)')}")
    print(f"{'═'*70}")

    html = fetch_html(url, parser_type=parser_type)
    if not html:
        print("  [FAIL] 無法抓取列表頁")
        return

    soup = BeautifulSoup(html, "html.parser")
    soup = preclean_soup(soup, base_url)

    links = _parse_static_table(soup, config)

    if not links:
        print("  [PROBE] 未找到任何候選連結！")
        print("\n  ── 全頁 <a> 清單（前 30 筆）供人工確認選擇器 ────────────────")
        from urllib.parse import unquote
        base_netloc = urlparse(base_url).netloc
        count = 0
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if urlparse(href).netloc != base_netloc:
                continue
            txt = a.get_text(strip=True)[:40]
            print(f"    [{count+1:02d}] {txt:40s}  {unquote(href)[:80]}")
            count += 1
            if count >= 30:
                break
    else:
        print(f"\n  [PROBE] 找到 {len(links)} 筆候選連結：")
        for i, (text, href) in enumerate(links, 1):
            print(f"    [{i:02d}] {text[:45]:45s}  {href[:70]}")

    print(f"\n{'═'*70}\n")


def main():
    parser = argparse.ArgumentParser(
        description="CulturRoute 精準淺層爬取器 v3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
範例：
  python township_scraper.py                                          # 爬全部目標（正式）
  python township_scraper.py --target 台東市公所活動訊息 --dry-run --limit 2
  python township_scraper.py --only 公所 --dry-run                   # 名稱含「公所」的全部目標
  python township_scraper.py --probe                                  # 所有目標列表頁診斷
  python township_scraper.py --target 東河公所活動訊息 --probe        # 單一目標列表頁診斷
""",
    )
    parser.add_argument("--limit",   type=int, default=10,
                        help="每個目標最多處理幾筆（預設 10）")
    parser.add_argument("--dry-run", action="store_true",
                        help=(
                            "完整執行 pipeline（爬取、預處理、AI 清洗），"
                            "印出攔截觀測 log，但絕對不寫入 Supabase"
                        ))
    parser.add_argument("--probe",   action="store_true",
                        help=(
                            "診斷模式：只爬列表頁、印出候選連結，"
                            "不進內頁、不呼叫 AI、不寫 DB。用來驗證 list_selector 設定。"
                        ))
    parser.add_argument("--target",  type=str, default=None,
                        help="精確指定單一目標名稱（完整比對），如 '台東市公所活動訊息'")
    parser.add_argument("--only",    type=str, default=None,
                        help="名稱含此關鍵字的目標（模糊比對），如 '公所'")
    args = parser.parse_args()

    all_targets = load_targets()
    targets = all_targets

    # --target 精確比對（優先於 --only）
    if args.target:
        targets = [t for t in all_targets if t["name"] == args.target]
        if not targets:
            available = [t["name"] for t in all_targets]
            print(f"ERROR: no target with exact name '{args.target}'")
            print(f"Available targets:")
            for n in available:
                print(f"  - {n}")
            sys.exit(1)

    # --only 模糊比對（--target 未指定時才生效）
    elif args.only:
        targets = [t for t in all_targets if args.only in t["name"]]
        if not targets:
            available = [t["name"] for t in all_targets]
            print(f"ERROR: no target matching '{args.only}'")
            print(f"Available: {available}")
            sys.exit(1)

    # ── probe 模式：只診斷列表頁連結發現，完全不寫 DB ──────────────────────────
    if args.probe:
        print(f"[PROBE] township_scraper v3 — {len(targets)} target(s)")
        print("        診斷模式：不進入內頁、不呼叫 AI、不寫 DB\n")
        for cfg in targets:
            try:
                probe_target(cfg)
            except Exception as e:
                print(f"[CRIT] {cfg['name']} probe crashed: {e}")
            time.sleep(random.uniform(2, 4))
        print("[PROBE] 完成。請根據輸出調整 list_selector / url_must_contain 後再正式爬取。")
        return

    print(f"[START] township_scraper v3 — {len(targets)} target(s), limit={args.limit}")
    if args.dry_run:
        print("        ⚠️  DRY-RUN mode — full pipeline, zero DB writes")

    total = {"found": 0, "events": 0, "raw_saved": 0, "skipped": 0}

    for config in targets:
        try:
            s = scrape_target(config, max_items=args.limit, dry_run=args.dry_run)
            for k in total:
                total[k] += s[k]
        except Exception as e:
            print(f"[CRIT] {config['name']} crashed: {e}")
        time.sleep(random.uniform(4, 8))

    print(f"\n{'─'*50}")
    mode_label = "DRY-RUN (no DB writes)" if args.dry_run else "LIVE"
    print(f"[DONE]  mode={mode_label}")
    print(f"        found={total['found']} | events={total['events']} "
          f"| raw_queued={total['raw_saved']} | skipped={total['skipped']}")
    if not args.dry_run and total["raw_saved"] > 0:
        print("        Run: python process_pending.py  to process raw queue")
    print("\n\a\a\a")


if __name__ == "__main__":
    main()
