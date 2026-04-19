"""
scraper_backfill.py
────────────────────────────────────────────────────────────────────────────────
台東縣政府文化處活動平台 一次性歷史資料回溯（Backfill）

與 scraper.py 共用相同的 ai_data_cleaner / save_to_supabase 架構，差異在於：
  1. 固定目標：https://culture.taitung.gov.tw/activity
  2. 翻頁邏輯：載入列表頁一次，用 JS button-click（button[aria-label="下一頁"]）
     逐頁收集所有符合關鍵字的連結後再深度爬取（不使用 ?page=N URL 翻頁）

用法：
    python scraper_backfill.py                  # 抓 3 頁（預設）
    python scraper_backfill.py --pages 5        # 指定頁數
    python scraper_backfill.py --dry-run        # AI 清洗但不寫入 DB
    python scraper_backfill.py --limit 10       # 每頁最多處理 10 筆連結
"""

import argparse
import json
import os
import re
import time
import unicodedata

import requests
import urllib3
from bs4 import BeautifulSoup
from dotenv import find_dotenv, load_dotenv
from google import genai
from google.genai import types
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth
from supabase import create_client, Client
from urllib.parse import urljoin

# ── 初始化 ────────────────────────────────────────────────────────────────────

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv(find_dotenv(), encoding="utf-8-sig")

supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
gemini_key   = os.getenv("GEMINI_API_KEY", "").strip()

if not supabase_url or not supabase_key:
    print("❌ 嚴重錯誤：讀不到 SUPABASE_URL，請檢查 .env 檔案！")
    exit()

client: genai.Client = genai.Client(api_key=gemini_key)
supabase: Client     = create_client(supabase_url, supabase_key)

# ── 標題正規化（跨平台模糊去重用）────────────────────────────────────────────────

def normalize_title(s: str) -> str:
    """NFKC 全形轉半形 + 去除標點符號 + 小寫，用於跨平台標題模糊比對。"""
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[^\u4e00-\u9fff\w]", "", s)   # 只保留 CJK + 字母數字
    s = s.replace("_", "").lower()
    return s


# ── 回溯目標（固定單一站台）────────────────────────────────────────────────────

BACKFILL_SITE = {
    "name":     "台東藝文平台",
    "base_url": "https://culture.taitung.gov.tw/",
    "list_url": "https://culture.taitung.gov.tw/activity",
    "keywords": ["活動", "展演", "activity"],
}

# ── Timestamp 清洗工具（與 scraper.py 完全一致）────────────────────────────────

# 允許尾部帶時區偏移（如 +08:00）；.match() 只驗開頭，偏移量會被完整保留
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


def sanitize_timestamp(val) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "未提供", ""):
        return None
    if not _ISO_RE.match(s):
        return None
    return s


def extract_end_date(end_time_iso: str | None) -> str | None:
    if not end_time_iso:
        return None
    return end_time_iso[:10]


# ── save_to_supabase（與 scraper.py 完全一致）────────────────────────────────

