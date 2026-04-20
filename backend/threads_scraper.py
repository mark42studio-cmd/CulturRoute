import os
import time
import json
import random
from datetime import datetime, timezone
from dotenv import load_dotenv, find_dotenv
from playwright.sync_api import sync_playwright
from google import genai
from supabase import create_client, Client
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut
from scraper import generate_embedding, check_semantic_duplicate

load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

supabase_url = os.getenv("SUPABASE_URL").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY").strip()
gemini_key = os.getenv("GEMINI_API_KEY").strip()

client = genai.Client(api_key=gemini_key)
supabase: Client = create_client(supabase_url, supabase_key)
geolocator = Nominatim(user_agent="cultur_route_scraper")

SEARCH_KEYWORDS = [
    "台東 活動", "台東 展覽", "台東 音樂祭", "台東 市集",
    "台東 親子", "台東 導覽", "台東 講座", "台東 表演",
    "台東美術館", "台東設計中心"
]


# ── 座標查詢 ──────────────────────────────────────────────────────────────────

def get_coordinates(location_name):
    """Nominatim 座標查詢，作為 AI 座標的第二道防線"""
    if not location_name or location_name == '未提供':
        return None, None
    query = location_name if "台東" in location_name else f"台東 {location_name}"
    try:
        loc = geolocator.geocode(query)
        if loc:
            return loc.latitude, loc.longitude
    except GeocoderTimedOut:
        pass
    return None, None


# ── 預載已處理 permalink ───────────────────────────────────────────────────────

def fetch_processed_permalinks():
    """
    從 raw_threads_posts 預載所有 permalink，
    避免重複抓取；整個 session 共用此集合。
    """
    try:
        result = supabase.table("raw_threads_posts").select("permalink").execute()
        return {row["permalink"] for row in result.data if row.get("permalink")}
    except Exception as e:
        print(f"⚠️ 無法預載已處理 permalink：{e}")
        return set()


# ── 第一階段：存原始貼文 ───────────────────────────────────────────────────────

def save_raw_post(keyword, permalink, source_url, text):
    """
    原始貼文先行入庫（raw_status='pending'）。
    回傳插入後的 row id，供第二階段更新用；失敗回傳 None。
    """
    try:
        payload = {
            "platform":   "threads",
            "keyword":    keyword,
            "permalink":  permalink,
            "source_url": source_url,
            "raw_text":   text[:5000],      # 避免超長貼文塞爆 DB
            "raw_status": "pending",
        }
        result = supabase.table("raw_threads_posts").insert(payload).execute()
        row_id = result.data[0]["id"] if result.data else None
        return row_id
    except Exception as e:
        # permalink UNIQUE 衝突（重複抓取）會在這裡被捕捉
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return None   # 靜默跳過
        print(f"⚠️ raw 存庫失敗: {e}")
        return None


def update_raw_status(row_id, status):
    """更新 raw_threads_posts 的處理狀態"""
    try:
        supabase.table("raw_threads_posts").update({
            "raw_status":    status,
            "processed_at":  datetime.now(timezone.utc).isoformat(),
        }).eq("id", row_id).execute()
    except Exception as e:
        print(f"⚠️ 更新 raw_status 失敗 (id={row_id}): {e}")


# ── 第二階段：AI 清洗 ─────────────────────────────────────────────────────────

def ai_data_cleaner(raw_text):
    prompt = f"""
    你是台灣在地文化策展人。請閱讀社群貼文，判斷是否為「具體的台東藝文活動」。
    【重要過濾條件】：
    1. 如果只是閒聊、無具體時間地點，請務必回傳 {{"is_event": false}}。
    2. 如果貼文主要目的是「招募攤商」、「志工招募」或「內部培訓」，請回傳 {{"is_event": false}}。

    如果是活動，請 strictly 回傳純 JSON：
    {{
      "is_event": true,
      "event_name": "標題",
      "iso_start_time": "ISO 8601格式時間",
      "iso_end_time": "ISO 8601格式結束時間 (若無則 null)",
      "location": "地點名稱",
      "latitude": 緯度數字 (若能根據地點名稱判斷則提供，否則為 null),
      "longitude": 經度數字 (若能根據地點名稱判斷則提供，否則為 null),
      "is_free": true/false,
      "vibe_tags": ["#標籤1", "#標籤2"],
      "target_audience": ["親子", "情侶", "獨旅", "銀髮"] (選1-3個),
      "weather_resilience": 1-5,
      "card_summary": "15-30字吸睛簡介"
    }}
    貼文：{raw_text[:2000]}
    """
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash-lite', contents=prompt
            )
            clean_text = response.text.replace("```json", "").replace("```", "").strip()
            return json.loads(clean_text)
        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"⏳ Gemini 頻率限制，罰站 60 秒... (第 {attempt+1}/3 次)")
                time.sleep(60)
            else:
                print(f"⚠️ AI 解析失敗: {e}")
                return None
    return None


