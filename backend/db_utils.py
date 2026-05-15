"""
db_utils.py — CulturRoute 統一資料庫寫入模組 (Phase 1 重構產物)

職責：接收 Gemini 新版 Schema 輸出的 JSON + 爬蟲補充的系統欄位，
      合併後執行 Supabase events 表的 upsert 操作。

入口函數：upsert_event(llm_data, system_fields, supabase, ...)
  llm_data:     Gemini 吐出的單一活動 JSON（對應新版 Gemini Schema）
  system_fields: {"source_url", "source_name", "image_url"}（由爬蟲補充）
  Returns:      "inserted" | "updated" | "skipped" | "error"

event_id 公式（新版）：SHA256(source_url + "::" + title + "::" + start_time)
"""

import hashlib
import re

import requests
from supabase import Client

from venue_whitelist import lookup_venue_coords

# ── indoor_or_outdoor 正規化對照（中文 → 英文，向後相容舊值）────────────────
_INDOOR_MAP: dict[str, str] = {
    "室內":         "indoor",
    "室外":         "outdoor",
    "半室外":       "semi-outdoor",
    "indoor":       "indoor",
    "outdoor":      "outdoor",
    "semi-outdoor": "semi-outdoor",
}

_TAITUNG_KW = ("台東", "臺東")
_ISO_RE      = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")

# ── 場館硬規則：特定類型場館強制附加休館日 ──────────────────────────────────────
_VENUE_CLOSING_RULES: dict[str, str] = {
    "藝文中心": "每週一休館",
    "美術館":   "每週一休館",
    "圖書館":   "每週一及月底休館",
}

def apply_venue_hard_rules(venue_name: str, opening_hours: str | None) -> str | None:
    """針對藝文中心/美術館/圖書館等場館強制附加休館日規則，不依賴 AI 判斷。"""
    if not venue_name:
        return opening_hours
    closing_note = next(
        (rule for kw, rule in _VENUE_CLOSING_RULES.items() if kw in venue_name),
        None,
    )
    if not closing_note:
        return opening_hours
    if not opening_hours:
        return closing_note
    return opening_hours if closing_note in opening_hours else f"{opening_hours}；{closing_note}"


# ── 工具函數 ──────────────────────────────────────────────────────────────────

def sanitize_timestamp(val) -> str | None:
    """只接受 YYYY-MM-DDTHH:MM 開頭的 ISO 8601；其餘回傳 None。"""
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "未提供", ""):
        return None
    return s if _ISO_RE.match(s) else None


def generate_event_id(source_url: str, title: str, start_time: str = "") -> str:
    """確定性主鍵：SHA256(source_url + '::' + title + '::' + start_time)。
    start_time 確保同一來源頁面拆分出的不同場次各有獨立 ID，不互相覆蓋。"""
    raw = f"{source_url.strip()}::{title.strip()}::{start_time.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def resolve_coordinates(
    venue_name: str,
    address: str | None,
    google_maps_key: str,
) -> tuple[float | str | None, float | None]:
    """
    補全場館座標。優先層級：venue_whitelist → Google Places API（含台東過濾）。
    非台東地點回傳 ("FILTERED", None)，呼叫端應丟棄此活動。
    """
    lat, lng = lookup_venue_coords(venue_name or "")
    if lat and lng:
        return lat, lng

    if not google_maps_key:
        return None, None

    query = address or venue_name or ""
    if not query:
        return None, None
    if not any(k in query for k in _TAITUNG_KW):
        query = f"台東 {query}"

    try:
        resp = requests.post(
            "https://places.googleapis.com/v1/places:searchText",
            json={"textQuery": query, "languageCode": "zh-TW", "maxResultCount": 1},
            headers={
                "Content-Type":     "application/json",
                "X-Goog-Api-Key":   google_maps_key,
                "X-Goog-FieldMask": "places.location,places.formattedAddress",
            },
            timeout=10,
        )
        resp.raise_for_status()
        places = resp.json().get("places", [])
        if places:
            loc  = places[0].get("location", {})
            addr = places[0].get("formattedAddress", "")
            if addr and not any(k in addr for k in _TAITUNG_KW):
                print(f"  [COORD] 非台東地點，已過濾：{addr}")
                return "FILTERED", None
            return loc.get("latitude"), loc.get("longitude")
    except Exception as e:
        print(f"  [COORD] Google Places 查詢失敗：{e}")

    return None, None


