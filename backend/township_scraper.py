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


# ── AI 清洗（公所 / 官方機構版）─────────────────────────────────────────────

def ai_cleaner_official(
    raw_text: str,
    source_name: str,
    source_type: str,
    source_url: str,
    venue_hint: str,
    image_url: str | None = None,
    attachments: list[str] | None = None,
) -> list[dict] | None:
    """
    送 Gemini 清洗官方網站內頁文字（含可選的海報圖片多模態輸入）。
    attachments 清單也揭露在 prompt 中，讓 LLM 知道有哪些附件可供視覺 OCR 判讀。
    """
    source_label = {
        "official": "官方機構（博物館/美學館等）",
        "township": "鄉鎮公所（常轉知其他單位活動）",
    }.get(source_type, "官方網站")

    image_note = (
        f"\n【海報圖片已附上】：{image_url}\n"
        "請優先從圖片讀取活動日期、時間、地點、票價等關鍵資訊。\n"
        if image_url else
        "\n【無海報圖片】：請僅依賴文字內容判斷。\n"
    )

    attachments_note = ""
    if attachments:
        att_lines = "\n".join(f"  - {a}" for a in attachments[:10])
        attachments_note = (
            f"\n【附件 / 海報清單】（以下可能含活動日期、地點等關鍵資訊）：\n"
            f"{att_lines}\n"
            "若文字資訊不足，請嘗試從附件檔名或圖片 alt 推斷活動資訊。\n"
        )

    prompt = f"""
你是台灣在地文化策展人兼資料工程師。以下內容來自「{source_name}」（{source_label}）。
{image_note}{attachments_note}
【來源說明】：
- 發布單位：{source_name}
- 參考地區：{venue_hint}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 主理人嚴選規則 0：標題精煉規則（Critical，優先執行）
提取 event_name 時，請強制執行：
① 刪除冠頭的主辦單位全名，例如「財團法人○○基金會」「中華民國台東縣○○協會」「台東縣政府文化處」等
② 刪除括號內的附註說明，例如「（自由入場）」「（線上報名）」「（免費參加）」
③ 刪除行政前綴符號：【公告】【活動資訊】📢 等
④ 保留最核心的「活動 / 展覽主名稱」，若有子標題以「－」連接
⑤ 範例：「台東縣政府文化處主辦 第十屆山海有聲音樂節（免費入場）」→「山海有聲音樂節」

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 主理人嚴選規則 1：地理過濾器（Taitung-Only）
全國性或跨縣市系列活動（如家政 70 周年巡迴、桐花祭各地場），
只保留「台東縣」舉辦的場次，其他縣市場次一律忽略，不要輸出。
若整個活動都在台東以外 → 回傳 [{{"is_event": false}}]
若無法確認是台東 → 回傳 [{{"is_event": false}}]

★ 主理人嚴選規則 2：多場次與系列活動拆解（Multi-Session Splitter）
⚠️ 核心禁令：若內文列出「多個不連續的特定日期」（場次表、不同週末演出），
   絕對禁止將其合併為一個橫跨數月的單一長效活動。

觸發條件（符合任一即須拆解）：
  • 明確場次表：列出多個不連續日期（如：2/14、3/7、5/9）
  • 不同週末演出：每週六或隔週等週期性但各場獨立的演出
  • 子活動：同一頁面有不同日期/地點的獨立場次（如博覽會開幕式、山谷開桌、閉幕晚會）
  • 系列活動：總期間長達數月，各場有不同演出者或主題

拆解規則：
  • 每個具體舉辦日期 → 獨立輸出一個 JSON 物件
  • event_name 後加場次識別：「主名稱 (MM/DD場)」或「主名稱 - 子標題」
    例：「大坡池懷舊情歌 (5/9場)」、「金峰博覽會 - 開幕式」
  • 每筆 iso_end_time 填該場次當日結束時間+08:00，end_date 留 null
  • 即使只有一個活動，也必須包裝在 Array 中回傳

★ 主理人嚴選規則 3：視覺優先（Poster First）
若有附上海報圖片，請優先從圖片讀取活動資訊。
若文字極少，請特別留意：
  ① 附件清單中的圖片與 PDF 檔名（如 20260512_concert.jpg → 2026年5月12日）
  ② 圖片 alt 屬性文字
  ③ 多模態視覺判讀圖片上的日期、時間、地點

★ 主理人嚴選規則 4：容錯深度判讀
若文字資料不完整，請盡力從海報圖片、活動名稱、主辦單位名稱中推斷。
推斷資訊填入欄位，並在 card_summary 中標注「（詳見海報）」。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【⚠️ 發布單位 ≠ 活動地點】：
公所與官方機構的公告常常是「轉知」其他單位辦的活動。
嚴禁將「{source_name}」直接當成活動舉辦地點。

【地點判別（按優先順序）】：
1. 內文有「活動地點：○○」「舉辦地點：○○」「在○○廣場」→ 直接使用
2. 內文有「○○部落」「○○廣場」「○○社區」→ 使用該處
3. 活動名稱含地名（如「卑南族豐年祭」）→ 推斷部落廣場
4. 官方機構且未提其他地點 → 填機構本身名稱
5. 以上都找不到 → 該子活動輸出 {{"is_event": false}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【基本過濾】：
- 行政通知（停水/停電/施工/招標/人事）→ [{{"is_event": false}}]
- 非公開參與的活動 → [{{"is_event": false}}]
- 志工/攤商招募 → [{{"is_event": false}}]
- 線上報名 / 全國網路徵件 / 業者補助申請計畫 → [{{"is_event": false}}]
  （這類雖有時間截止，但不是「到台東現場參與的藝文體驗活動」）
- 明確標示地點在台東縣以外（如臺北、高雄、花蓮、苗栗）→ [{{"is_event": false}}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【民國年 → 西元年（嚴格遵守）】：
115年=2026、114年=2025、113年=2024（規則：+1911）
格式：YYYY-MM-DDTHH:mm:ss+08:00，禁止輸出民國年

【長期展覽 vs 單次活動】：
- 單次：iso_end_time = 當日結束時間+08:00，end_date = null
- 長期展覽（含「展期」「即日起至」）：iso_end_time = null，end_date = 最後一天

【展覽結束時間：營業時間優先規則】
跨日展覽的最後一天 iso_end_time 依以下優先順序決定：
① 活動專屬時間（最優先）：若活動本身另外註明獨立結束時間
  （例：園區 17:00 關門，但「星空電影院」寫明 19:00-21:00）→ 以活動專屬時間為準
② 場館營業/開放時間：若內文提及場館打烊時間（如「開放時間 09:00-17:00」）
  → 以打烊時間作為 iso_end_time 基準，例如 "2026-06-28T17:00:00+08:00"
③ 備援（極端情況）：完全找不到場館營業時間且無活動具體時間
  → 才可使用 23:59:59+08:00 作為最後備援（禁止在有線索時直接跳到此項）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
請 strictly 回傳純 JSON Array（不含 markdown code block、不含其他文字）：
[
  {{
    "is_event": true,
    "event_name": "活動標題（若系列活動格式：主名稱 - 子標題）",
    "iso_start_time": "YYYY-MM-DDTHH:mm:ss+08:00（西元，禁用民國年）",
    "iso_end_time": "結束時間或 null（長期展覽）",
    "end_date": "YYYY-MM-DD（長期展覽）或 null",
    "location": "實際活動地點（非發布公所）",
    "address": "完整地址或 null",
    "image_url": "海報/主視覺圖片 URL 或 null",
    "latitude": null,
    "longitude": null,
    "is_free": true 或 false,
    "vibe_tags": ["⚠️ 格式嚴格規定：純文字陣列，絕對禁止包含 # 或任何 Markdown 符號。從以下選1–5個：音樂演出, 視覺藝術, 傳統工藝, 原住民文化, 在地節慶, 戶外體驗, 親子活動, 靜態展覽, 講座工作坊, 市集, 電影放映, 舞蹈, 戲劇表演, 祭典儀式, 生態旅遊, 書法文學, 藝術裝置, 官方展演, 社區活動。⚠️ 標籤規則：真正的畫展/藝術展/博物館典藏展才可標『靜態展覽』；多日節慶、嘉年華、市集、音樂節等動態活動嚴禁標『靜態展覽』。輸出範例：[\"靜態展覽\", \"視覺藝術\"]"],
    "target_audience": ["親子/情侶/獨旅/銀髮/學生 中選適合的"],
    "weather_resilience": 1到5整數,
    "card_summary": "15-30字吸睛介紹（推斷資訊加註「詳見海報」）",
    "long_description": "完整活動說明"
  }}
]

來源：{source_name}
網址：{source_url}
內文：
{raw_text[:3500]}
"""
    image_part = download_image_part(image_url) if image_url else None
    api_contents: list = [prompt]
    if image_part:
        api_contents.append(image_part)

    for attempt in range(3):
        try:
            resp = gemini_client.models.generate_content(
                model="gemini-2.5-flash-lite", contents=api_contents
            )
            clean = resp.text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean)
            return result if isinstance(result, list) else [result]
        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"  [WAIT] Gemini rate limit, sleeping 60s ({attempt+1}/3)")
                time.sleep(60)
            else:
                print(f"  [ERR] AI parse failed: {e}")
                return None
    return None