# ── 第二階段：寫入 events ─────────────────────────────────────────────────────

def save_event(event_data, source_url):
    """AI 判定為活動後，寫入 events 表"""
    try:
        if isinstance(event_data, list):
            if not event_data:
                return False
            event_data = event_data[0]

        lat = event_data.get('latitude')
        lon = event_data.get('longitude')
        if not lat or not lon:
            lat, lon = get_coordinates(event_data.get('location', '未提供'))

        payload = {
            "title":              event_data.get('event_name', '未提供'),
            "description":        event_data.get('card_summary', ''),
            "start_time":         event_data.get('iso_start_time'),
            "end_time":           event_data.get('iso_end_time'),
            "venue_name":         event_data.get('location', '未提供'),
            "latitude":           lat,
            "longitude":          lon,
            "is_free":            event_data.get('is_free', False),
            "source_url":         source_url,
            "vibe_tags":          event_data.get('vibe_tags', []),
            "target_audience":    event_data.get('target_audience', []),
            "weather_resilience": event_data.get('weather_resilience', 3),
            "engagement_metrics": {"image_captured": event_data.get('image_url', '')},
            # 分潤欄位（CLAUDE.md 規範：必須保留，未有實際連結填 null）
            "affiliate_links": {
                "rental":        {"label": "租車/租機車", "url": None},
                "ticket":        {"label": "售票連結",   "url": None},
                "accommodation": {"label": "周邊住宿",   "url": None}
            }
        }

        # ── 向量語意去重（最終防線）────────────────────────────────────────────
        embed_text = (
            f"{payload['title']} "
            f"{(payload.get('start_time') or '')[:10]} "
            f"{payload.get('description', '')[:200]}"
        ).strip()
        embedding = generate_embedding(embed_text)
        if embedding:
            is_dup, matched = check_semantic_duplicate(
                embedding,
                new_start_date=(payload.get('start_time') or '')[:10],
                new_title=payload['title'],
            )
            if is_dup:
                print(f"🧠 語意重複，跳過：{payload['title']}（↳ 相似：{matched}）")
                return False
        payload["embedding"] = embedding  # None → Supabase 寫入 NULL

        supabase.table("events").insert(payload).execute()
        print(f"✅ 寫入 events：{payload['title']}")
        return True
    except Exception as e:
        print(f"❌ 寫入 events 失敗: {e}")
        return False


# ── DOM 抓取（text + permalink）────────────────────────────────────────────────

def extract_posts(page):
    """
    在瀏覽器端執行，同時回傳每篇貼文的 {text, permalink}。
    選擇器策略：
      策略一：a[href*="/post/"] 定位連結，往上找最近容器取全文
      策略二：fallback — article / [role="article"] 容器
    """
    posts = page.evaluate("""
        () => {
            const results = [];
            const seen = new Set();

            const postLinks = document.querySelectorAll('a[href*="/post/"]');
            postLinks.forEach(link => {
                const href = link.href;
                if (seen.has(href)) return;
                const container =
                    link.closest('article') ||
                    link.closest('[role="article"]') ||
                    link.closest('div[data-pressable-container="true"]') ||
                    link.parentElement?.parentElement?.parentElement;
                const text = container ? container.innerText : link.innerText;
                if (text && text.trim().length > 30) {
                    seen.add(href);
                    results.push({ text: text.trim(), permalink: href });
                }
            });

            if (results.length === 0) {
                const articles = document.querySelectorAll('article, [role="article"]');
                articles.forEach(article => {
                    const link = article.querySelector('a[href*="/post/"]');
                    const href = link ? link.href : null;
                    if (href && seen.has(href)) return;
                    const text = article.innerText;
                    if (text && text.trim().length > 30) {
                        if (href) seen.add(href);
                        results.push({ text: text.trim(), permalink: href || null });
                    }
                });
            }

            return results;
        }
    """)
    return posts if posts else []


# ── 主流程 ────────────────────────────────────────────────────────────────────

