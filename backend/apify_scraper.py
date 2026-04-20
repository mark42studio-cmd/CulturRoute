"""
apify_scraper.py
────────────────
Phase 2-B：Facebook 粉專/社團 + Instagram 帳號爬蟲
使用 Apify 繞過 Meta 反爬蟲，raw-first 寫入 raw_threads_posts。

目標來源：config/scraping_targets.json 的 social_media 清單
（官方機構 + 在地獨立空間全部由此統一管理）

執行方式：
  python apify_scraper.py              # 抓所有 FB + IG 目標
  python apify_scraper.py --limit 5    # 每個目標只取前 5 筆（測試用）
  python apify_scraper.py --only 晃晃  # 只抓名稱含「晃晃」的目標

前置條件：
  .env 需含 APIFY_API_TOKEN
  Supabase raw_threads_posts 表須已存在
"""

import os
import json
import argparse
from dotenv import load_dotenv, find_dotenv
from apify_client import ApifyClient
from supabase import create_client, Client

load_dotenv(find_dotenv(), encoding="utf-8-sig", override=True)

APIFY_TOKEN  = os.getenv("APIFY_API_TOKEN", "").strip()
supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()

apify: ApifyClient = ApifyClient(APIFY_TOKEN)
supabase: Client   = create_client(supabase_url, supabase_key)

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config", "scraping_targets.json")

# ── 黑名單：來源名稱或 URL 含以下字串者，爬取階段直接跳過，連 AI 都不呼叫 ────
SOURCE_BLACKLIST: list[str] = [
    "台東藝文中心", "臺東藝文中心",
    "臺東藝術節",  "台東藝術節",
    "東表藝",
]

# 單篇貼文最短有效字數（含圖片時豁免）
MIN_TEXT_LENGTH = 20


def _is_blacklisted(text: str) -> bool:
    """回傳 True 表示命中黑名單，應直接跳過。"""
    return any(kw in text for kw in SOURCE_BLACKLIST)


def _is_already_in_events(permalink: str | None) -> bool:
    """
    檢查 events 表是否已有該 source_url，避免重複呼叫 AI。
    回傳 True = 已存在，應跳過。
    """
    if not permalink:
        return False
    try:
        result = (
            supabase.table("events")
            .select("id")
            .eq("source_url", permalink)
            .limit(1)
            .execute()
        )
        return bool(result.data)
    except Exception:
        return False


def load_social_targets() -> list[dict]:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)
    return config.get("social_media", [])


# ── 把 social_media 清單轉換成舊有格式 ──────────────────────────────────────────
def _build_fb_targets(targets: list[dict]) -> list[dict]:
    return [
        {"label": t["name"], "url": t["url"], "keyword": t["keyword"],
         "source_type": t.get("source_type", "official"), "max_posts": t.get("max_posts", 20)}
        for t in targets
        if t.get("platform") == "facebook"
    ]


def _build_ig_targets(targets: list[dict]) -> list[dict]:
    result = []
    for t in targets:
        if t.get("platform") == "instagram":
            # 從 URL 取 username
            url = t.get("url", "")
            username = url.rstrip("/").split("/")[-1]
            result.append({
                "label": t["name"], "username": username,
                "keyword": t["keyword"],
                "source_type": t.get("source_type", "official"),
                "max_posts": t.get("max_posts", 20),
            })
    return result


# ── Actor 路由：依 URL 判斷粉專 or 社團 ────────────────────────────────────────

def is_group_url(url: str) -> bool:
    return "/groups/" in url


# ── Apify item 圖片 URL 提取 ────────────────────────────────────────────────────

