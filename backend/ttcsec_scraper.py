"""
ttcsec_scraper.py ── 國立臺東生活美學館專屬爬蟲
目標：https://www.ttcsec.gov.tw/

特殊挑戰：
  1. 活動列表為 JS 輪播（li.next > span > a[title="下一則"]，href="javascript:void(0);"）
     → 無法用 URL 翻頁，需點擊後等待 DOM 更新
  2. 活動頁含「主展期」+ 巢狀「系列單日子活動」的複雜時間結構
     → 需要「主從時間分離」才能正確萃取 start/end_date

執行指令：
  python ttcsec_scraper.py            # 正式寫入 Supabase
  python ttcsec_scraper.py --dry-run  # 只預覽，不寫入
  python ttcsec_scraper.py --limit 5  # 只處理前 5 筆活動（測試用）
"""

import os
import re
import time
import json
import hashlib
import requests
import urllib3
import argparse
from urllib.parse import urljoin, urlparse
from dotenv import load_dotenv, find_dotenv
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth
from bs4 import BeautifulSoup
from google import genai
from google.genai import types

# ── 共用工具從 scraper.py 匯入，避免重複定義 ────────────────────────────────
from scraper import save_to_supabase, normalize_title

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv(find_dotenv(), encoding="utf-8-sig")

gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
if not gemini_key:
    print("❌ 嚴重錯誤：讀不到 GEMINI_API_KEY，請檢查 .env 檔案！")
    exit()

client = genai.Client(api_key=gemini_key)

# ── 站台配置 ─────────────────────────────────────────────────────────────────
BASE_URL = "https://www.ttcsec.gov.tw"
LIST_URL = "https://www.ttcsec.gov.tw/"   # 活動輪播直接在首頁

# 硬性點擊上限：輪播為無限循環設計，10 次已足以涵蓋所有活動卡片
MAX_SLIDES = 10

# 連續零新增停損：連續幾次點擊都沒有發現新 URL，視為已繞完一圈，強制結束
MAX_ZERO_GAIN_STREAK = 2

# 排除這些路徑的連結（避免蒐集到非活動頁）
LINK_BLACKLIST = ["/search", "/tag/", "/rss", "/feed", "/sitemap", "/login", "/member"]


def _fix_source_url(event: dict, fallback_page_url: str) -> None:
    """
    修正無效的 source_url（空值、純 fragment 如 #、只剩 hostname 的 URL）。

    美學館輪播卡片指向外部系統（event.culture.tw），活動本身無獨立首頁 URL。
    若 source_url 無效，用「純化標題 + 開始日期」生成確定性 MD5 Hash URL，
    確保資料庫的去重邏輯（Layer 1 source_url+title 比對）能正常運作。
    """
    src = event.get("source_url", "") or ""
    try:
        parsed = urlparse(src)
        # 有效條件：有 scheme、有 netloc、且路徑不只是 / 或空
        is_valid = bool(
            parsed.scheme and parsed.netloc and
            parsed.path.rstrip("/") != ""
        )
    except Exception:
        is_valid = False

    if not is_valid:
        title     = event.get("event_name", "")
        start_day = (event.get("iso_start_time") or "")[:10]   # YYYY-MM-DD
        key       = f"ttcsec|{normalize_title(title)}|{start_day}"
        h         = hashlib.md5(key.encode()).hexdigest()[:12]
        event["source_url"] = f"https://www.ttcsec.gov.tw/event-hash-{h}"


# 「活動」區塊辨識關鍵字（用於在多個輪播中定位正確那個）
_ACTIVITY_KWORDS = "['活動', 'activity', 'event', 'news']"