def threads_keyword_patrol(limit: int = 0):
    """
    limit: 每個關鍵字最多抓取的貼文數量；0 表示不限制。
    """
    print("🚀 [Threads 廣域海巡] 啟動 raw-first 兩階段抓取...")
    if limit:
        print(f"   ⚙️  --limit={limit}：每個關鍵字最多抓 {limit} 筆")

    # 預載已入庫 permalink，整個 session 共用
    print("📋 預載已入庫 permalink...")
    known_permalinks = fetch_processed_permalinks()
    print(f"   -> 已有 {len(known_permalinks)} 筆，將自動跳過")

    # ── 第一階段：爬取並存原始貼文 ──────────────────────────────────────────
    print("\n═══ 第一階段：原始貼文抓取 ═══")
    raw_queue = []   # [(row_id, permalink, text), ...]  供第二階段消費

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()

        try:
            with open("threads_cookies.json", "r", encoding="utf-8") as f:
                cookies = json.load(f)
                context.add_cookies(cookies)
                print("🎟️ 成功載入通行證 (Cookies)！")
        except FileNotFoundError:
            print("⚠️ 找不到 threads_cookies.json，以「未登入」狀態執行")

        page = context.new_page()

        for keyword in SEARCH_KEYWORDS:
            print(f"\n--- 🔍 關鍵字: 【{keyword}】 ---")
            search_url = f"https://www.threads.net/search?q={keyword}"
            try:
                page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                time.sleep(3)

                for i in range(15):
                    page.mouse.wheel(0, random.randint(1200, 1800))
                    if (i + 1) % 3 == 0:
                        time.sleep(1)
                        page.mouse.wheel(0, -300)
                    time.sleep(random.uniform(2.5, 5.0))
                    print(f"   -> 滾動 {i+1}/15")

                posts = extract_posts(page)
                if limit:
                    posts = posts[:limit]
                print(f"📦 抓到 {len(posts)} 篇，開始存原始貼文...")

                saved = 0
                for post in posts:
                    text      = post.get("text", "")
                    permalink = post.get("permalink")
                    source    = permalink or search_url

                    if len(text) <= 30:
                        continue

                    # 已知 permalink 跳過（不重新入庫）
                    if permalink and permalink in known_permalinks:
                        continue

                    row_id = save_raw_post(keyword, permalink, source, text)
                    if row_id:
                        raw_queue.append((row_id, source, text))
                        if permalink:
                            known_permalinks.add(permalink)
                        saved += 1

                print(f"   -> 本輪新存 {saved} 筆原始貼文")

            except Exception as e:
                print(f"❌ 爬取失敗: {e}")

            time.sleep(random.randint(10, 15))

        browser.close()

    # ── 第二階段：AI 清洗（爬蟲關閉後進行，失敗不中斷）──────────────────────
    print(f"\n═══ 第二階段：AI 清洗（共 {len(raw_queue)} 筆待處理）═══")

    ai_processed = ai_not_event = ai_failed = 0

    for row_id, source_url, text in raw_queue:
        try:
            event_data = ai_data_cleaner(text)

            if event_data is None:
                # AI 呼叫失敗（非 rate limit 的例外，或 retry 用盡）
                update_raw_status(row_id, "ai_failed")
                ai_failed += 1
                continue

            if event_data.get("is_event"):
                ok = save_event(event_data, source_url)
                update_raw_status(row_id, "processed" if ok else "ai_failed")
                if ok:
                    ai_processed += 1
                else:
                    ai_failed += 1
            else:
                update_raw_status(row_id, "not_event")
                ai_not_event += 1

        except Exception as e:
            print(f"⚠️ 第二階段單筆異常，標記 ai_failed (id={row_id}): {e}")
            update_raw_status(row_id, "ai_failed")
            ai_failed += 1

        time.sleep(random.uniform(0.5, 1.0))

    print(f"\n🎉 任務完成。")
    print(f"   活動寫入: {ai_processed} | 非活動: {ai_not_event} | AI失敗: {ai_failed}")
    if ai_failed > 0:
        print(f"   ℹ️  ai_failed 筆數可稍後重跑：SELECT * FROM raw_threads_posts WHERE raw_status='ai_failed';")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Threads 台東藝文關鍵字巡邏爬蟲")
    parser.add_argument("--limit", type=int, default=0,
                        help="每個關鍵字最多抓取的貼文數量（預設 0 = 不限制）")
    args = parser.parse_args()
    threads_keyword_patrol(limit=args.limit)