def save_to_supabase(event_data, dry_run: bool = False):
    """支援單筆或系列活動 (List) 的自動拆解寫入。"""
    events_to_process = event_data if isinstance(event_data, list) else [event_data]

    for single_event in events_to_process:
        title = single_event.get("event_name", "未提供")
        try:
            start_time = sanitize_timestamp(single_event.get("iso_start_time"))
            end_time   = sanitize_timestamp(single_event.get("iso_end_time"))
            end_date   = single_event.get("end_date") or extract_end_date(end_time)

            if not start_time:
                print(f"⚠️  跳過（無有效 start_time）：{title}")
                continue

            source_url = single_event.get("source_url", "")

            # ── 第一層：複合鍵去重（source_url + title）────────────────────
            # 修正：不再單靠 source_url 阻擋，避免同頁系列活動被誤殺。
            # 只有「網址相同」且「標題也相同」才視為真重複。
            if source_url:
                dup = (
                    supabase.table("events").select("id")
                    .eq("source_url", source_url)
                    .eq("title", title)
                    .execute()
                )
                if dup.data:
                    print(f"⏩ 已存在（source_url + title 重複），跳過：{title}")
                    continue

            # ── 第二層：跨平台模糊去重（同日期 + 正規化標題子字串比對）
            # 防止美學館、文化處發布同一展覽時因標點/全半形差異而重複入庫。
            date_prefix = start_time[:10]
            norm_new = normalize_title(title)
            if norm_new and date_prefix:
                same_day = (
                    supabase.table("events").select("id, title")
                    .gte("start_time", f"{date_prefix}T00:00:00")
                    .lte("start_time", f"{date_prefix}T23:59:59")
                    .execute()
                )
                fuzzy_matched = False
                for ev in same_day.data:
                    norm_ev = normalize_title(ev["title"])
                    if norm_new and norm_ev and (
                        norm_new in norm_ev or norm_ev in norm_new or
                        (len(norm_new) >= 8 and len(norm_ev) >= 8 and norm_new[:8] == norm_ev[:8])
                    ):
                        fuzzy_matched = True
                        break
                if fuzzy_matched:
                    print(f"⏩ 已存在（跨平台正規化比對），跳過：{title}")
                    continue

            payload = {
                "title":             title,
                "description":       single_event.get("card_summary", ""),
                "long_description":  single_event.get("long_description", ""),
                "image_captured":    single_event.get("image_url", ""),
                "start_time":        start_time,
                "end_time":          end_time,
                "end_date":          end_date,
                "venue_name":        single_event.get("location", "未提供"),
                "latitude":          single_event.get("latitude"),
                "longitude":         single_event.get("longitude"),
                "is_free":           single_event.get("is_free", False),
                "ticket_url":        single_event.get("ticket_url"),
                "source_url":        source_url,
                "vibe_tags":         single_event.get("vibe_tags", []),
                "target_audience":   single_event.get("target_audience", []),
                "indoor_or_outdoor": single_event.get("indoor_or_outdoor"),
                "weather_resilience": single_event.get("weather_resilience", 3),
                "engagement_metrics": {"score": 0},
                "affiliate_links": {
                    "rental":        {"label": "租車/租機車", "url": None},
                    "ticket":        {"label": "售票連結",   "url": None},
                    "accommodation": {"label": "周邊住宿",   "url": None},
                },
            }

            if dry_run:
                print("[DRY-RUN] 預覽 payload（不寫入）：")
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            else:
                supabase.table("events").insert(payload).execute()
                date_label = start_time[:10]
                end_label  = f" ~ {end_date}" if end_date and end_date != start_time[:10] else ""
                print(f"✅ 存入：{title} ({date_label}{end_label})")

        except Exception as e:
            print(f"❌ 存入失敗 [{title}]: {e}")


# ── ai_data_cleaner（與 scraper.py 完全一致）────────────────────────────────