# ── 共用 JS snippet：往上爬 DOM 找最近的「活動」容器 ────────────────────────
# 注意：此字串會被 f-string 插入 page.evaluate()，請勿在此使用 Python 大括號。
_JS_IN_ACTIVITY = f"""
function inActivitySection(el) {{
    const KW = {_ACTIVITY_KWORDS};
    let node = el;
    for (let d = 0; d < 12 && node; d++) {{
        const id  = (node.id  || '').toLowerCase();
        const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
        if (KW.some(k => id.includes(k) || cls.includes(k))) return true;
        const heads = node.querySelectorAll(
            'h1,h2,h3,h4,h5,.title,.section-title,.block-title,.heading'
        );
        for (const h of heads)
            if (KW.some(k => h.textContent.trim().includes(k))) return true;
        node = node.parentElement;
    }}
    return false;
}}
"""


# ── 精準輪播輔助函數 ──────────────────────────────────────────────────────────

def _is_activity_carousel_ended(page) -> bool:
    """
    檢查「活動訊息」輪播的 li.next 是否已隱藏（表示到末頁）。
    首頁可能有多個輪播（出版品、消息等），優先檢查活動區塊的那個；
    找不到活動容器則 fallback 檢查第一個 li.next。
    """
    return page.evaluate(f"""
    (() => {{
        {_JS_IN_ACTIVITY}

        function isHidden(el) {{
            const cs = window.getComputedStyle(el);
            return cs.display === 'none' || cs.visibility === 'hidden'
                   || el.style.display === 'none';
        }}

        const allLis = [...document.querySelectorAll('li.next')];
        if (allLis.length === 0) return true;
        if (allLis.length === 1) return isHidden(allLis[0]);

        // 多個輪播：找活動區塊的 li.next
        for (const li of allLis)
            if (inActivitySection(li)) return isHidden(li);

        return isHidden(allLis[0]);  // fallback
    }})()
    """)


def _click_activity_next_btn(page) -> dict:
    """
    找到「活動訊息」輪播的「下一則」按鈕並點擊。
    回傳 dict：{{ found, count, strategy }}
      - found: bool，是否找到並點擊
      - count: int，頁面上「下一則」按鈕總數
      - strategy: str，'sole'／'activity_section'／'fallback_first'
    """
    return page.evaluate(f"""
    (() => {{
        {_JS_IN_ACTIVITY}

        const allBtns = [...document.querySelectorAll(
            'li.next > span > a[title="下一則"]'
        )];
        if (allBtns.length === 0)
            return {{ found: false, count: 0, strategy: 'none' }};

        // 只有一個：直接點
        if (allBtns.length === 1) {{
            allBtns[0].click();
            return {{ found: true, count: 1, strategy: 'sole' }};
        }}

        // 多個輪播：找活動區塊的按鈕
        for (const btn of allBtns) {{
            if (inActivitySection(btn)) {{
                btn.click();
                return {{ found: true, count: allBtns.length, strategy: 'activity_section' }};
            }}
        }}

        // 找不到活動容器，點第一個（保底）
        allBtns[0].click();
        return {{ found: true, count: allBtns.length, strategy: 'fallback_first' }};
    }})()
    """)


