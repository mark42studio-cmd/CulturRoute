"""
test_embedding.py — 列出目前 API Key 可用的 Embedding 模型

用法：
  python test_embedding.py
"""

import os
from dotenv import load_dotenv, find_dotenv
from google import genai

load_dotenv(find_dotenv(), encoding="utf-8-sig")

api_key = os.getenv("GEMINI_API_KEY", "").strip()
if not api_key:
    print("❌ 找不到 GEMINI_API_KEY，請確認 .env 檔案")
    exit(1)

client = genai.Client(api_key=api_key)

print("🔍 正在查詢可用模型清單...\n")

all_models = list(client.models.list())
embed_models = [
    m for m in all_models
    if "embedContent" in (getattr(m, "supported_actions", None) or [])
    or "EMBEDDING" in str(getattr(m, "name", "")).upper()
]

if embed_models:
    print(f"✅ 找到 {len(embed_models)} 個 Embedding 相關模型：\n")
    for m in embed_models:
        print(f"  名稱：{m.name}")
        print(f"  顯示名稱：{getattr(m, 'display_name', '(無)')}")
        print()
else:
    print("⚠️  未找到 Embedding 模型，列印完整清單供排查")

print("─" * 40)
print("📋 所有可用模型：")
for m in all_models:
    print(f"  {m.name}")
