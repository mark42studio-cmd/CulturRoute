"""
樂廣場節目單單筆 dry-run 測試腳本
"""
import os, sys, io, json, requests, urllib3
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from dotenv import load_dotenv, find_dotenv
load_dotenv(find_dotenv(), encoding='utf-8-sig', override=True)
urllib3.disable_warnings()

TARGET_URL = "https://culture.taitung.gov.tw/activity/%E6%A8%82%E5%BB%A3%E5%A0%B4-%E5%B1%B1%E6%B5%B7%E6%9C%89%E8%81%B2%EF%BD%9C%E7%AF%80%E7%9B%AE%E5%96%AE"
IMAGE_URL  = "https://culture.taitung.gov.tw/wp-content/uploads/2026/05/2026-5-%E7%AF%80%E7%9B%AE-outline.jpg"

print(f"🎯 測試目標：{TARGET_URL}")
print(f"🖼️  海報圖片：{IMAGE_URL}")
print("=" * 60)

# ── 1. 用 Playwright 抓頁面內容（Vue 渲染）────────────────
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

print("🌐 啟動 Playwright 抓取頁面...")
raw_text = ""
with Stealth().use_sync(sync_playwright()) as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(
        viewport={"width": 1280, "height": 800},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    )
    try:
        page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        raw_text = page.locator("body").inner_text()
        print(f"✅ 頁面抓取成功，內文長度：{len(raw_text)} 字元")
        print("--- 前 800 字 ---")
        print(raw_text[:800])
        print("---")
    except Exception as e:
        print(f"❌ 頁面抓取失敗：{e}")
    finally:
        browser.close()

if not raw_text:
    print("⛔ 無法取得頁面內容，終止測試")
    sys.exit(1)

# ── 2. 呼叫更新後的 ai_data_cleaner_v2 ─────────────────────
from scraper import ai_data_cleaner_v2
print("\n🧠 送交 Gemini 分析（含海報圖片）...")
result = ai_data_cleaner_v2(
    raw_text=raw_text,
    source_name="台東藝文平台",
    source_url=TARGET_URL,
    image_url=IMAGE_URL,
)

print("\n📦 Gemini 原始回傳：")
print(json.dumps(result, ensure_ascii=False, indent=2))

# ── 3. 模擬 upsert_event dry-run ─────────────────────────────
from db_utils import upsert_event
from supabase import create_client
supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
supabase = create_client(supabase_url, supabase_key)
google_maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()

print("\n📋 Dry-run upsert 結果：")
if result:
    for ev in result:
        if not ev.get("is_event"):
            print("  🚫 AI 判定為非活動，跳過")
            continue
        r = upsert_event(
            llm_data=ev,
            system_fields={
                "source_url":  TARGET_URL,
                "source_name": "台東藝文平台",
                "image_url":   IMAGE_URL,
            },
            supabase=supabase,
            google_maps_key=google_maps_key,
            dry_run=True,
        )
        print(f"  → {r}")
else:
    print("  AI 回傳為空")

print("\n✅ 測試完成")
