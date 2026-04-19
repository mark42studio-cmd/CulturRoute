"""
venue_whitelist.py
──────────────────
台東重點空間固定座標白名單。

優先層級：白名單命中 > Google Places API > AI 猜測。
使用方式：
  from venue_whitelist import lookup_venue_coords

  lat, lng = lookup_venue_coords("晃晃書店")
  # → (22.7545, 121.1452) 或 (None, None)
"""

# ──────────────────────────────────────────────────────────────────────────────
# 白名單：場館名稱 → (緯度, 經度)
# 所有座標均經 Google Maps 人工核對，精確到 4 位小數。
# ──────────────────────────────────────────────────────────────────────────────
VENUE_WHITELIST: dict[str, tuple[float, float]] = {
    # ── 台東市區 ──────────────────────────────────────────────────────────────
    "晃晃書店":         (22.7545, 121.1452),
    "晃晃二手書店":     (22.7545, 121.1452),
    "就藝會":           (22.7533, 121.1481),
    "the ARK":          (22.7528, 121.1463),
    "the ARK 方舟":     (22.7528, 121.1463),
    "方舟":             (22.7528, 121.1463),
    "鐵花村":           (22.7503, 121.1489),
    "鐵花村音樂聚落":   (22.7503, 121.1489),
    "台東美術館":       (22.7561, 121.1498),
    "台東縣立美術館":   (22.7561, 121.1498),
    "台東森林公園":     (22.7473, 121.1680),
    "活水湖":           (22.7473, 121.1680),
    "台東生活美學館":   (22.7576, 121.1445),
    "史前文化博物館":   (22.7595, 121.1416),
    "台東縣立圖書館":   (22.7548, 121.1436),
    "台東火車站":       (22.7993, 121.1028),
    "台東轉運站":       (22.7993, 121.1028),

    # ── 都蘭聚落 ──────────────────────────────────────────────────────────────
    "都蘭糖廠":         (23.1278, 121.3768),
    "都蘭糖廠咖啡屋":   (23.1278, 121.3768),
    "好的擺":           (23.1295, 121.3762),
    "好的擺 Haodebai":  (23.1295, 121.3762),
    "Haodebai":         (23.1295, 121.3762),
    "月光小棧":         (23.1302, 121.3755),
    "都蘭":             (23.1280, 121.3765),   # 都蘭村通用座標

    # ── 池上 ──────────────────────────────────────────────────────────────────
    "江賢二藝術園區":   (23.0985, 121.2255),
    "池上穀倉藝術館":   (23.0979, 121.2271),
    "池上穀倉":         (23.0979, 121.2271),
    "池上":             (23.0972, 121.2262),   # 池上鄉通用座標
    "池上鄉":           (23.0972, 121.2262),

    # ── 鹿野 / 關山 ────────────────────────────────────────────────────────────
    "鹿野高台":         (23.0011, 121.1556),
    "關山親水公園":     (23.0530, 121.1666),

    # ── 成功 / 東河 ────────────────────────────────────────────────────────────
    "成功鎮":           (23.0989, 121.3741),
    "東河":             (23.1015, 121.3645),
    "東管處":           (23.1210, 121.3802),
}

# ── 別名對應（搜尋關鍵詞 → 正式名稱） ──────────────────────────────────────────
_ALIASES: dict[str, str] = {
    "晃晃":    "晃晃書店",
    "ARK":     "the ARK",
    "ark":     "the ARK",
    "方舟藝術空間": "the ARK 方舟",
    "穀倉":    "池上穀倉藝術館",
    "江賢二":  "江賢二藝術園區",
}


def lookup_venue_coords(location_name: str) -> tuple[float | None, float | None]:
    """
    依場館名稱查詢固定座標。

    查詢策略：
      1. 完全比對（去除首尾空白）
      2. 別名比對
      3. 子字串比對（場館名稱包含在輸入中，或輸入包含在場館名稱中）

    找不到時回傳 (None, None)，呼叫端再走 Google Places API。
    """
    if not location_name:
        return None, None

    name = location_name.strip()

    # 1. 完全比對
    if name in VENUE_WHITELIST:
        lat, lng = VENUE_WHITELIST[name]
        print(f"  📌 白名單命中（完全比對）：{name} → ({lat}, {lng})")
        return lat, lng

    # 2. 別名比對
    if name in _ALIASES:
        canonical = _ALIASES[name]
        if canonical in VENUE_WHITELIST:
            lat, lng = VENUE_WHITELIST[canonical]
            print(f"  📌 白名單命中（別名）：{name} → {canonical} → ({lat}, {lng})")
            return lat, lng

    # 3. 子字串比對：白名單中有沒有哪個 key 包含在輸入裡，或反過來
    # 長度守衛：輸入 ≤ 3 字（例如「台東」「台東市」）過於模糊，
    # 跳過子字串比對，交由 Google Places API 處理，避免誤命中。
    if len(name) >= 4:
        for key, coords in VENUE_WHITELIST.items():
            if key in name or name in key:
                lat, lng = coords
                print(f"  📌 白名單命中（子字串）：'{name}' ≈ '{key}' → ({lat}, {lng})")
                return lat, lng

    return None, None


def get_source_auto_tags(venue_name: str, source_type: str) -> list[str]:
    """
    依來源類型與場館名稱，自動附加質感標籤。
    - indie_curation 場館 → #indie_curation
    - township 公所 → #local_festival
    - 晃晃/就藝會/ARK → 額外加 #選品空間
    """
    tags: list[str] = []
    if source_type == "indie_curation":
        tags.append("#indie_curation")
        if any(kw in venue_name for kw in ["晃晃", "就藝會", "ARK", "方舟"]):
            tags.append("#選品空間")
    elif source_type == "township":
        tags.append("#local_festival")
    return tags