# ══════════════════════════════════════════════════════════════════════════════
# Phase 1：輪播列表蒐集器
# ══════════════════════════════════════════════════════════════════════════════
def collect_event_links(page) -> list[str]:
    """
    從美學館 JS 輪播列表蒐集所有活動詳細頁面 URL。

    ⚠️ 該網站為無限循環輪播，li.next 永遠不會 display:none。
    因此改用雙重停損取代「末頁偵測」：

    停止條件（四道保險，任一觸發即 break）：
      ① li.next 已隱藏（display:none）—— 保留，應對未來改版
      ② 找不到「下一則」按鈕
      ③ 連續 MAX_ZERO_GAIN_STREAK 次點擊後新增 URL 數均為 0
         （代表已繞完一圈，所有活動卡片都看過了）
      ④ 達到 MAX_SLIDES 硬性點擊上限
    """
    collected: set[str] = set()
    slide_count     = 0
    zero_gain_streak = 0   # 連續零新增計數器

    print(f"🎠 載入美學館首頁（活動輪播位置）：{LIST_URL}")
    try:
        page.goto(LIST_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
    except Exception as e:
        print(f"❌ 首頁載入失敗：{e}")
        return []

    while slide_count < MAX_SLIDES:
        # ── 用精準 Selector 抓輪播卡片連結（DevTools 確認：.ct > a）────────────
        # 卡片結構：<div class="ct"><a href="..." class="div" title="...">
        # 活動連結可能指向外部網域（如 event.culture.tw），不限制同網域。
        raw_links: list[str] = page.evaluate("""
        (() => {
            const cards = document.querySelectorAll('.ct > a[href]');
            const links = [];
            for (const a of cards) {
                const href = (a.getAttribute('href') || '').trim();
                if (!href || href.startsWith('javascript') || href.startsWith('#'))
                    continue;
                try {
                    const u = new URL(href, location.href);
                    // 過濾「只有 hostname + fragment，無實際路徑」的無效 URL
                    // 例：https://www.ttcsec.gov.tw/#  或  https://ttcsec.gov.tw/
                    if (u.pathname.replace(/\\/+$/, '') === '' && !u.search)
                        continue;
                    links.push(u.href);
                } catch (_) {}
            }
            return [...new Set(links)];
        })()
        """)

        before = len(collected)
        for link in raw_links:
            collected.add(link)

        new_found = len(collected) - before
        print(f"   🔖 滑動第 {slide_count + 1} 格 → +{new_found} 筆（累計 {len(collected)} 筆）")

        # ── 停止條件 ③ ：連續零新增停損 ─────────────────────────────────────
        if new_found == 0:
            zero_gain_streak += 1
            if zero_gain_streak >= MAX_ZERO_GAIN_STREAK:
                print(f"   🏁 連續 {zero_gain_streak} 格無新增 URL，已繞完一圈，停止蒐集")
                break
        else:
            zero_gain_streak = 0   # 有新增就重置連續計數

        # ── 停止條件 ① ：活動區塊的 li.next 是否已隱藏（應對非無限輪播）──────
        if _is_activity_carousel_ended(page):
            print("   🏁 活動輪播末頁（li.next 已隱藏），掃描完成")
            break

        # ── 點擊活動區塊的「下一則」並等待動畫落定 ───────────────────────────
        click_result = _click_activity_next_btn(page)

        if not click_result.get("found"):
            print('   🏁 找不到「下一則」按鈕，輪播掃描完成')
            break

        strategy = click_result.get("strategy", "")
        count    = click_result.get("count", 1)
        if count > 1:
            print(f"      （頁面共 {count} 個輪播，點擊策略：{strategy}）")

        # 等待輪播動畫：networkidle 處理 AJAX；固定 1.2s 補足 CSS 動畫緩衝
        try:
            page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        page.wait_for_timeout(1200)

        slide_count += 1

    # ── 停止條件 ④ ：超過硬性點擊上限 ───────────────────────────────────────
    if slide_count >= MAX_SLIDES:
        print(f"   ⚠️  已達最大點擊上限（{MAX_SLIDES} 格），停止蒐集")

    result = list(collected)
    print(f"\n📋 輪播掃描完成，共蒐集 {len(result)} 個活動連結")
    return result


# ══════════════════════════════════════════════════════════════════════════════
# Phase 2：美學館專屬 AI 清洗器（主從時間分離）
# ══════════════════════════════════════════════════════════════════════════════
def ai_data_cleaner_ttcsec(raw_text: str, image_url: str, source_url: str):
    """
    美學館專屬 Gemini 清洗器。

    與通用版最大差異：
      • 強制執行「主展期 vs 系列子活動」主從時間分離
      • 系列子活動時程完整保存於 long_description，絕不拆解成多筆 JSON
      • location 預設填「國立臺東生活美學館」（場館本身），
        只有在明確指定其他地點時才覆蓋
    """
    image_data = None
    if image_url and image_url.startswith("http"):
        try:
            img_res = requests.get(image_url, timeout=10, verify=False)
            if img_res.status_code == 200:
                image_data = types.Part.from_bytes(
                    data=img_res.content, mime_type="image/jpeg"
                )
        except Exception as e:
            print(f"⚠️  圖片下載失敗：{e}")

    prompt = f"""
你是專業的台灣在地文化策展人，正在處理「國立臺東生活美學館」的活動頁面。
請閱讀下方網頁文字（與海報圖片），萃取活動資訊。

═══════════════════════════════════════════
【垃圾守門員（最優先判斷）】

若此頁面屬於以下任一類型，立即回傳：{{"status": "ignore"}}

  ✗ 場地租借公告 / 開放預約場地
  ✗ 徵件 / 公開招募 / 報名表單（無明確演出者）
  ✗ 人員招募 / 徵才 / 工作機會
  ✗ 行政公告 / 採購公告 / 法規說明
  ✗ 無明確日期或演出內容的空白頁面
  ✗ 一般新聞、FAQ、網站簡介、導覽說明等非活動內容

  ⚠️ 【逃生門條款（Escape Hatch）── 絕對強制，不可違反】
  如果提供的文字中「沒有明確的單一藝文活動或展覽資訊」，例如：
    · 這是一般公告、網站介紹、交通資訊頁
    · 頁面內容無法明確對應到一個具體活動的標題、日期、地點
  請立刻停止萃取，回傳：{{"status": "ignore"}}
  絕對禁止：自行捏造活動名稱、虛構日期、填入「範例」或「備註：此為範例」等假資料。
  「不確定」的唯一正確答案是回傳 ignore，而非猜測或創作。

  ⚠️ 【日期豁免原則，不可違反】
  即使活動開始日期已是過去，只要 end_date 在今天之後（仍在展出中），
  代表活動仍進行中，必須正常萃取，絕對不可因「已開始」而判為過期忽略。

═══════════════════════════════════════════
【主從時間分離（核心規則，絕對不可違反）】

美學館活動頁通常同時包含兩層時間結構，必須正確分辨：

▌第一層（主展覽期間）── 決定 iso_start_time / iso_end_time / end_date
  出現形式：
    「展覽期間：2026年4月11日(六) — 5月27日(三)」
    「活動期間：04/11 ～ 05/27」
    「展出日期：2026.04.11–05.27」
  萃取規則：
    → iso_start_time：主展期第一天 + 場館開放時間（優先抓內文；找不到預設 09:00:00+08:00）
    → iso_end_time：  主展期最後一天 + 場館關閉時間（優先抓內文；找不到預設 17:00:00+08:00）
    → end_date：      主展期最後一天，格式 YYYY-MM-DD

▌第二層（系列單日子活動）── 只存入 long_description，不影響主時間欄位
  出現形式：
    「04/11 Sat. 展覽開幕會 14:00」
    「04/12 Sun. 糖鐵講座 10:00–12:00」
    「05/03 開幕座談」
  萃取規則：
    → 這些子活動是附屬於主展覽的單日節目，絕對不得拆解為多筆 JSON 物件
    → 必須將所有子活動完整條列於 long_description 的【系列活動時程】區塊
    → 格式：每個子活動佔一行，例如：
       「• 04/11 (六) 14:00 展覽開幕會」
       「• 04/12 (日) 10:00 糖鐵講座（限額報名）」
    → 任何子活動的日期、時間、名稱、備註都不得遺漏

⚠️ 最常見的三種錯誤，嚴格禁止：
  ✗ 把某個系列子活動的日期（如 05/03）誤認為 end_date，忽略更晚的主展期結束日
  ✗ 把系列子活動拆解成多筆 JSON，回傳一個 Array 裡有多個活動物件
  ✗ long_description 裡漏掉任何子活動的時間或名稱

═══════════════════════════════════════════
【地點誠實原則（Anti-Hallucination）】

location 的唯一合法來源：活動正文、場館地址欄位、海報圖片。
  • 若正文未指定其他地點 → 填「國立臺東生活美學館」
  • 若正文明確指定其他場館（如分館、特定展廳、外部場地）→ 以該場地名稱為準
  • 絕對禁止從網站導覽列、側邊欄推測地點

═══════════════════════════════════════════
【展覽結束時間：場館時間優先規則】

iso_end_time 的時間基準依以下優先順序：
  ① 活動專屬時間（最優先）：若內文另有獨立結束時間
  ② 場館營業時間：若內文提及開放時間（如「開放時間 09:00–17:00」）
  ③ 備援：完全找不到場館時間，才可用 17:00:00+08:00 作為預設

═══════════════════════════════════════════
【回傳格式】

正常活動 → 回傳純 JSON Array（不含 ```json 標籤）：
[
  {{
    "event_name":         "展覽/活動完整名稱（含副標題）",
    "iso_start_time":     "主展期首日 YYYY-MM-DDTHH:MM:SS+08:00（必填）",
    "iso_end_time":       "主展期末日 YYYY-MM-DDTHH:MM:SS+08:00（必填）",
    "end_date":           "主展期末日 YYYY-MM-DD（必填）",
    "location":           "國立臺東生活美學館（或另指定場館）",
    "latitude":           null,
    "longitude":          null,
    "is_free":            true 或 false,
    "ticket_url":         "購票連結或 null",
    "image_url":          "{image_url}",
    "vibe_tags":          ["從以下擇1-5個：音樂演出, 視覺藝術, 傳統工藝, 原住民文化, 在地節慶, 戶外體驗, 親子活動, 靜態展覽, 講座工作坊, 市集, 電影放映, 舞蹈, 戲劇表演, 祭典儀式, 生態旅遊, 書法文學, 藝術裝置, 官方展演, 社區活動"],
    "target_audience":    ["親子", "情侶", "獨旅", "銀髮"],
    "indoor_or_outdoor":  "indoor" 或 "outdoor" 或 "semi-outdoor",
    "weather_resilience": 1到5的整數（室內展覽通常為 5）,
    "card_summary":       "15-30字吸睛簡介，聚焦主展特色",
    "long_description":   "【主展介紹】\n（完整展覽說明文字）\n\n【系列活動時程】\n• MM/DD (週X) HH:MM 活動名稱（備註）\n• MM/DD (週X) HH:MM 活動名稱（備註）\n（每個子活動一行，完整條列，絕不遺漏）",
    "source_url":         "{source_url}"
  }}
]

垃圾內容 → 回傳：{{"status": "ignore"}}

═══════════════════════════════════════════
網頁文字：
{raw_text[:4000]}
"""

    max_retries = 3
    for attempt in range(max_retries):
        try:
            api_contents = [prompt]
            if image_data:
                api_contents.append(image_data)

            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=api_contents,
            )
            clean_text = response.text.replace("```json", "").replace("```", "").strip()
            # strict=False：允許 JSON 字串中含有未跳脫的控制字元（\n \t 等），
            # 這是 Gemini 偶爾在 long_description 換行時造成的 JSONDecodeError。
            return json.loads(clean_text, strict=False)

        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"⏳ Rate limit，罰站 60 秒... (第 {attempt + 1}/{max_retries} 次)")
                time.sleep(60)
            else:
                print(f"🧠 AI 處理出錯：{e}")
                return None
    return None


