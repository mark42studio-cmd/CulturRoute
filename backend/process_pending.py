"""
process_pending.py
─────────────────
第二階段 AI 清洗：單獨處理 raw_threads_posts 中 raw_status='pending' 的貼文。
不重新爬蟲，只讀 DB → 送 AI → 更新狀態 / 寫入 events。

執行方式：
  python process_pending.py            # 處理全部 pending（正式使用）
  python process_pending.py --limit 5  # 只取前 5 筆（測試用）

欄位對應（raw_threads_posts → events）：
  raw_text      → Gemini 輸入
  source_url    → events.source_url
  permalink     → 同上（source_url 優先用 permalink）
  keyword       → 僅用於日誌，不寫入 events
  id            → 用於 update_raw_status
"""

import os
import sys
import time
import json
import random
import argparse
import requests
from difflib import SequenceMatcher
from datetime import datetime, timezone
from dotenv import load_dotenv, find_dotenv
from google import genai
from supabase import create_client, Client

from venue_whitelist import get_source_auto_tags
from township_scraper import is_valid_image_url
from scraper import generate_embedding, check_semantic_duplicate, get_coordinates

load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

supabase_url   = os.getenv("SUPABASE_URL").strip()
supabase_key   = os.getenv("SUPABASE_SERVICE_KEY").strip()
gemini_key     = os.getenv("GEMINI_API_KEY").strip()
google_maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()

gemini   = genai.Client(api_key=gemini_key)
supabase: Client = create_client(supabase_url, supabase_key)


# ── 讀取 pending 貼文 ──────────────────────────────────────────────────────────

def fetch_pending(limit: int | None = None):
    """
    從 raw_threads_posts 撈出 raw_status='pending' 的記錄。
    limit=None 表示全部；limit=N 只取前 N 筆（測試用）。
    回傳欄位：id, keyword, permalink, source_url, raw_text, source_type
    """
    base_select = "id, keyword, permalink, source_url, raw_text, source_type"
    try:
        query = (
            supabase.table("raw_threads_posts")
            .select(base_select)
            .eq("raw_status", "pending")
            .order("id")
        )
        if limit:
            query = query.limit(limit)
        result = query.execute()
        return result.data or []
    except Exception:
        # source_type 欄位尚未建立時的向下相容
        query = (
            supabase.table("raw_threads_posts")
            .select("id, keyword, permalink, source_url, raw_text")
            .eq("raw_status", "pending")
            .order("id")
        )
        if limit:
            query = query.limit(limit)
        result = query.execute()
        return result.data or []


def _detect_source_type(row: dict) -> str:
    """
    從 raw 記錄推斷來源類型：
      - 若 DB 有 source_type 欄位，直接使用
      - 否則從 keyword / source_url 推斷
    """
    if row.get("source_type"):
        return row["source_type"]
    url = (row.get("source_url") or row.get("permalink") or "").lower()
    keyword = (row.get("keyword") or "").lower()
    indie_hints = ["晃晃", "就藝會", "ark", "方舟", "都蘭糖廠", "穀倉", "月光小棧",
                   "好的擺", "江賢二", "池上穀倉"]
    township_hints = ["公所", "taitung.gov.tw", "beinan.gov.tw", "chishang.gov.tw",
                      "donghe.gov.tw", "chenggong.gov.tw"]
    for h in indie_hints:
        if h in url or h in keyword:
            return "indie_curation"
    for h in township_hints:
        if h in url or h in keyword:
            return "township"
    return "threads"  # 預設：Threads 社群貼文


# ── 更新 raw_status ────────────────────────────────────────────────────────────

