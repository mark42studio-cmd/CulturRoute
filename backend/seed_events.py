"""
seed_events.py
─────────────────────────────────────────────────────────────────
資料大重啟：清空 events 表，並植入 2026 年台東黃金測試資料集。

執行方式：
  python seed_events.py           # 預覽模式（只印出 payload，不寫入）
  python seed_events.py --apply   # 實際清空並寫入 Supabase
"""

import os
import sys
import argparse
from datetime import datetime, timezone
from dotenv import load_dotenv, find_dotenv
from supabase import create_client, Client

load_dotenv(find_dotenv(), encoding="utf-8-sig")

supabase: Client = create_client(
    os.getenv("SUPABASE_URL").strip(),
    os.getenv("SUPABASE_SERVICE_KEY").strip(),
)

# ── 5 筆黃金測試資料 ──────────────────────────────────────────────────────────

SEED_EVENTS = [
    # ① 展覽：跨月展，測試「end_date 區間過濾」
    {
        "title":       "太平洋的風：原民木雕展",
        "description": "來自台東海岸山脈的阿美族、卑南族木雕藝術家聯展，呈現部落美學與當代對話。",
        "long_description": (
            "展覽匯集 12 位東海岸原住民藝術家作品，以木雕為媒介，探討族群記憶、海洋生態與當代身分認同。"
            "展場由廢棄糖廠舊空間改建，保留原始磚牆結構，創造出獨特的展覽氛圍。\n\n"
            "開幕活動將有傳統歌謠演唱與工藝示範，歡迎攜家帶眷共同參與。"
        ),
        "start_time":  "2026-04-01T09:00:00+08:00",
        "end_time":    "2026-05-31T17:00:00+08:00",
        "end_date":    "2026-05-31",
        "venue_name":  "都蘭文創園區",
        "address":     "台東縣東河鄉都蘭村 44 號",
        "latitude":    22.9027,
        "longitude":   121.2398,
        "is_free":     True,
        "opening_hours": "09:00–17:00",
        "closing_days":  ["週二"],
        "vibe_tags":   ["#原住民文化", "#木雕藝術", "#東海岸", "#展覽"],
        "target_audience": ["文青", "親子", "獨旅", "銀髮"],
        "weather_resilience": 5,
        "ticket_url":  None,
        "source_url":  "https://www.eastcoast-nsa.gov.tw/",
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": "https://www.klook.com/zh-TW/search/?query=台東+租機車"},
            "ticket":        {"label": "售票連結",   "url": None},
            "accommodation": {"label": "周邊住宿",   "url": "https://www.agoda.com/zh-tw/search?city=17523&checkIn=2026-04-01"},
        },
    },

    # ② 音樂祭：單日晚間，測試「單點活動」
    {
        "title":       "縱谷響起：池上大坡池音樂祭",
        "description": "稻田為舞台、星空為天幕，金曲獎樂團齊聚池上，在大坡池畔演繹縱谷之聲。",
        "long_description": (
            "台東池上大坡池自然生態公園，提供了全台最純粹的戶外音樂場景。"
            "本屆音樂祭邀請三組金曲獎樂團壓軸，並安排在地原住民歌手暖場。\n\n"
            "現場提供有機農產品市集、在地農家料理，演出時間為晚上 7 點至 10 點。"
            "強烈建議攜帶防寒外套，縱谷夜晚日夜溫差達 10°C 以上。"
        ),
        "start_time":  "2026-04-18T19:00:00+08:00",
        "end_time":    "2026-04-18T22:00:00+08:00",
        "end_date":    None,
        "venue_name":  "大坡池生態公園",
        "address":     "台東縣池上鄉大坡路 10 號",
        "latitude":    23.1024,
        "longitude":   121.2305,
        "is_free":     False,
        "opening_hours": "19:00–22:00",
        "closing_days":  [],
        "vibe_tags":   ["#音樂祭", "#池上", "#縱谷", "#星空", "#戶外"],
        "target_audience": ["情侶", "文青", "獨旅"],
        "weather_resilience": 2,
        "ticket_url":  "https://tixcraft.com/search?q=池上音樂祭",
        "source_url":  "https://www.taitung.gov.tw/",
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": "https://www.klook.com/zh-TW/search/?query=池上+租腳踏車"},
            "ticket":        {"label": "售票連結",   "url": "https://tixcraft.com/search?q=池上音樂祭"},
            "accommodation": {"label": "周邊住宿",   "url": "https://www.agoda.com/zh-tw/search?city=17523&checkIn=2026-04-18"},
        },
    },

    # ③ 市集：雙日活動，今天 (4/12) 正好在其中！
    {
        "title":       "台東慢食節",
        "description": "匯聚台東百家小農與在地職人，用一頓慢食重新認識台東土地的滋味。",
        "long_description": (
            "台東慢食節由台東縣政府農業處主辦，每年四月於台東森林公園盛大舉行。"
            "本屆邀請超過 80 個攤位，涵蓋原住民傳統食材、自然農法蔬果、在地精釀啤酒，"
            "以及手作醬料工作坊。\n\n"
            "4 月 12 日（六）上午 10 點開幕，設有親子 DIY 區域；4 月 13 日（日）有廚藝示範壓軸。"
            "兩日均免費入場，週邊停車場另收費。"
        ),
        "start_time":  "2026-04-12T10:00:00+08:00",
        "end_time":    "2026-04-13T18:00:00+08:00",
        "end_date":    "2026-04-13",
        "venue_name":  "台東森林公園",
        "address":     "台東縣台東市大同路 200 號",
        "latitude":    22.7556,
        "longitude":   121.1526,
        "is_free":     True,
        "opening_hours": "10:00–18:00",
        "closing_days":  [],
        "vibe_tags":   ["#慢食", "#市集", "#小農", "#親子", "#台東森林公園"],
        "target_audience": ["親子", "情侶", "銀髮", "獨旅"],
        "weather_resilience": 2,
        "ticket_url":  None,
        "source_url":  "https://www.taitung.gov.tw/",
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": "https://www.klook.com/zh-TW/search/?query=台東+租機車"},
            "ticket":        {"label": "售票連結",   "url": None},
            "accommodation": {"label": "周邊住宿",   "url": "https://www.agoda.com/zh-tw/search?city=17523&checkIn=2026-04-12"},
        },
    },

    # ④ 常設展：全年開放，測試「超長跨度區間」
    {
        "title":       "麻煩了，台東！常設展",
        "description": "以荒誕幽默重新詮釋台東百年歷史，帶你穿越時空遇見不同世代的台東人。",
        "long_description": (
            "台東設計中心推出的沉浸式常設展，以「如果台東人穿越時空」為主軸，"
            "透過互動裝置、影像敘事與實物展示，呈現台東從日治時代至今的生活樣貌。\n\n"
            "展覽特別收錄地方耆老訪談影片、老照片數位化展示，以及可親手觸摸的農耕器具。"
            "門票包含一杯在地咖啡，全年開放除農曆除夕前後三日外。"
        ),
        "start_time":  "2026-01-01T09:00:00+08:00",
        "end_time":    "2026-12-31T17:00:00+08:00",
        "end_date":    "2026-12-31",
        "venue_name":  "台東設計中心",
        "address":     "台東縣台東市中興路二段 191 號",
        "latitude":    22.7614,
        "longitude":   121.1428,
        "is_free":     False,
        "opening_hours": "09:00–17:00",
        "closing_days":  ["週一"],
        "vibe_tags":   ["#常設展", "#台東歷史", "#沉浸式", "#設計", "#互動裝置"],
        "target_audience": ["文青", "親子", "銀髮", "獨旅", "情侶"],
        "weather_resilience": 5,
        "ticket_url":  "https://www.kkday.com/zh-tw/search?q=台東設計中心",
        "source_url":  "https://www.taitung.gov.tw/",
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": "https://www.klook.com/zh-TW/search/?query=台東+租機車"},
            "ticket":        {"label": "售票連結",   "url": "https://www.kkday.com/zh-tw/search?q=台東設計中心"},
            "accommodation": {"label": "周邊住宿",   "url": "https://www.agoda.com/zh-tw/search?city=17523"},
        },
    },

    # ⑤ 週末市集：未來活動，測試「如果你願意多留幾天」區塊
    {
        "title":       "鐵花村週末音樂市集",
        "description": "台東最具代表性的音樂聚落，每週末邀請在地樂手駐唱，同步舉辦手作市集。",
        "long_description": (
            "鐵花村音樂聚落是台東夜晚最有靈魂的所在。"
            "每逢週六、日，來自全台的獨立樂團與在地原住民歌手在此同台，"
            "配合手作飾品、天然染布、有機農產等攤位，形成台東獨有的慢生活氛圍。\n\n"
            "本次 4/25 邀請知名阿美族創作歌手壓軸演出，入場免費，自由入座。"
        ),
        "start_time":  "2026-04-25T18:00:00+08:00",
        "end_time":    "2026-04-26T22:00:00+08:00",
        "end_date":    "2026-04-26",
        "venue_name":  "鐵花村音樂聚落",
        "address":     "台東縣台東市新生路 135 號",
        "latitude":    22.7575,
        "longitude":   121.1514,
        "is_free":     True,
        "opening_hours": "18:00–22:00",
        "closing_days":  ["週一", "週二", "週三", "週四", "週五"],
        "vibe_tags":   ["#音樂", "#市集", "#鐵花村", "#週末", "#原住民音樂"],
        "target_audience": ["情侶", "文青", "獨旅"],
        "weather_resilience": 2,
        "ticket_url":  None,
        "source_url":  "https://www.tiehua.com.tw/",
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": "https://www.klook.com/zh-TW/search/?query=台東+租機車"},
            "ticket":        {"label": "售票連結",   "url": None},
            "accommodation": {"label": "周邊住宿",   "url": "https://www.agoda.com/zh-tw/search?city=17523&checkIn=2026-04-25"},
        },
    },
]