def ai_data_cleaner(raw_text, image_url, source_url):
    image_data = None
    if image_url and image_url.startswith("http"):
        try:
            print("👁️ 正在將海報交給 AI 分析時間表...")
            img_res = requests.get(image_url, timeout=10, verify=False)
            if img_res.status_code == 200:
                image_data = types.Part.from_bytes(
                    data=img_res.content,
                    mime_type="image/jpeg",
                )
        except Exception as e:
            print(f"⚠️ 圖片下載失敗，僅使用文字分析: {e}")

    prompt = f"""
你是專業的台灣在地文化策展人。請閱讀下方文字與【海報圖片】，萃取出活動資訊。

═══════════════════════════════════════════
【標題精煉規則（Critical）】

提取 event_name 時，請強制執行：
  • 刪除冠頭的主辦單位全名，例如「財團法人○○基金會」、「中華民國台東縣○○協會」、「台東縣政府文化處」等
  • 刪除括號內的附註說明或副標題，例如「（自由入場）」、「（線上報名）」
  • 保留最核心的「活動 / 展覽主名稱」，若有子標題以「－」連接
  • 範例：「台東縣政府文化處主辦 第十屆山海有聲音樂節（免費入場）」
         → 應精煉為「山海有聲音樂節」

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
    "location":       "場館名稱",
    "latitude":       緯度數字或 null,
    "longitude":      經度數字或 null,
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

    for attempt in range(3):
        try:
            api_contents = [prompt]
            if image_data:
                api_contents.append(image_data)

            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=api_contents,
            )
            clean_text = response.text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean_text, strict=False)
            # 空物件 {} → AI 表示「此頁無法萃取活動」，視同 ignore
            if isinstance(result, dict) and not result:
                return {"status": "ignore"}
            return result

        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"⏳ 撞到頻率限制！罰站 60 秒... (第 {attempt + 1}/3 次)")
                time.sleep(60)
            else:
                print(f"🧠 AI 處理出錯: {e}")
                return None
    return None


# ── 核心回溯函數（翻頁 → 收集連結 → 深度爬取）────────────────────────────────

def backfill_spider(total_pages: int = 3, dry_run: bool = False, limit: int = 0):
    site     = BACKFILL_SITE
    base_url = site["base_url"]
    list_url = site["list_url"]
    keywords = site["keywords"]

    print(f"\n🚢 回溯目標：{site['name']} ({list_url})")
    print(f"   翻頁範圍：第 1 ~ {total_pages} 頁")

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

        # ── 第一階段：翻頁收集連結（JS button-click，不使用 ?page=N）──────────
        # culture.taitung.gov.tw 為 Vue SPA，URL 不反映頁碼，必須點擊按鈕翻頁。
        all_links: list[tuple[str, str]] = []
        seen_urls: set[str]              = set()

        NEXT_BTN = 'button[aria-label="下一頁"]'

        def _harvest_links(soup: BeautifulSoup) -> int:
            """從 BeautifulSoup 解析本頁活動連結，回傳新增筆數。"""
            added = 0
            for link in soup.find_all("a"):
                href      = link.get("href", "")
                link_text = link.get_text(strip=True)
                if not href:
                    continue
                if not any(k in href.lower() or k in link_text.lower() for k in keywords):
                    continue
                full_url = urljoin(base_url, href)
                if base_url not in full_url:
                    continue
                if full_url in (base_url, list_url):
                    continue
                if full_url.endswith("/history"):
                    continue
                if full_url in seen_urls:
                    continue
                seen_urls.add(full_url)
                all_links.append((link_text, full_url))
                added += 1
            return added

        print(f"\n📄 載入列表頁：{list_url}")
        try:
            page.goto(list_url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(3_000)
        except Exception as e:
            print(f"   ❌ 列表頁載入失敗：{e}")
            browser.close()
            return

        zero_gain_streak = 0

        for page_num in range(1, total_pages + 1):
            soup     = BeautifulSoup(page.content(), "html.parser")
            new_cnt  = _harvest_links(soup)
            print(f"   第 {page_num}/{total_pages} 頁 → +{new_cnt} 筆，累計 {len(all_links)} 筆")

            if new_cnt == 0:
                zero_gain_streak += 1
                if zero_gain_streak >= 2:
                    print("   ⚠️  連續 2 頁零收穫，提早停止翻頁")
                    break
            else:
                zero_gain_streak = 0

            if page_num >= total_pages:
                break   # 已達目標頁數，不再翻頁

            # ── 點擊「下一頁」按鈕 ──────────────────────────────────────────
            try:
                btn = page.locator(NEXT_BTN).first
                if btn.count() == 0:
                    print("   🏁 找不到下一頁按鈕，列表掃描完成")
                    break
                if btn.is_disabled():
                    print("   🏁 下一頁按鈕已 disabled，列表掃描完成")
                    break
                aria = btn.get_attribute("aria-disabled") or ""
                if aria.lower() == "true":
                    print("   🏁 下一頁 aria-disabled=true，列表掃描完成")
                    break

                # 記錄點擊前的第一個活動連結（用來偵測換頁成功）
                prev_first = None
                for a in soup.find_all("a", href=True):
                    if any(k in a["href"].lower() for k in keywords):
                        prev_first = urljoin(base_url, a["href"])
                        break

                btn.click()
                try:
                    page.wait_for_load_state("networkidle", timeout=10_000)
                except Exception:
                    pass
                page.wait_for_timeout(1_500)

                # 驗證內容是否真的換頁了
                new_soup       = BeautifulSoup(page.content(), "html.parser")
                new_first_href = None
                for a in new_soup.find_all("a", href=True):
                    if any(k in a["href"].lower() for k in keywords):
                        new_first_href = urljoin(base_url, a["href"])
                        break

                if prev_first and new_first_href and new_first_href == prev_first:
                    print("   🏁 內容未變化（已到末頁），列表掃描完成")
                    break

            except Exception as e:
                print(f"   ❌ 翻頁失敗：{e}")
                break

        # ── 第二階段：深度爬取 + AI 清洗 + 寫入 DB ──────────────────────
        cap = limit if limit > 0 else len(all_links)
        targets = all_links[:cap]

        print(f"\n🔎 共收集 {len(all_links)} 筆連結，本次處理 {len(targets)} 筆")
        print("─" * 60)

        for idx, (text, url) in enumerate(targets, start=1):
            print(f"\n🚪 [{idx}/{len(targets)}] 潛入活動頁：{url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(2_500)

                # 抓主視覺圖（og:image 優先）
                main_img_url = page.evaluate("""() => {
                    let ogImg = document.querySelector('meta[property="og:image"]');
                    if (ogImg && ogImg.content) return ogImg.content;
                    let contentImg = document.querySelector(
                        '.activity img, .post-content img, article img, .editor img'
                    );
                    if (contentImg) {
                        return contentImg.getAttribute('data-src')
                            || contentImg.getAttribute('data-original')
                            || contentImg.src;
                    }
                    let imgs = Array.from(document.querySelectorAll('img'));
                    let bestImg = null, maxArea = 0;
                    for (let img of imgs) {
                        if (img.src.includes('icon') || img.src.includes('logo')) continue;
                        let area = img.width * img.height;
                        if (area > maxArea) { maxArea = area; bestImg = img; }
                    }
                    if (bestImg) {
                        return bestImg.getAttribute('data-src')
                            || bestImg.getAttribute('data-original')
                            || bestImg.src;
                    }
                    return '未提供';
                }""")

                if main_img_url and not main_img_url.startswith("http") and main_img_url != "未提供":
                    main_img_url = urljoin(url, main_img_url)

                print(f"🖼️  捕獲圖片：{main_img_url}")

                raw_content = page.locator("body").inner_text()
                event_json  = ai_data_cleaner(raw_content, main_img_url, url)

                if event_json is None:
                    print("⚠️  AI 回傳為空，略過此頁")
                elif isinstance(event_json, dict) and event_json.get("status") == "ignore":
                    print("🚫 AI 守門員判定為無效內容（徵件/租場/公告），跳過")
                else:
                    print("✨ 準備寫入資料庫...")
                    save_to_supabase(event_json, dry_run=dry_run)

            except Exception as e:
                print(f"⚠️ 略過此頁面（超時或錯誤）: {e}")

            time.sleep(15)

        browser.close()

    print(f"\n🏁 回溯完成，共處理 {len(targets)} 筆連結。")


# ── 入口 ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CulturRoute 台東藝文平台歷史回溯爬蟲")
    parser.add_argument(
        "--pages", type=int, default=3,
        help="要翻的列表頁數（預設 3）",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="完整執行爬取與 AI 清洗，但不寫入任何資料庫（安全預覽模式）",
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="最多處理幾筆連結（0 = 無限制，預設 0）",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("⚠️  [DRY-RUN 模式] 本次執行不會寫入任何資料庫！")

    print(f"🚀 [CulturRoute 歷史回溯] 啟動時間: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    try:
        backfill_spider(
            total_pages=args.pages,
            dry_run=args.dry_run,
            limit=args.limit,
        )
    except Exception as e:
        print(f"🚨 回溯任務發生嚴重錯誤: {e}")