def _extract_image_url(item: dict) -> str:
    """
    從 Apify item 中取出最可能是活動海報的圖片 CDN URL。
    只回傳可直接渲染的圖片網址；找不到時回傳空字串。

    優先級：
      1. fbcdn.net / cdninstagram.com / fbsbx.com CDN 直連
      2. 有標準圖片副檔名（.jpg/.png/.webp 等）的直連 URL
      3. 找不到 → 回傳 ""（寧缺毋濫，不回傳頁面連結）
    """
    _CDN_DOMAINS = ("fbcdn.net", "cdninstagram.com", "fbsbx.com")
    _IMG_EXTS    = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")

    # Facebook 頁面 URL 特徵（絕對不能當圖片用）
    _FB_PAGE_PATTERNS = (
        "facebook.com/photo",    # /photo/ 相簿頁
        "facebook.com/photos",   # /photos/ 相簿集
        "facebook.com/permalink",
        "story_fbid",            # Story 連結參數
        "/posts/",               # 貼文頁
        "facebook.com/reel",     # Reel 頁
    )

    def _is_fb_page_url(url: str) -> bool:
        u = url.lower()
        return any(pat in u for pat in _FB_PAGE_PATTERNS)

    def _is_cdn_url(url: str) -> bool:
        return any(cdn in url for cdn in _CDN_DOMAINS)

    def _has_img_ext(url: str) -> bool:
        path = url.split("?")[0].lower()
        return any(path.endswith(ext) for ext in _IMG_EXTS)

    def _is_valid_image(url: str) -> bool:
        if not url or not url.startswith("http"):
            return False
        if _is_fb_page_url(url):
            return False
        return _is_cdn_url(url) or _has_img_ext(url)

    cdn_candidates: list[str] = []   # fbcdn.net 等直連，最優先
    ext_candidates: list[str] = []   # 有副檔名的直連，次優先

    def _register(url: str) -> None:
        """嘗試將 URL 分類至對應候選桶。"""
        if not url or not url.startswith("http") or _is_fb_page_url(url):
            return
        if _is_cdn_url(url):
            cdn_candidates.append(url)
        elif _has_img_ext(url):
            ext_candidates.append(url)

    # ── 1. 深度遍歷 media 陣列（最優先：image/thumbnail 鍵在 url 鍵之前） ────
    for field in ("media", "images", "attachments"):
        val = item.get(field)
        if not val or not isinstance(val, list):
            continue
        for element in val:
            if isinstance(element, str):
                _register(element)
            elif isinstance(element, dict):
                # image / thumbnail 優先於 url，避免拿到 facebook.com/photo 頁面連結
                for key in ("image", "thumbnail", "full_picture",
                            "displaySource", "src", "uri", "link", "url"):
                    v = element.get(key)
                    if isinstance(v, str) and v.startswith("http"):
                        _register(v)
                        # 只要找到 CDN URL 就停止繼續找該元素的其他鍵
                        if _is_cdn_url(v):
                            break

    # ── 2. 頂層單一字串欄位（image/thumbnail 同樣優先於 url） ───────────────
    for field in ("image", "thumbnail", "full_picture", "displaySource",
                  "imageUrl", "displayUrl", "thumbnailUrl", "picture"):
        val = item.get(field)
        if isinstance(val, str):
            _register(val)

    # ── 3. 回傳（CDN > 副檔名直連 > 放棄）──────────────────────────────────
    if cdn_candidates:
        return cdn_candidates[0]
    if ext_candidates:
        return ext_candidates[0]

    # 寧缺毋濫：找不到可渲染圖片時回傳空字串，前端顯示 DefaultPoster
    return ""


# ── 原始貼文存庫 ───────────────────────────────────────────────────────────────

def save_raw_post(platform: str, keyword: str, permalink: str | None,
                  source_url: str, raw_text: str,
                  source_type: str = "threads",
                  has_image: bool = False) -> bool:
    """
    原始貼文寫入 raw_threads_posts，raw_status='pending'。
    permalink UNIQUE 衝突（重複）→ 靜默跳過，回傳 False。
    """
    if not raw_text.strip():
        return False
    # 短文過濾：不足 MIN_TEXT_LENGTH 字且無圖片 → 直接跳過
    if len(raw_text.strip()) < MIN_TEXT_LENGTH and not has_image:
        return False
    # events 去重：permalink 已存在 events 表 → 不需再送 AI
    if _is_already_in_events(permalink):
        return False
    try:
        supabase.table("raw_threads_posts").insert({
            "platform":    platform,
            "keyword":     keyword,
            "permalink":   permalink,
            "source_url":  source_url or permalink,
            "raw_text":    raw_text[:5000],
            "raw_status":  "pending",
            "source_type": source_type if source_type else "threads",
        }).execute()
        return True
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "unique" in msg:
            return False   # 已存在，靜默跳過
        print(f"  ⚠️ raw 存庫失敗: {e}")
        return False


# ── Facebook 粉專（pages-scraper）─────────────────────────────────────────────