# ── 從活動頁面擷取最大內容圖片（與主爬蟲相同邏輯）────────────────────────────
_FIND_MAIN_IMG_JS = """() => {
    const BLACKLIST = ['banner', 'default', 'logo', 'bg', 'footer', 'header', 'icon', 'placeholder'];
    const isBlacklisted = src => !src || BLACKLIST.some(k => src.toLowerCase().includes(k));
    const getSrc = el => el.getAttribute('data-src') || el.getAttribute('data-original') || el.src || '';
    const area = img => (img.naturalWidth || img.width) * (img.naturalHeight || img.height);

    const pool = new Set();
    ['article img', '.content img', '.editor img', '.main-content img', 'main img']
        .forEach(sel => document.querySelectorAll(sel).forEach(img => pool.add(img)));

    let best = null, maxArea = 0;
    for (const img of pool) {
        const src = getSrc(img);
        if (isBlacklisted(src)) continue;
        const a = area(img);
        if (a > maxArea) { maxArea = a; best = img; }
    }
    if (best) return getSrc(best);

    const og = document.querySelector('meta[property="og:image"]');
    if (og?.content && !isBlacklisted(og.content)) return og.content;

    return '未提供';
}"""


# ══════════════════════════════════════════════════════════════════════════════
# 主執行
# ══════════════════════════════════════════════════════════════════════════════
def run(dry_run: bool = False, limit: int = 0) -> None:
    print(f"\n🚢 [美學館爬蟲] 啟動（{'DRY-RUN 預覽' if dry_run else '正式寫入'}）")

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
            # ── Phase 1：輪播蒐集所有活動連結 ────────────────────────────────
            event_urls = collect_event_links(page)

            if not event_urls:
                print("⚠️  未蒐集到任何活動連結，請確認 LIST_URL 是否正確")
                return

            # ── Phase 2：逐頁 AI 萃取與寫入 ──────────────────────────────────
            cap = limit if limit > 0 else len(event_urls)
            total = min(cap, len(event_urls))

            for idx, url in enumerate(event_urls[:cap], 1):
                print(f"\n🚪 [{idx}/{total}] 潛入活動頁：{url}")
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(2500)

                    main_img_url: str = page.evaluate(_FIND_MAIN_IMG_JS)
                    if main_img_url and not main_img_url.startswith("http") and main_img_url != "未提供":
                        main_img_url = urljoin(BASE_URL, main_img_url)
                    print(f"🖼️  圖片：{main_img_url}")

                    raw_content: str = page.locator("body").inner_text()
                    event_json = ai_data_cleaner_ttcsec(raw_content, main_img_url, url)

                    if event_json is None:
                        print("⚠️  AI 回傳為空，略過此頁")
                    elif isinstance(event_json, dict) and event_json.get("status") == "ignore":
                        print("🚫 AI 守門員：無效內容，跳過")
                    elif isinstance(event_json, dict) and not event_json:
                        print("🚫 AI 逃生門：頁面無明確藝文活動，跳過（防止幻覺寫入）")
                    else:
                        # ── 修正 source_url（輪播無獨立頁面時用 hash 替代）──────
                        events_list = event_json if isinstance(event_json, list) else [event_json]
                        for ev in events_list:
                            _fix_source_url(ev, url)
                        print("✨ 準備寫入資料庫...")
                        save_to_supabase(event_json, dry_run=dry_run)

                except Exception as e:
                    print(f"⚠️  略過此頁（超時或錯誤）：{e}")

                time.sleep(15)   # 禮貌性延遲，避免對目標站造成壓力

        except Exception as e:
            print(f"❌ 美學館爬蟲發生嚴重錯誤：{e}")
        finally:
            browser.close()

    print("\n💡 美學館爬蟲任務完成。")


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="國立臺東生活美學館專屬爬蟲")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="完整執行爬取與 AI 清洗，但不寫入任何資料庫（安全預覽模式）"
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="最多處理幾筆活動連結（0 = 全部，預設 0）"
    )
    args = parser.parse_args()

    if args.dry_run:
        print("⚠️  [DRY-RUN 模式] 本次執行不會寫入任何資料庫！")

    run(dry_run=args.dry_run, limit=args.limit)