# ── 寫入 events ────────────────────────────────────────────────────────────────

def fix_timezone_jig(ts: str | None) -> str | None:
    """
    時區防撞治具：若 ISO 時間字串結尾缺少時區資訊，強制補上 +08:00。
    已含 +/-HH:MM 偏移或 Z（UTC）者直接回傳，不重複補。
    """
    if not ts:
        return ts
    s = str(ts).strip()
    if not s:
        return None
    suffix = s[19:] if len(s) > 19 else ""
    if suffix.startswith("+") or suffix.startswith("-") or s.endswith("Z"):
        return s
    return s + "+08:00"


def save_event(event_data: dict, source_url: str, source_name: str,
               source_type: str, config_fixed_coords: dict | None) -> bool:
    try:
        title   = event_data.get("event_name", "未提供")
        # 時區防撞治具：補上缺漏的 +08:00，避免 Supabase 視為 UTC
        start   = fix_timezone_jig(event_data.get("iso_start_time"))
        end     = fix_timezone_jig(event_data.get("iso_end_time"))

        # ── 第一層：複合鍵去重（source_url + title）────────────────────────
        # 不再單靠 source_url 阻擋，避免同頁系列活動被誤殺；
        # 只有「網址相同」且「標題也相同」才視為真重複。
        if source_url:
            dup1 = (
                supabase.table("events")
                .select("id")
                .eq("source_url", source_url)
                .eq("title", title)
                .execute()
            )
            if dup1.data:
                print(f"  [SKIP] already exists (source_url + title): {title}")
                return False

        # ── 第二層：跨平台模糊去重（start_time 精確 + title 前 6 字模糊）────
        # 防止不同單位發布同一展覽時因標題微差異而重複入庫。
        title_prefix = title[:6]
        if title_prefix and start:
            dup2 = (
                supabase.table("events")
                .select("id")
                .eq("start_time", start)
                .ilike("title", f"{title_prefix}%")
                .execute()
            )
            if dup2.data:
                print(f"  [SKIP] already exists (cross-platform fuzzy): {title}")
                return False

        lat = event_data.get("latitude")
        lng = event_data.get("longitude")
        if not lat or not lng:
            lat, lng = lookup_venue_coords(event_data.get("location", ""))
        # ⚠️  修復：移除 config_fixed_coords fallback。
        # 原本此處會用來源網站（公所/獨立空間）的固定座標填補缺漏，
        # 但那是「發布單位」座標，不是「活動場地」座標，造成地圖定位偏差。
        # 找不到座標時改設 None，強迫前端 Geocoding API 用 venue_name 精確定位。
        if not lat or not lng:
            lat, lng = None, None
            print(f"  [COORD] no coords found for '{event_data.get('location', '')}' → null (frontend will geocode)")

        vibe_tags = list(event_data.get("vibe_tags", []))
        if source_type == "township" and "#在地節慶" not in vibe_tags:
            vibe_tags.append("#在地節慶")
        elif source_type == "official" and "#官方展演" not in vibe_tags:
            vibe_tags.append("#官方展演")

        # 圖片 URL 格式強校驗：非有效圖片格式一律清空，避免頁面 URL 存入 image_captured
        raw_image_url = event_data.get("image_url", "") or ""
        image_captured = raw_image_url if is_valid_image_url(raw_image_url) else ""
        if raw_image_url and not image_captured:
            print(f"  [IMG] 無效圖片 URL 已清除：{raw_image_url[:70]}")

        payload = {
            "title":              title,
            "description":        event_data.get("card_summary", ""),
            "long_description":   event_data.get("long_description", ""),
            "image_captured":     image_captured,
            "start_time":         start,
            "end_time":           end,
            "end_date":           event_data.get("end_date"),
            "venue_name":         event_data.get("location", "未提供"),
            "address":            event_data.get("address"),
            "latitude":           lat,
            "longitude":          lng,
            "is_free":            event_data.get("is_free", True),
            "source_url":         source_url,
            "vibe_tags":          vibe_tags,
            "target_audience":    event_data.get("target_audience", []),
            "weather_resilience": event_data.get("weather_resilience", 3),
            "engagement_metrics": {"score": 0},
            "affiliate_links": {
                "rental":        {"label": "租車/租機車", "url": None},
                "ticket":        {"label": "售票連結",   "url": None},
                "accommodation": {"label": "周邊住宿",   "url": None},
            },
        }

        # ── 向量語意去重（最終防線）────────────────────────────────────────────
        embed_text = (
            f"{title} "
            f"{start[:10] if start else ''} "
            f"{event_data.get('card_summary', event_data.get('long_description', ''))[:200]}"
        ).strip()
        embedding = generate_embedding(embed_text)
        if embedding:
            is_dup, matched = check_semantic_duplicate(
                embedding,
                new_start_date=start[:10] if start else None,
                new_title=title,
            )
            if is_dup:
                print(f"  🧠 語意重複，跳過：{title}（↳ 相似：{matched}）")
                return False
        payload["embedding"] = embedding  # None → Supabase 寫入 NULL

        supabase.table("events").insert(payload).execute()
        print(f"  [OK] saved: {title}")
        return True
    except Exception as e:
        print(f"  [ERR] save_event failed: {e}")
        return False


def save_events_list(events: list[dict], source_url: str, source_name: str,
                     source_type: str, config_fixed_coords: dict | None) -> int:
    """迭代 AI 回傳的 list，逐筆呼叫 save_event，回傳成功寫入筆數。"""
    saved = 0
    for event in events:
        if not event.get("is_event"):
            print(f"  [SKIP] AI says not_event")
            continue
        if save_event(event, source_url, source_name, source_type, config_fixed_coords):
            saved += 1
    return saved


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
        events_list = ai_cleaner_official(
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
                n = save_events_list(events_list, item_url, name, source_type, fixed_coords)
                stats["events"] += n
                if n == 0:
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