# ── 主入口 ────────────────────────────────────────────────────────────────────

def upsert_event(
    llm_data: dict,
    system_fields: dict,
    supabase: Client,
    *,
    google_maps_key: str = "",
    embedding: list | None = None,
    dry_run: bool = False,
) -> str:
    """
    合併 Gemini 新版 Schema 輸出與爬蟲系統欄位，upsert 至 Supabase events 表。

    Args:
        llm_data:        Gemini 輸出的單一活動 JSON（新版 Schema）
        system_fields:   {
                           "source_url":  str,   # 活動原始網址（必填）
                           "source_name": str,   # 爬蟲來源名稱
                           "image_url":   str,   # 海報圖片 URL
                         }
        supabase:        已初始化的 Supabase Client
        google_maps_key: 座標補全用；無需查詢時傳空字串
        embedding:       Gemini Embedding 向量；None 時寫入 SQL NULL
        dry_run:         True 時不寫 DB，只印出 log

    Returns:
        "inserted" | "updated" | "skipped" | "error"
    """
    source_url  = (system_fields.get("source_url")  or "").strip()
    source_name = (system_fields.get("source_name") or "").strip()
    image_url   = (system_fields.get("image_url")   or "").strip()

    # ── 基本欄位驗證 ─────────────────────────────────────────────────────────
    title = (llm_data.get("title") or "").strip()
    if not title:
        print("  [SKIP] title 為空，略過")
        return "skipped"

    start_time = sanitize_timestamp(llm_data.get("start_time"))
    end_time   = sanitize_timestamp(llm_data.get("end_time"))

    if not start_time:
        print(f"  [SKIP] 無有效 start_time：{title}")
        return "skipped"

    # ── event_id（新版公式）──────────────────────────────────────────────────
    event_id = generate_event_id(source_url, title, start_time or "") if source_url else None

    # ── 座標補全 ─────────────────────────────────────────────────────────────
    lat = llm_data.get("latitude")
    lng = llm_data.get("longitude")
    if not lat or not lng:
        lat, lng = resolve_coordinates(
            llm_data.get("venue_name") or "",
            llm_data.get("address"),
            google_maps_key,
        )
    if lat == "FILTERED":
        print(f"  [SKIP] 場地不在台東，已過濾：{title}")
        return "skipped"

    # ── indoor_or_outdoor 正規化 ─────────────────────────────────────────────
    raw_io = (llm_data.get("indoor_or_outdoor") or "").strip()
    # 若值不在白名單內（如 AI 輸出「室內 | 室外」），改為 semi-outdoor
    indoor_or_outdoor = _INDOOR_MAP.get(raw_io) or (
        "semi-outdoor" if ("室內" in raw_io and "室外" in raw_io) else None
    )

    # ── 組合 payload ──────────────────────────────────────────────────────────
    # 欄位順序：Gemini Schema → 系統欄位 → 常數
    payload: dict = {
        # Gemini Schema 欄位（對應 Supabase 欄位名稱）
        "title":             title,
        "category":          (llm_data.get("category") or "").strip() or None,
        "sub_category":      llm_data.get("sub_category") or [],
        "time_type":         llm_data.get("time_type"),
        "start_time":        start_time,
        "end_time":          end_time,
        "end_date":          llm_data.get("end_date") or (end_time[:10] if end_time else None),
        "opening_hours":     apply_venue_hard_rules(
            (llm_data.get("venue_name") or "").strip(),
            llm_data.get("opening_hours"),
        ),
        "venue_name":        (llm_data.get("venue_name") or "").strip() or "未提供",
        "address":           llm_data.get("address"),
        "region":            llm_data.get("region"),
        "is_free":           bool(llm_data.get("is_free", True)),
        "ticket_url":        llm_data.get("ticket_url") or None,
        "indoor_or_outdoor": indoor_or_outdoor,
        "description":       (llm_data.get("description") or "").strip(),
        "long_description":  (llm_data.get("long_description") or "").strip(),
        # 爬蟲補充的系統欄位
        "event_id":          event_id,
        "source_url":        source_url or None,
        "image_captured":    image_url or "",
        "latitude":          lat,
        "longitude":         lng,
        "embedding":         embedding,
        # 常數欄位（跨平台統一）
        "engagement_metrics": {"score": 0},
        "affiliate_links": {
            "rental":        {"label": "租車/租機車", "url": None},
            "ticket":        {"label": "售票連結",   "url": None},
            "accommodation": {"label": "周邊住宿",   "url": None},
        },
    }

    # ── 圖書館強制地區覆寫（避免 AI 誤將館內展區名稱誤判為縱谷山線等地理區域）────────
    if "圖書館" in payload.get("venue_name", ""):
        payload["region"] = "市區"

    if dry_run:
        eid_preview = (event_id or "?")[:8]
        end_label   = f" ~ {payload['end_date']}" if payload["end_date"] else ""
        print(f"  [DRY] {eid_preview}… {title} ({start_time[:10]}{end_label})")
        return "inserted"

    # ── Upsert（event_id 衝突 → UPDATE；否則 INSERT）─────────────────────────
    try:
        if event_id:
            existing  = supabase.table("events").select("id").eq("event_id", event_id).execute()
            is_update = bool(existing.data)
            supabase.table("events").upsert(payload, on_conflict="event_id").execute()
        else:
            is_update = False
            supabase.table("events").insert(payload).execute()

        label     = start_time[:10]
        end_label = f" ~ {payload['end_date']}" if payload["end_date"] and payload["end_date"] != label else ""
        tag       = "UPDATE" if is_update else "NEW"
        print(f"  [{tag}] {title} ({label}{end_label})")
        return "updated" if is_update else "inserted"

    except Exception as e:
        print(f"  [ERR] upsert 失敗 [{title}]: {e}")
        return "error"