def run_facebook_pages(target: dict, limit: int) -> tuple[int, int]:
    """呼叫 apify/facebook-pages-scraper，回傳 (saved, skipped)"""
    label       = target["label"]
    url         = target["url"]
    keyword     = target["keyword"]
    source_type = target.get("source_type", "official")
    cap         = min(limit, target.get("max_posts", limit))

    print(f"  [FB] {label} (source_type={source_type}, cap={cap})")
    # 換用 facebook-posts-scraper：專門抓動態時報貼文，不回傳 Page metadata
    run = apify.actor("apify/facebook-posts-scraper").call(run_input={
        "startUrls":    [{"url": url}],
        "resultsLimit": cap,
    })

    saved = skipped = 0
    items = list(apify.dataset(run["defaultDatasetId"]).iterate_items())
    print(f"  [DEBUG] Apify 回傳原始筆數: {len(items)}")
    if items:
        print(f"  [DEBUG] 第一筆 item keys: {list(items[0].keys())}")

    for i, item in enumerate(items):
        # facebook-posts-scraper 欄位：postUrl / url、text / message、time、pageName
        post_url  = item.get("postUrl") or item.get("url") or url
        message   = (item.get("text") or item.get("message") or "").strip()
        post_time = str(item.get("time") or item.get("timestamp") or "")
        page_name = item.get("pageName") or item.get("pageProfileName") or label
        has_image = bool(item.get("images") or item.get("image") or
                         item.get("attachments") or item.get("media"))
        preview   = message[:30].replace("\n", " ") if message else "(空白)"
        print(f"  [DEBUG #{i+1}] text='{preview}' | has_image={has_image} | url={post_url[:60]}")

        # 黑名單：粉專名稱或貼文 URL 命中 → 整篇丟棄
        if _is_blacklisted(page_name) or _is_blacklisted(post_url):
            print(f"    → SKIP: 命中黑名單 (page_name={page_name})")
            skipped += 1
            continue

        if not message:
            print(f"    → SKIP: message 為空")
            continue

        if len(message) < MIN_TEXT_LENGTH and not has_image:
            print(f"    → SKIP: 文字不足 {MIN_TEXT_LENGTH} 字 (len={len(message)}) 且無圖片")
            # save_raw_post 內部也會過濾，這裡提前印出原因

        if _is_already_in_events(post_url):
            print(f"    → SKIP: post_url 已存在 events 表")

        image_url = _extract_image_url(item)
        raw_text  = (
            f"[來源: {page_name}]\n[時間: {post_time}]\n[內容]\n{message}"
            + (f"\n[圖片URL]\n{image_url}" if image_url else "")
        )

        if save_raw_post("facebook", keyword, post_url, url, raw_text, source_type, has_image=has_image):
            print(f"    → SAVED")
            saved += 1
        else:
            print(f"    → SKIP: save_raw_post 回傳 False（可能重複或文字太短）")
            skipped += 1

    return saved, skipped


# ── Facebook 社團（groups-scraper）────────────────────────────────────────────

def run_facebook_groups(target: dict, limit: int) -> tuple[int, int]:
    """呼叫 apify/facebook-groups-scraper，回傳 (saved, skipped)"""
    label       = target["label"]
    url         = target["url"]
    keyword     = target["keyword"]
    source_type = target.get("source_type", "community")
    cap         = min(limit, target.get("max_posts", limit))

    print(f"  [FB Group] {label} (cap={cap})")
    run = apify.actor("apify/facebook-groups-scraper").call(run_input={
        "startUrls":       [{"url": url}],
        "maxPosts":        cap,
        "maxPostComments": 0,
    })

    saved = skipped = 0
    for item in apify.dataset(run["defaultDatasetId"]).iterate_items():
        post_url  = item.get("url") or item.get("postUrl") or url
        message   = (item.get("message") or item.get("body") or "").strip()
        post_time = str(item.get("time") or "")

        if _is_blacklisted(label) or _is_blacklisted(post_url):
            skipped += 1
            continue

        if not message:
            continue

        has_image = bool(item.get("images") or item.get("image") or item.get("attachments"))
        image_url = _extract_image_url(item)
        raw_text  = (
            f"[來源: {label}（社團）]\n[時間: {post_time}]\n[內容]\n{message}"
            + (f"\n[圖片URL]\n{image_url}" if image_url else "")
        )

        if save_raw_post("facebook", keyword, post_url, url, raw_text, source_type, has_image=has_image):
            saved += 1
        else:
            skipped += 1

    return saved, skipped


# ── Instagram 帳號（instagram-scraper）────────────────────────────────────────

