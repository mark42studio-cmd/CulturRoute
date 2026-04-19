import os
import json
import requests
from dotenv import load_dotenv, find_dotenv
from supabase import create_client, Client

# ==========================================
# 1. 系統初始化
# ==========================================
load_dotenv(find_dotenv(), encoding="utf-8-sig")

url: str = os.getenv("SUPABASE_URL").strip()
key: str = os.getenv("SUPABASE_SERVICE_KEY").strip()
google_key: str = os.getenv("GOOGLE_MAPS_API_KEY").strip()

supabase: Client = create_client(url, key)

# ==========================================
# 2. Google API 抓取邏輯 (通用版)
# ==========================================
def fetch_taitung_place(place_name):
    """抓取地點資訊，包含簡介、座標與營業時間"""
    api_url = "https://places.googleapis.com/v1/places:searchText"
    search_query = place_name if "台東" in place_name else f"台東 {place_name}"
    
    # 🌟 優化：加入 editorialSummary (簡介) 與 types (類型)
    field_mask = (
        "places.displayName.text,"
        "places.location,"
        "places.rating,"
        "places.regularOpeningHours.weekdayDescriptions,"
        "places.priceLevel,"
        "places.primaryTypeDisplayName.text,"
        "places.editorialSummary.text,"
        "places.id"
    )
    
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": google_key,
        "X-Goog-FieldMask": field_mask
    }
    
    payload = {
        "textQuery": search_query,
        "languageCode": "zh-TW", 
        "maxResultCount": 1      
    }

    try:
        response = requests.post(api_url, json=payload, headers=headers)
        response.raise_for_status() 
        data = response.json()
        
        if "places" not in data or len(data["places"]) == 0:
            print(f"❌ 找不到地點：{search_query}")
            return None
            
        return data["places"][0]
    except Exception as e:
        print(f"❌ Google API 請求失敗：{e}")
        return None

# ==========================================
# 3. 儲存邏輯 (區分景點與美食)
# ==========================================

def save_to_places(place_data):
    """將資料存入 places 表格"""
    try:
        name = place_data.get("displayName", {}).get("text")
        
        # 檢查是否已存在
        check = supabase.table("places").select("id").eq("name", name).execute()
        if check.data:
            print(f"⏩ 景點已存在：{name}")
            return

        payload = {
            "name": name,
            "description": place_data.get("editorialSummary", {}).get("text", "尚無簡介"),
            "latitude": place_data.get("location", {}).get("latitude"),
            "longitude": place_data.get("location", {}).get("longitude"),
            "opening_hours": json.dumps(place_data.get("regularOpeningHours", {}).get("weekdayDescriptions", []), ensure_ascii=False),
            "source_url": f"https://www.google.com/maps/place/?q=place_id:{place_data.get('id')}"
        }
        
        supabase.table("places").insert(payload).execute()
        print(f"🏞️ 成功寫入景點：{name}")
    except Exception as e:
        print(f"❌ 景點寫入失敗：{e}")

def save_to_foods(place_data):
    """將資料存入 foods 表格"""
    try:
        name = place_data.get("displayName", {}).get("text")
        
        # 檢查是否已存在
        check = supabase.table("foods").select("id").eq("name", name).execute()
        if check.data:
            print(f"⏩ 美食已存在：{name}")
            return

        payload = {
            "name": name,
            "cuisine_type": place_data.get("primaryTypeDisplayName", {}).get("text", "未分類"),
            "price_range": place_data.get("priceLevel", "未提供"),
            "latitude": place_data.get("location", {}).get("latitude"),
            "longitude": place_data.get("location", {}).get("longitude"),
            "google_rating": place_data.get("rating"),
            "opening_hours": json.dumps(place_data.get("regularOpeningHours", {}).get("weekdayDescriptions", []), ensure_ascii=False)
        }
        
        supabase.table("foods").insert(payload).execute()
        print(f"🍜 成功寫入美食：{name}")
    except Exception as e:
        print(f"❌ 美食寫入失敗：{e}")

# ==========================================
# 4. 主執行程序
# ==========================================
if __name__ == "__main__":
    # --- 1. 處理景點清單 ---
    scenic_spots = ["加路蘭海岸", "台東森林公園", "三仙台", "多良車站"]
    print("🚀 啟動：台東景點同步任務")
    for spot in scenic_spots:
        data = fetch_taitung_place(spot)
        if data: save_to_places(data)
    
    print("\n" + "="*30 + "\n")

    # --- 2. 處理美食清單 ---
    food_spots = ["卑南豬血湯", "阿鋐炸雞", "台東特選海鮮"]
    print("🚀 啟動：台東美食同步任務")
    for food in food_spots:
        data = fetch_taitung_place(food)
        if data: save_to_foods(data)