# ── 舊版 Schema 相容層 ────────────────────────────────────────────────────────

def _fix_timezone(ts: str | None) -> str | None:
    """若 ISO 時間字串缺少時區後綴，強制補上 +08:00。"""
    if not ts:
        return ts
    s = str(ts).strip()
    if len(s) >= 19:
        suffix = s[19:]
        if not (suffix.startswith("+") or suffix.startswith("-") or s.endswith("Z")):
            return s + "+08:00"
    return s


def map_legacy_fields(old: dict) -> dict:
    """
    將舊版 Gemini 輸出格式（event_name, iso_start_time, card_summary 等）
    對映至新版 Gemini Schema（title, start_time, description 等）。

    供 scraper.py / ttcsec_scraper.py / taitung_tourism_scraper.py 使用。
    vibe_tags 以 best-effort 對映至 sub_category。
    """
    return {
        "title":             old.get("event_name", ""),
        "start_time":        _fix_timezone(old.get("iso_start_time")),
        "end_time":          _fix_timezone(old.get("iso_end_time")),
        "end_date":          old.get("end_date"),
        "description":       old.get("card_summary", ""),
        "long_description":  old.get("long_description", ""),
        "venue_name":        old.get("location") or old.get("venue_name"),
        "is_free":           old.get("is_free", True),
        "ticket_url":        old.get("ticket_url"),
        "indoor_or_outdoor": old.get("indoor_or_outdoor"),
        "sub_category":      old.get("vibe_tags", []),
        "latitude":          old.get("latitude"),
        "longitude":         old.get("longitude"),
        # 新欄位：舊 Schema 無對應，暫填 None
        "category":          None,
        "time_type":         None,
        "opening_hours":     None,
        "region":            None,
        "address":           None,
    }