def preview():
    print("📋 預覽模式 — 以下資料將被寫入（加 --apply 才執行）\n")
    for i, ev in enumerate(SEED_EVENTS, 1):
        aff = ev.get("affiliate_links", {})
        rental_url        = (aff.get("rental")        or {}).get("url", "null")
        ticket_url_aff    = (aff.get("ticket")        or {}).get("url", "null")
        accommodation_url = (aff.get("accommodation") or {}).get("url", "null")
        print(f"  [{i}] {ev['title']}")
        print(f"       📅 {ev['start_time'][:10]} → {ev.get('end_date') or ev['start_time'][:10]}")
        print(f"       📍 {ev['venue_name']} ({ev['latitude']}, {ev['longitude']})")
        print(f"       🔗 rental={rental_url[:40] if rental_url != 'null' else 'null'}")
        print(f"       🔗 ticket={ticket_url_aff[:40] if ticket_url_aff != 'null' else 'null'}")
        print(f"       🔗 accommodation={accommodation_url[:40] if accommodation_url != 'null' else 'null'}")
        print()


# 所有「非核心」欄位：若 DB 尚未 migration 就自動跳過
ALL_OPTIONAL = {
    "long_description", "end_time", "end_date",
    "address", "opening_hours", "closing_days",
    "ticket_url", "source_url", "image_captured", "affiliate_links",
}

