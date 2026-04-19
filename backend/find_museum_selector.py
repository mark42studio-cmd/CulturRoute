"""
find_museum_selector.py
─────────────────────────────────────────────────────────────────────
Playwright 版選擇器探測工具。
用法：python find_museum_selector.py
"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

# ── 設定 ──────────────────────────────────────────────────────────────────────

TARGETS = [
    {
        "name": "史前文化博物館（event.culture.tw）",
        "url":  "https://event.culture.tw/mocweb/reg/NMP/Index.init.ctr",
        "keywords": ["浪潮", "原住民族當代時裝", "史前", "考古", "特展", "展覽", "工作坊", "講座"],
    },
    {
        "name": "台東生活美學館（event.culture.tw）",
        "url":  "https://event.culture.tw/mocweb/reg/TTCSEC/Index.init.ctr",
        "keywords": ["篳路藍縷", "糖廠", "美學", "展覽", "工作坊", "講座", "課程", "藝文"],
    },
]

WAIT_MS   = 4000   # 等 JS 渲染完成（ms）
SCROLL_MS = 1500   # 捲到底後再等（ms）


# ── 父元素鏈輸出 ───────────────────────────────────────────────────────────────

def print_parent_chain(tag, depth: int = 5) -> None:
    """從 <a> 往上印 depth 層父元素（含 id / class）。"""
    parent = tag.parent
    for _ in range(depth):
        if not parent or parent.name in ("[document]", None):
            break
        cls    = parent.get("class", [])
        pid    = parent.get("id", "")
        cls_s  = f".{'.'.join(cls)}" if cls else ""
        id_s   = f"#{pid}"           if pid  else ""
        print(f"      -> <{parent.name}{id_s}{cls_s}>")
        parent = parent.parent


# ── 全頁連結 dump（關鍵字未命中時的 fallback）──────────────────────────────────

def dump_all_links(soup: BeautifulSoup, limit: int = 40) -> None:
    print(f"\n  ── 全頁 <a> 清單（前 {limit} 筆）供人工挑選 ────────────────────────")
    count = 0
    for a in soup.find_all("a", href=True):
        txt  = a.get_text(strip=True)
        href = a.get("href", "")
        if not txt and not href:
            continue
        print(f"  [{count+1:02d}] '{txt[:50]:50s}'  {href[:80]}")
        count += 1
        if count >= limit:
            break


# ── 主邏輯 ────────────────────────────────────────────────────────────────────

def probe(target: dict) -> None:
    name     = target["name"]
    url      = target["url"]
    keywords = target["keywords"]

    print(f"\n{'═'*72}")
    print(f"  [PROBE] {name}")
    print(f"          {url}")
    print(f"          keywords = {keywords}")
    print(f"{'═'*72}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx     = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            extra_http_headers={"Accept-Language": "zh-TW,zh;q=0.9"},
        )
        page = ctx.new_page()

        try:
            page.goto(url, wait_until="networkidle", timeout=30_000)
        except Exception:
            # networkidle timeout 仍繼續（部分網站永不 idle）
            pass

        # 捲到底觸發懶加載
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(SCROLL_MS)

        # 二次等待確保 XHR 完成
        try:
            page.wait_for_load_state("networkidle", timeout=WAIT_MS)
        except Exception:
            pass

        html = page.content()
        browser.close()

    soup  = BeautifulSoup(html, "html.parser")
    links = soup.find_all("a")

    print(f"\n  頁面大小：{len(html):,} bytes | 找到 <a> 標籤：{len(links)} 個")

    # ── 關鍵字搜尋 ─────────────────────────────────────────────────────────────
    found_any = False
    for a in links:
        text = a.get_text(strip=True)
        href = a.get("href", "")
        combined = text + href

        if any(kw in combined for kw in keywords):
            found_any = True
            print(f"\n  ✓ 命中關鍵字")
            print(f"    文字  : '{text[:70]}'")
            print(f"    href  : {href[:80]}")
            print(f"    父元素鏈（由內到外）：")
            print_parent_chain(a, depth=5)

    if not found_any:
        print("\n  ✗ 未找到任何關鍵字連結")
        dump_all_links(soup, limit=40)

    # ── 額外：印出所有看起來像活動卡片的 <a>（href 含 event / act / reg）──────
    print(f"\n  ── 看起來像活動頁的連結（href 含 event/act/reg/ctr）─────────────────")
    event_links = [
        a for a in links
        if any(p in (a.get("href") or "").lower() for p in ["event", "act", "reg", "ctr", "detail"])
    ]
    print(f"  共 {len(event_links)} 筆：")
    for i, a in enumerate(event_links[:20], 1):
        txt  = a.get_text(strip=True)[:50]
        href = (a.get("href") or "")[:80]
        print(f"  [{i:02d}] '{txt:50s}'  {href}")
        if i == 1:
            print(f"         父元素鏈：")
            print_parent_chain(a, depth=5)

    print(f"\n{'═'*72}\n")


# ── 入口 ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    for t in TARGETS:
        probe(t)