def update_raw_status(row_id: int, status: str):
    try:
        supabase.table("raw_threads_posts").update({
            "raw_status":   status,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", row_id).execute()
    except Exception as e:
        print(f"  ⚠️ 更新 raw_status 失敗 (id={row_id}): {e}")


# ── 公文公告前置過濾器（在送 Gemini 前直接排除，節省 API quota）────────────────

# 標題出現即強制排除（與藝文活動幾乎不重疊）
_HARD_EXCLUDE_KEYWORDS = [
    "招標", "決標", "流標", "廢標",
    "作業要點", "作業辦法", "辦理要點",
    "節能改善", "節能補助",
    "公文", "函", "核定", "核准",
    "服務採購", "財物採購", "工程採購",
    "社福補助", "弱勢家庭", "低收入", "中低收入",
    "勞保", "健保", "長照補助",
]

# 需「組合出現」才排除（單一出現可能是合法活動描述）
_COMBO_EXCLUDE_PAIRS: list[tuple[str, str]] = [
    ("補助", "申請"),      # 補助申請公告
    ("補助", "計畫"),      # 補助計畫
    ("補助", "核定"),      # 補助核定
    ("申請", "作業"),      # 申請作業
    ("計畫", "申請期間"),  # 計畫申請期間
]

# 即使命中排除詞，含有這些詞仍放行（真正的藝文活動）
_ALLOWLIST_KEYWORDS = [
    "音樂會", "展覽", "藝術節", "演出", "表演", "講座", "工作坊",
    "市集", "祭典", "慶典", "開幕", "閉幕", "競賽", "演唱會",
    "放映", "影展", "書展", "攝影", "說故事", "導覽",
]


def _is_govt_doc(text: str) -> bool:
    """
    前置過濾：判斷是否為政府公文/補助公告，而非觀光藝文活動。
    回傳 True 代表「確定是公文，直接排除」。
    """
    # 若含有允許清單關鍵字，優先放行
    for kw in _ALLOWLIST_KEYWORDS:
        if kw in text:
            return False

    # 單一強制排除詞命中即過濾
    for kw in _HARD_EXCLUDE_KEYWORDS:
        if kw in text:
            return True

    # 組合命中過濾
    for kw_a, kw_b in _COMBO_EXCLUDE_PAIRS:
        if kw_a in text and kw_b in text:
            return True

    return False


# ── Gemini AI 清洗 ─────────────────────────────────────────────────────────────

def ai_data_cleaner(raw_text: str, source_type: str = "threads"):
    """
    送 Gemini 判斷是否為台東藝文活動。
    source_type: "threads" | "indie_curation" | "township"
    回傳 dict（含 is_event 欄位），或 None（AI 呼叫失敗）。
    """
    source_context = {
        "threads":        "Threads 社群貼文",
        "indie_curation": "台東在地獨立藝文空間（晃晃書店、就藝會、the ARK、都蘭聚落等）",
        "township":       "台東鄉鎮公所官網最新消息",
    }.get(source_type, "未知來源")

    location_hint = ""
    if source_type == "indie_curation":
        location_hint = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【在地空間地點規則】：
- 若貼文來源明確是「晃晃書店」，location 直接填「晃晃書店」，不需再找地址。
- 若來源是「就藝會」，location 填「就藝會」。
- 若來源是「the ARK / 方舟」，location 填「the ARK 方舟」。
- 若來源是「都蘭糖廠 / 月光小棧 / 好的擺」，location 填對應場館全名。
- 座標由系統查白名單，latitude / longitude 填 null 即可。
"""
    elif source_type in ("township", "official"):
        location_hint = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【⚠️ 重要：發布單位 ≠ 活動地點】：
公所與官方機構的公告，常常是「轉知」其他單位辦的活動。
絕對嚴禁將「發布公所」或「發布機構」直接當成活動舉辦地點。

【地點智慧判別（按優先順序執行）】：
1. 內文有「活動地點：」「舉辦地點：」「集合地點：」「地點：」→ 直接取冒號後的文字
2. 內文有「在○○廣場」「○○公園舉辦」「○○部落○○」→ 取該處地名
3. 活動名稱含地名（如「卑南族豐年祭」→「卑南部落廣場」）→ 依族群推斷舉辦場所
4. 官方機構活動（博物館、美學館）且未提其他地點 → 填機構本身名稱
5. 以上都找不到 → 回傳 {{"is_event": false}}，不可填公所名稱

【⭐ 精準地址擷取強化（關鍵，影響地圖精準度）】：
- venue_name 填「場館/空間的正式名稱」，應包含所屬鄉鎮（例：「金峰鄉嘉蘭部落廣場」而非「嘉蘭廣場」）。
- address 填「完整中文地址」，凡內文出現路名（○○路、○○街、○○巷）、
  鄰里（○○鄰）、地段（○○段）一律放入 address 欄位，不可省略。
  範例：
    ✅ venue_name: "金峰鄉嘉蘭村活動廣場"  address: "台東縣金峰鄉嘉蘭村150號"
    ✅ venue_name: "鹿野鄉高台飛行傘場"    address: "台東縣鹿野鄉永安村高台路"
    ❌ venue_name: "嘉蘭廣場"             address: null   （← 缺鄉鎮，無法精準定位）
- 若完全找不到路名/地段，至少確保 venue_name 含有「縣市＋鄉鎮」層級的行政地名。

【座標】：latitude / longitude 填 null，由系統查白名單或 Google Places。
"""

    prompt = f"""
你是台灣在地文化策展人兼資料工程師。請閱讀以下內容，判斷是否為「具體的台東藝文活動」。

【來源類型】：{source_context}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 主理人嚴選規則 0（優先於一切）：事後報導 & 活動回顧過濾器
以下任何情況都代表活動已經結束，一律回傳 [{{"is_event": false}}]，不要嘗試解析時間：

① 貼文含有「圓滿落幕」「圓滿結束」「感謝參與」「感謝蒞臨」「感謝所有」
   「花絮回顧」「精彩回顧」「活動花絮」「謝謝大家」等詞，且以過去式描述活動。

② 貼文是「事後新聞稿／報導」形式：
   - 「○○ 於今日上午舉行」「○○ 已於昨日完成」「○○ 今天正式揭牌」
   - 「本活動於 ○月○日 順利舉辦」「活動現場照片如下」
   - 貼文發布時間明顯晚於活動時間（例如：活動是上午，貼文是當天下午/晚上回顧）
   - 整篇以「完成式」陳述，沒有任何邀請民眾前往的語氣

（例外：若同一貼文同時宣傳下一場即將到來的活動，可保留下一場的資訊）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 主理人嚴選規則 0.5：標題精煉規則（Critical，優先執行）
社群貼文標題往往過長或附有行政前綴。在填寫 event_name 欄位時，請強制執行：
① 移除行政前綴符號：【報名開始】【最新消息】【活動資訊】【公告】📢 等
② 移除贅述結尾：「- 歡迎踴躍參與！」「，敬請期待」等呼籲文字
③ 刪除冠頭的主辦單位全名：「財團法人○○基金會」「中華民國台東縣○○協會」「台東縣政府文化處」等
④ 刪除括號內的附註說明：「（自由入場）」「（線上報名）」「（免費參加）」等
⑤ 保留最核心的「活動 / 展覽主名稱」，若有子標題以「－」連接
範例：「【報名開始】2026 南島市集 - 這裡那裡歡迎大家踴躍參與！」→「2026 南島市集」
範例：「📢 台東美術館｜5月份藝術工作坊 招生中～」→「台東美術館 5月藝術工作坊」
範例：「台東縣政府文化處主辦 第十屆山海有聲音樂節（免費入場）」→「山海有聲音樂節」

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 主理人嚴選規則 1：地理過濾器（Taitung-Only）★★★ 最高優先級 ★★★
本平台為「台灣台東縣（Taitung）」的專屬在地藝文平台。
地理過濾是最高優先規則，優先於任何其他判斷。

① 若貼文描述的活動地點明顯位於台東縣以外的縣市
   （例：台北、新北、桃園、台中、台南、高雄、花蓮、宜蘭、嘉義、南投……等任何非台東縣市）
   → 不論活動多精彩，一律直接回傳 [{{"is_event": false}}]，沒有例外。

② 若活動地點模糊，但明顯非台東（例：「天來美術館」、「台北信義區」、「中正紀念堂」）
   → 一律回傳 [{{"is_event": false}}]

③ 全國性或跨縣市系列活動（例：全國巡迴講座、各縣市家政活動）
   → 只保留「台東縣」場次，其他縣市場次一律忽略不輸出。
   → 若整個活動都在台東以外 → 回傳 [{{"is_event": false}}]

④ 若無法從貼文內容確認活動位於台東縣 → 回傳 [{{"is_event": false}}]

【判斷標準】：活動地點必須明確在台東縣境內，才能 is_event: true。

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

★ 主理人嚴選規則 2.5：社群廣告 Footer 防呆（Anti-Footer Rule）
社群貼文常在文末附上長期檔期廣告（例：文末附帶「鐵花村每週六 19:00」或「熱氣球嘉年華 7/4–8/20」等宣傳）。
請務必遵守：
① 若貼文主要宣傳「特定日期的單一主活動」，請【只】萃取該主要活動，忽略文末的長期背景廣告
② 辨識方式：文末廣告通常是沒有具體場次說明的籠統宣傳，或與主活動主題明顯無關
③ 若確認文末為背景廣告 → 不拆解、不輸出，當作它不存在
範例：主活動「5/18 光榮碼頭 XXX 演唱會」+ 文末「鐵花村每週六 19:00 有音樂」
       → 只輸出演唱會，忽略文末的鐵花村常態廣告

★ 主理人嚴選規則 3：視覺優先（Poster First）
若貼文包含圖片或附件連結，請特別留意：
① alt 屬性文字 ② 圖片檔名（如 20260512_concert.jpg → 2026年5月12日音樂會）
③ 若文字描述極少，請盡力從上下文、標籤、檔名中還原活動關鍵資訊。

★ 主理人嚴選規則 4：容錯深度判讀
若文字資料不完整，請盡力推斷並填入（推斷的資訊在 card_summary 加註「詳見海報」）。
不確定地點時，寧可填較籠統的地名（如「台東」），也不要直接回傳 is_event:false。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【⛔ 絕對排除條款（Negative Prompts）】：
下列任何一條命中，且內容無實體大眾觀光/藝文參與性質，
必須強制回傳 [{{"is_event": false}}]，沒有例外：

1. 「補助」類：補助計畫、補助申請、社福補助、節能補助、
   低收入補助、弱勢家庭補助……等政府補貼公告。
2. 「招標/採購」類：招標、決標、服務採購、財物採購、
   工程採購、廠商邀請……等政府採購公文。
3. 「行政作業」類：作業要點、辦理要點、申請期間、
   申請資格、核定公告、函轉……等行政程序公告。
4. 「節能/環保公文」類：節能改善、節能設備、碳費申報……
5. 「福利制度」類：長照補助、勞保、健保、育兒補助……
6. 「師資/人才招募」類：師資徵募、師資招募、講師招募、
   課程徵募、人才培訓招募……
   → 機構在找人，不是民眾去參加，一律 is_event: false。
7. 「學期制長期課程」類：學員招募、班級招生、學期班、
   連續 N 週課程、秋季班、春季班、常態課程……
   → 判斷關鍵：「單次體驗工作坊」可保留；
     「需報名整期的學期課程」→ is_event: false。
8. 閒聊、無具體時間地點 → [{{"is_event": false}}]
9. 招募攤商、志工招募、內部培訓 → [{{"is_event": false}}]
10. 🚫 絕對地理結界：活動地點明確標示為台北、新北、桃園、台中、台南、高雄、
    花蓮、宜蘭、嘉義、南投、國家檔案館等任何非台東縣地點
    → 立即回傳 [{{"is_event": false}}]，無論活動多精彩，零例外。

【判斷口訣】：一般民眾是否能「買票/免費入場，親身去參與一次就結束」？
「是（單次體驗）」→ 可能是活動；
「否（辦手續 / 長期報名 / 機構在招人）」→ is_event: false。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【相對時間推算規則（社群語感）】：
社群貼文常使用口語化相對時間，請以貼文標頭的 [時間: ...] 作為「今天」的基準日期推算：

| 貼文用語          | 推算邏輯                                       |
|-----------------|-----------------------------------------------|
| 明天、明日         | 基準日 + 1 天                                  |
| 後天              | 基準日 + 2 天                                  |
| 這週六、本週六      | 當週的星期六（基準日當週，若已過則為下一個）         |
| 下週六、下週日      | 下一個完整週的星期六/日                           |
| 本週末            | 當週的星期六                                    |
| 這個月底          | 當月最後一天                                    |
| 下個月初          | 下個月 1 日                                    |
| 今晚、今天         | 基準日當天                                      |

推算後填入 iso_start_time（西元 ISO 格式）。若仍無法確定 → 在 card_summary 加 ⚠️ 時間尚未確定。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【民國年 → 西元年（嚴格遵守）】：
- 115年=2026、114年=2025、113年=2024（+1911）
- 格式：YYYY-MM-DDTHH:mm:ss+08:00，禁止輸出民國年
- 禁止輸出中文時間表述（上午/下午/晚上）；一律轉為 24 小時制數字
- 只有日期沒有時間 → 預設 T09:00:00+08:00

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【結束時間自動計算】（iso_end_time 規則，優先使用原文明確時間）：
- 原文有明確結束時間 → 直接使用
- 原文無結束時間，且活動性質為「演出/表演/音樂會/演唱會/舞台劇/戲劇」→ iso_end_time = iso_start_time + 2 小時
- 原文無結束時間，其他所有單次活動 → iso_end_time = iso_start_time + 1 小時
- 長期展覽（含「即日起至」「展期」「開幕～閉幕」）→ iso_end_time = null，end_date = 最後一天

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【單次活動 vs 長期展覽】：
- 單次：end_date = null；iso_end_time 依上方自動計算規則填入
- 長期展覽：iso_end_time = null；end_date = 最後一天（YYYY-MM-DD）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【展覽結束時間：營業時間優先規則】
跨日展覽的 iso_end_time（最後一天的結束時間）依以下優先順序決定：
① 活動專屬時間（最優先）：若活動本身另外註明獨立結束時間
  （例：園區 17:00 關門，但「星空電影院」寫明 19:00-21:00）→ 以活動專屬時間為準
② 場館營業/開放時間：若內文提及場館打烊時間（如「開放時間 09:00-17:00」）
  → 以打烊時間作為 iso_end_time 基準，例如末日 "2026-06-28T17:00:00+08:00"
③ 備援（極端情況）：完全找不到場館營業時間且無活動具體時間
  → 才可使用 23:59:59+08:00 作為最後備援（禁止在有線索時直接跳到此項）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【時間模糊警告】：
- 若原文時間不明確（如「近期」「即將」「敬請期待」「時間待定」）或完全無時間資訊
  → 在 card_summary 結尾加上：⚠️ 時間尚未完全確定，請至官方網站確認詳細時程。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【地點規則】：
✅ 只填原文出現的場館或地點名稱（不聯想補充）
❌ 嚴禁看到「都蘭」就填「台東美術館」
❌ 嚴禁看到「台東」就擴充成「台東縣○○館」
若貼文完全未提地點 → 視來源判別（見下方來源規則）
{location_hint}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【opening_hours 規則】：
- 有演出時段 → 填 "HH:MM–HH:MM"；多時段用「, 」分隔
- 無時間資訊 → 填 null

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
請 strictly 回傳純 JSON Array（不含 markdown code block、不含其他文字）：
[
  {{
    "is_event": true,
    "event_name": "標題（系列活動格式：主名稱 - 子標題）",
    "iso_start_time": "YYYY-MM-DDTHH:mm:ss+08:00（西元，禁用民國年）",
    "iso_end_time": "結束時間或 null（長期展覽）",
    "end_date": "YYYY-MM-DD 或 null",
    "location": "原文場館名稱（不可聯想）",
    "address": "完整地址或 null",
    "opening_hours": "HH:MM–HH:MM 或 null",
    "latitude": null,
    "longitude": null,
    "is_free": true 或 false,
    "vibe_tags": ["⚠️ 格式嚴格規定：純文字陣列，絕對禁止包含 # 或任何 Markdown 符號。從以下選1–5個：音樂演出, 視覺藝術, 傳統工藝, 原住民文化, 在地節慶, 戶外體驗, 親子活動, 靜態展覽, 講座工作坊, 市集, 電影放映, 舞蹈, 戲劇表演, 祭典儀式, 生態旅遊, 書法文學, 藝術裝置, 官方展演, 社區活動。⚠️ 標籤規則：真正的畫展/藝術展/博物館典藏展才可標『靜態展覽』；多日節慶、嘉年華、市集、音樂節等動態活動嚴禁標『靜態展覽』。輸出範例：[\"靜態展覽\", \"視覺藝術\"]"],
    "target_audience": ["親子/情侶/獨旅/銀髮/學生 中選適合的"],
    "weather_resilience": 1到5整數,
    "card_summary": "以專業策展人視角，撰寫100–150字的精華摘要。規則：① 過濾行政套話（指導單位、主辦/承辦/協辦單位、聯絡我們、報名截止提醒等行政資訊）；② 聚焦活動亮點、藝術家/講師陣容、體驗內容；③ 語氣生動，適合讓觀眾立即想前往；④ 若時間不明確，結尾加「⚠️ 時間尚未完全確定，請至官方網站確認詳細時程。」；⑤ 推斷資訊加「詳見海報」",
    "image_url": "【圖片 URL 提取規則】從貼文的 [圖片URL] 標記或原始內容中，找出最像活動主視覺/海報的圖片網址。優先級（由高到低）：① fbcdn.net / cdninstagram.com / fbsbx.com 等 CDN 直連（最佳，可直接渲染）② 以 .jpg/.jpeg/.png/.webp/.gif 結尾的直接圖片網址 ③ 路徑含 userFiles/、/upload/、/uploads/ 的 CDN 路徑。若貼文 [圖片URL] 段落已提供 fbcdn.net URL，請直接複製使用，不要清除。若同時有多張圖片，選最像主視覺海報的（通常是最大張或第一張）。嚴禁填入含 .html/.php/.asp/?id= 的純頁面網址。完全找不到任何圖片 URL 時填 null。"
  }}
]

貼文：
{raw_text[:2500]}
"""
    for attempt in range(3):
        try:
            resp = gemini.models.generate_content(
                model="gemini-2.5-flash-lite", contents=prompt
            )
            clean = resp.text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean)
            # 統一回傳 list
            return result if isinstance(result, list) else [result]
        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print(f"  ⏳ Gemini rate limit，等 60 秒... (第 {attempt+1}/3 次)")
                time.sleep(60)
            else:
                print(f"  ⚠️ AI 解析失敗: {e}")
                return None
    return None


# ── 場館地址白名單（Geocoding 防偏移，從源頭覆寫）──────────────────────────────
# 使用 substring match：只要 venue_name 包含 key，就強制覆寫 address 欄位。
# 前端 buildGeoQuery 優先使用 address，精準地址寫進 DB 即可消除 Geocoding 跳空。
# 可隨時新增，無需修改任何邏輯。
VENUE_ADDRESS_MAP: dict[str, str] = {
    "設計中心":   "台東市鐵花路369號",
    "文化百老匯": "台東市大同路254號",
    # ↓ 預留擴充空間
}


# ── 寫入 events ────────────────────────────────────────────────────────────────

def fix_timezone_jig(ts: str | None) -> str | None:
    """
    時區防撞治具：若 ISO 時間字串結尾缺少時區資訊，強制補上 +08:00。
    已含 +/-HH:MM 偏移或 Z（UTC）者直接回傳，不重複補。
    純字串判斷，不依賴 re 模組。
    """
    if not ts:
        return ts
    s = str(ts).strip()
    if not s:
        return None
    # 擷取秒數之後的部分（位置 19 起）來判斷是否已有時區標記
    suffix = s[19:] if len(s) > 19 else ""
    if suffix.startswith("+") or suffix.startswith("-") or s.endswith("Z"):
        return s
    return s + "+08:00"


def _is_duplicate_event(
    title: str,
    iso_start_time: str | None,
    venue_name: str = "",
    lat: float | None = None,
    lon: float | None = None,
) -> bool:
    """
    寫入前去重檢查，兩道防線依序判斷：

    第一道（座標去重）：雙方都有座標 → 同日 + 座標四捨五入至小數後 3 位相同
                        （精度約 100 公尺）→ 直接視為重複。
    第二道（字面去重）：任一方缺座標 → 同日 + (venue_name 相同 OR 標題相似度 >= 0.4)。

    欄位缺失時保守回傳 False。
    """
    if not title or not iso_start_time:
        return False

    start_date = iso_start_time[:10]
    has_coords = lat is not None and lon is not None
    has_venue  = bool(venue_name and venue_name != "未提供")

    # 新進活動的座標格子（精度 0.001°≈111 公尺）
    new_lat3 = round(lat, 3) if has_coords else None
    new_lon3 = round(lon, 3) if has_coords else None

    try:
        result = (
            supabase.table("events")
            .select("id, title, venue_name, latitude, longitude")
            .gte("start_time", f"{start_date}T00:00:00+08:00")
            .lte("start_time", f"{start_date}T23:59:59+08:00")
            .execute()
        )
        for row in (result.data or []):
            existing_title  = row.get("title") or ""
            existing_venue  = row.get("venue_name") or ""
            existing_lat    = row.get("latitude")
            existing_lon    = row.get("longitude")
            ex_has_coords   = existing_lat is not None and existing_lon is not None

            # ── 第一道：座標去重 ──────────────────────────────────────────
            if has_coords and ex_has_coords:
                if (round(existing_lat, 3) == new_lat3 and
                        round(existing_lon, 3) == new_lon3):
                    print(f"\033[33m  ⏭️  重複略過（同日同座標格）"
                          f" lat={new_lat3} lon={new_lon3}\033[0m")
                    print(f"\033[33m      既有：{existing_title}\033[0m")
                    print(f"\033[33m      本次：{title}\033[0m")
                    return True
                # 雙方都有座標但格子不同 → 確定是不同地點，跳過字面備案
                continue

            # ── 第二道：字面去重（至少一方缺座標才進入）─────────────────
            if has_venue and existing_venue == venue_name:
                print(f"\033[33m  ⏭️  重複略過（同日同場館）：{venue_name}\033[0m")
                print(f"\033[33m      既有：{existing_title}\033[0m")
                print(f"\033[33m      本次：{title}\033[0m")
                return True

            ratio = SequenceMatcher(None, title, existing_title).ratio()
            if ratio >= 0.4:
                print(f"\033[33m  ⏭️  重複略過（同日標題相似 {ratio:.2f}）\033[0m")
                print(f"\033[33m      既有：{existing_title}\033[0m")
                print(f"\033[33m      本次：{title}\033[0m")
                return True

    except Exception as e:
        print(f"  ⚠️ 去重查詢失敗，保守繼續寫入: {e}")

    return False


def save_event(event_data: dict, source_url: str, source_type: str = "threads",
               raw_image_url: str = "") -> bool:
    """將 AI 整理後的活動寫入 events 表，回傳是否成功。"""
    try:
        # ── 時區防撞治具：補上缺漏的 +08:00，避免 Supabase 視為 UTC ────────
        iso_start = fix_timezone_jig(event_data.get("iso_start_time") or "") or ""
        iso_end   = fix_timezone_jig(event_data.get("iso_end_time"))

        # ── Python 層日期防線：start_time 早於今天 → 事後報導，跳過 ──────────
        if iso_start:
            try:
                event_date = datetime.fromisoformat(iso_start).date()
                today = datetime.now(timezone.utc).astimezone().date()
                if event_date < today:
                    print(f"  ⏩ 日期防線：活動日期 {event_date} 已過，略過寫入")
                    return True   # 視為已處理，不標 ai_failed
            except ValueError:
                pass  # 日期格式異常時保守繼續

        lat = event_data.get("latitude")
        lon = event_data.get("longitude")
        if not lat or not lon:
            lat, lon = get_coordinates(event_data.get("location", "未提供"))

        # 防線 B：Google Places 回傳非台東地址 → 捨棄
        if lat == "FILTERED":
            return False

        # 自動附加來源質感標籤
        # 用 `or []` / `or ""` 防止 AI 回傳 null 導致 `in None` TypeError
        vibe_tags = list(event_data.get("vibe_tags") or [])
        location  = event_data.get("location") or ""
        auto_tags = get_source_auto_tags(location, source_type)
        for tag in auto_tags:
            if tag not in vibe_tags:
                vibe_tags.append(tag)

        # ── 圖片優先級：爬蟲原始圖 > AI 解析圖，兩者都做格式校驗 ────────────
        # raw_image_url 來自 apify_scraper 存入的 [圖片URL] 段落，絕對不是 AI 幻想
        ai_image_url = event_data.get("image_url") or ""
        image_captured = ""
        for candidate in (raw_image_url, ai_image_url):
            if candidate and is_valid_image_url(candidate):
                image_captured = candidate
                break
        # 保底已移除：apify_scraper 現在只寫入可渲染的 CDN URL 或空字串，
        # 此處不再接受「看起來不像頁面」的模糊 URL，避免 facebook.com/photo 漏網。
        if ai_image_url and not image_captured:
            print(f"  [IMG] 圖片 URL 無效已清除：{ai_image_url[:70]}")

        # ── 場館地址攔截（Venue Address Override）────────────────────────────
        # substring match：venue_name 含白名單 key → 強制覆寫 address
        # 優先級：VENUE_ADDRESS_MAP > AI 回傳的 address
        venue_name = location  # 已確保為 str（非 None）
        address = event_data.get("address")
        for kw, precise_addr in VENUE_ADDRESS_MAP.items():
            if kw in venue_name:
                address = precise_addr
                print(f"  📌 地址攔截：{venue_name!r} 含「{kw}」→ address 強制設為「{precise_addr}」")
                break

        payload = {
            "title":              event_data.get("event_name") or "未提供",
            "description":        event_data.get("card_summary") or "",
            "start_time":         iso_start or None,
            "end_time":           iso_end,
            "end_date":           event_data.get("end_date"),
            "venue_name":         venue_name or "未提供",
            "address":            address,
            "opening_hours":      event_data.get("opening_hours"),
            "latitude":           lat,
            "longitude":          lon,
            "is_free":            event_data.get("is_free") or False,
            "source_url":         source_url,
            "vibe_tags":          vibe_tags,
            "target_audience":    event_data.get("target_audience") or [],
            "weather_resilience": event_data.get("weather_resilience") or 3,
            # image_captured 是主要欄位（前端優先讀取）
            "image_captured":     image_captured,
            "engagement_metrics": {"image_captured": image_captured},
            # 分潤欄位（CLAUDE.md 規範：必須保留）
            "affiliate_links": {
                "rental":        {"label": "租車/租機車", "url": None},
                "ticket":        {"label": "售票連結",   "url": None},
                "accommodation": {"label": "周邊住宿",   "url": None},
            },
        }
        # ── 第一層：複合鍵去重（source_url + title）────────────────────────
        # 避免單一 source_url 阻擋同頁多筆子活動（如單一貼文含多場工作坊）。
        if source_url:
            dup1 = (
                supabase.table("events")
                .select("id")
                .eq("source_url", source_url)
                .eq("title", payload["title"])
                .execute()
            )
            if dup1.data:
                print(f"  ⏩ 重複略過（source_url + title）：{payload['title']}")
                return True   # 視為已處理成功

        # ── 第二層：跨平台模糊去重（start_time 精確 + title 前 6 字模糊）────
        title_prefix = payload["title"][:6]
        if title_prefix and payload.get("start_time"):
            dup2 = (
                supabase.table("events")
                .select("id")
                .eq("start_time", payload["start_time"])
                .ilike("title", f"{title_prefix}%")
                .execute()
            )
            if dup2.data:
                print(f"  ⏩ 重複略過（跨平台模糊比對）：{payload['title']}")
                return True   # 視為已處理成功

        # ── 第三層：座標 / 場館 / 標題相似度去重（原有邏輯）────────────────
        if _is_duplicate_event(
            payload["title"], payload["start_time"], payload["venue_name"],
            lat=payload["latitude"], lon=payload["longitude"],
        ):
            return True   # 視為已處理成功，不標記 ai_failed

        # ── 第四層：向量語意去重（跨平台最終防線）────────────────────────────
        embed_text = (
            f"{payload['title']} "
            f"{(payload['start_time'] or '')[:10]} "
            f"{payload.get('description', '')[:200]}"
        ).strip()
        embedding = generate_embedding(embed_text)
        if embedding:
            is_dup, matched = check_semantic_duplicate(
                embedding,
                new_start_date=(payload['start_time'] or '')[:10],
                new_title=payload['title'],
            )
            if is_dup:
                print(f"  🧠 語意重複，跳過：{payload['title']}（↳ 相似：{matched}）")
                return True   # 視為已處理成功
        payload["embedding"] = embedding  # None → Supabase 寫入 NULL

        supabase.table("events").insert(payload).execute()
        print(f"  ✅ 寫入 events：{payload['title']}")
        return True
    except Exception as e:
        print(f"  ❌ 寫入 events 失敗: {e}")
        return False


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main(limit: int | None = None):
    print("🤖 [第二階段] AI 清洗處理器啟動")
    if limit:
        print(f"   測試模式：只處理前 {limit} 筆")

    rows = fetch_pending(limit)
    total = len(rows)

    if total == 0:
        print("✨ 沒有待處理的 pending 貼文，結束。")
        return

    print(f"📋 取得 {total} 筆 pending 貼文，開始逐筆處理...\n")

    counts = {"processed": 0, "not_event": 0, "ai_failed": 0}
    success_list: list[str] = []

    for i, row in enumerate(rows, 1):
        row_id      = row["id"]
        keyword     = row.get("keyword", "")
        source_url  = row.get("source_url") or row.get("permalink", "")
        raw_text    = row.get("raw_text", "")
        source_type = _detect_source_type(row)

        # 從爬蟲存入的 [圖片URL] 段落提取原始圖片（不依賴 AI 幻想）
        raw_image_url = ""
        if "[圖片URL]" in raw_text:
            after = raw_text.split("[圖片URL]", 1)[1].strip()
            raw_image_url = after.split("\n")[0].strip()

        print(f"[{i}/{total}] id={row_id} | keyword={keyword} | source_type={source_type}")

        if not raw_text.strip():
            print("  ⏩ raw_text 為空，標記 not_event")
            update_raw_status(row_id, "not_event")
            counts["not_event"] += 1
            continue

        # ── 前置過濾：公文/補助公告直接排除，不消耗 Gemini quota ──
        if _is_govt_doc(raw_text):
            print("  🚫 前置過濾命中（公文/補助/招標），直接標記 not_event，跳過 AI")
            update_raw_status(row_id, "not_event")
            counts["not_event"] += 1
            continue

        # ai_data_cleaner 現在回傳 list[dict] | None
        events_list = ai_data_cleaner(raw_text, source_type=source_type)

        if events_list is None:
            update_raw_status(row_id, "ai_failed")
            counts["ai_failed"] += 1
            print("  → ai_failed")
            continue

        # 判斷整批是否全為非活動
        any_event = any(e.get("is_event") for e in events_list)

        if not any_event:
            update_raw_status(row_id, "not_event")
            counts["not_event"] += 1
            print(f"  → not_event（AI 判定非活動）")
            continue

        # 逐筆寫入（一篇 raw_post 可拆出多筆活動）
        new_status = "not_event"
        for event in events_list:
            if not event.get("is_event"):
                continue
            ok = save_event(event, source_url, source_type=source_type,
                            raw_image_url=raw_image_url)
            if ok:
                new_status = "processed"
                counts["processed"] += 1
                success_list.append(event.get("event_name", "（未命名）"))
            else:
                counts["ai_failed"] += 1

        update_raw_status(row_id, new_status)

        # 輕量緩衝，避免 Gemini 連打
        time.sleep(random.uniform(0.5, 1.2))

    print(f"\n{'─'*40}")
    print(f"✅ 完成。processed={counts['processed']} | not_event={counts['not_event']} | ai_failed={counts['ai_failed']}")

    # ── 成功結構化清單 ──
    if success_list:
        print(f"\n🎉 成功結構化的活動清單（共 {len(success_list)} 筆）：")
        for idx, name in enumerate(success_list, 1):
            print(f"  {idx:>2}. {name}")
    else:
        print("ℹ️  本次無成功寫入 events 的活動。")

    if counts["ai_failed"] > 0:
        print("\nℹ️  重跑失敗筆數：python process_pending.py  （ai_failed 需先在 DB 手動改回 pending）")

    # ── 嗶嗶提醒 ──
    print("\n\a\a\a")  # 終端機嗶聲（BEL 字元）
    print("🔔 收割完成，請驗收這批台東藝文資料！")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="處理 raw_threads_posts 中的 pending 貼文")
    parser.add_argument("--limit", type=int, default=None, help="只處理前 N 筆（測試用）")
    args = parser.parse_args()
    main(limit=args.limit)