# 核心欄位（events 表建立時就存在）
CORE_COLUMNS = {"title", "description", "start_time", "venue_name",
                "latitude", "longitude", "is_free",
                "vibe_tags", "target_audience", "weather_resilience"}


def probe_columns() -> set:
    """動態偵測哪些選用欄位已在 DB schema，回傳可安全寫入的欄位集合。"""
    available = set(CORE_COLUMNS)
    for col in ALL_OPTIONAL:
        try:
            supabase.table("events").select(col).limit(1).execute()
            available.add(col)
        except Exception:
            pass
    return available


def build_payload(ev: dict, available_cols: set) -> dict:
    """只保留 DB 實際存在的欄位，避免 PGRST204。"""
    return {k: v for k, v in ev.items() if k in available_cols}


def run_seed():
    # ── Step 1: 清空 events ──────────────────────────────────────────────────
    print("🗑️  清空 events 表...")
    try:
        resp = supabase.table("events").delete().gte("created_at", "2000-01-01T00:00:00+00:00").execute()
        deleted = len(resp.data) if resp.data else "?"
        print(f"   已刪除 {deleted} 筆舊資料 ✓")
    except Exception as e:
        print(f"   ⚠️  清空失敗（可能 events 表尚無資料）：{e}")

    # ── 偵測可用欄位 ──────────────────────────────────────────────────────────
    available_cols = probe_columns()
    missing = ALL_OPTIONAL - (available_cols - CORE_COLUMNS)
    if missing:
        print(f"\n   ⚠️  以下欄位尚未遷移，將跳過：{missing}")
        print("      請在 Supabase SQL Editor 執行 backend/migration_add_event_columns.sql")
        print("      執行後重跑 seed_events.py --apply 即可補入完整欄位\n")
    else:
        print("   所有新欄位已就緒 ✓\n")

    # ── Step 2: 插入新資料 ───────────────────────────────────────────────────
    print(f"📥 插入 {len(SEED_EVENTS)} 筆測試資料...")
    for i, ev in enumerate(SEED_EVENTS, 1):
        try:
            payload = build_payload(ev, available_cols)
            supabase.table("events").insert(payload).execute()
            print(f"   [{i}] ✅ {ev['title']}")
        except Exception as e:
            print(f"   [{i}] ❌ {ev['title']} — {e}")

    print("\n✨ 完成！請執行 npm run dev 並在前端驗收。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="清空 events 表並植入黃金測試資料")
    parser.add_argument("--apply", action="store_true", help="實際寫入（預設只預覽）")
    args = parser.parse_args()

    if args.apply:
        print("⚠️  即將清空 events 表並植入測試資料...\n")
        run_seed()
    else:
        preview()