def run_instagram(target: dict, limit: int) -> tuple[int, int]:
    """呼叫 apify/instagram-scraper（帳號模式），回傳 (saved, skipped)"""
    label       = target["label"]
    username    = target["username"]
    keyword     = target["keyword"]
    source_type = target.get("source_type", "official")
    cap         = min(limit, target.get("max_posts", limit))
    ig_url      = f"https://www.instagram.com/{username}/"

    print(f"  [IG] @{username} ({label}, cap={cap})")
    run = apify.actor("apify/instagram-scraper").call(run_input={
        "directUrls":    [ig_url],
        "resultsType":   "posts",
        "resultsLimit":  cap,
        "addParentData": False,
    })

    saved = skipped = 0
    for item in apify.dataset(run["defaultDatasetId"]).iterate_items():
        post_url  = item.get("url") or ig_url
        caption   = (item.get("caption") or "").strip()
        timestamp = str(item.get("timestamp") or "")
        owner     = item.get("ownerUsername") or username
        hashtags  = " ".join(item.get("hashtags") or [])

        if _is_blacklisted(owner) or _is_blacklisted(label) or _is_blacklisted(post_url):
            skipped += 1
            continue

        if not caption:
            continue

        has_image = bool(item.get("images") or item.get("imageUrl") or item.get("displayUrl"))
        image_url = _extract_image_url(item)
        raw_text  = (
            f"[來源: @{owner}（{label}）]\n"
            f"[時間: {timestamp}]\n"
            f"[內容]\n{caption}"
            + (f"\n[標籤] {hashtags}" if hashtags else "")
            + (f"\n[圖片URL]\n{image_url}" if image_url else "")
        )

        if save_raw_post("instagram", keyword, post_url, ig_url, raw_text, source_type, has_image=has_image):
            saved += 1
        else:
            skipped += 1

    return saved, skipped


# ── 主流程 ─────────────────────────────────────────────────────────────────────

def main(limit: int = 20, only: str | None = None, dry_run: bool = False):
    if not APIFY_TOKEN:
        print("ERROR: APIFY_API_TOKEN not found in .env")
        return

    if dry_run:
        print("🔍 [DRY-RUN] 模式：只印出目標清單，不呼叫 Apify、不寫入資料庫。")

    all_targets = load_social_targets()
    if only:
        all_targets = [t for t in all_targets if only in t["name"]]
        if not all_targets:
            print(f"ERROR: no target matching '{only}'")
            return

    # 目標層級黑名單過濾：name 或 url 命中即整個目標跳過
    def _target_ok(t: dict) -> bool:
        if _is_blacklisted(t.get("name", "")) or _is_blacklisted(t.get("url", "")):
            print(f"  [BLACKLIST] 目標跳過：{t['name']}")
            return False
        return True

    fb_targets = [t for t in _build_fb_targets(all_targets) if _target_ok(t)]
    ig_targets = [t for t in _build_ig_targets(all_targets) if _target_ok(t)]

    print(f"[START] apify_scraper — {len(fb_targets)} FB + {len(ig_targets)} IG targets"
          + (" [DRY-RUN]" if dry_run else ""))
    total_saved = total_skipped = 0

    # ── Facebook ──
    print("\n=== Facebook ===")
    for target in fb_targets:
        try:
            if dry_run:
                cap = min(limit, target.get("max_posts", limit))
                actor = "groups-scraper" if is_group_url(target["url"]) else "pages-scraper"
                print(f"  [DRY-RUN] 跳過 {target['label']} | actor={actor} | cap={cap} | url={target['url']}")
                continue
            if is_group_url(target["url"]):
                s, k = run_facebook_groups(target, limit)
            else:
                s, k = run_facebook_pages(target, limit)
            print(f"  -> saved={s} skipped={k}")
            total_saved   += s
            total_skipped += k
        except Exception as e:
            print(f"  [ERR] [{target['label']}]: {e}")

    # ── Instagram ──
    if ig_targets:
        print("\n=== Instagram ===")
        for target in ig_targets:
            try:
                if dry_run:
                    cap = min(limit, target.get("max_posts", limit))
                    print(f"  [DRY-RUN] 跳過 @{target['username']} ({target['label']}) | cap={cap}")
                    continue
                s, k = run_instagram(target, limit)
                print(f"  -> saved={s} skipped={k}")
                total_saved   += s
                total_skipped += k
            except Exception as e:
                print(f"  [ERR] [{target['label']}]: {e}")

    if dry_run:
        print("\n[DRY-RUN 結束] 無任何 Apify 呼叫與 DB 寫入。")
    else:
        print(f"\n[DONE] total saved={total_saved} | skipped={total_skipped}")
        print("       Run: python process_pending.py  to start AI cleaning")
        print("\n\a\a\a")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Apify FB/IG 社群爬蟲（raw-first）")
    parser.add_argument("--limit", type=int, default=20,
                        help="每個目標最多抓幾筆（預設 20）")
    parser.add_argument("--only", type=str, default=None,
                        help="只抓名稱含此關鍵字的目標，例如 '晃晃'")
    parser.add_argument("--dry-run", action="store_true",
                        help="只印出目標清單預覽，不呼叫 Apify Actor、不寫入資料庫")
    args = parser.parse_args()
    main(limit=args.limit, only=args.only, dry_run=args.dry_run)
