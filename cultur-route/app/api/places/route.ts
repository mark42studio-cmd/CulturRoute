import { NextResponse } from 'next/server';
import { PlacesQuerySchema, parseRequest } from '@/lib/validation';

export async function POST(request: Request) {
  // ── 1. 解析並校驗 request body ────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '請求 body 必須為合法 JSON' }, { status: 400 });
  }

  const parsed = parseRequest(PlacesQuerySchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const { query } = parsed.data;  // 已通過 trim + max(100) 驗證

  // ── 2. 呼叫 Google Places API ─────────────────────────────────────────────
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: '未設定 Google API Key' }, { status: 500 });
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.editorialSummary,places.photos',
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'zh-TW',
      }),
    });

    const data = await response.json();

    // ── 3. 組合圖片真實網址後回傳 ─────────────────────────────────────────
    if (data.places) {
      const placesWithPhotos = data.places.map((place: any) => {
        let photoUrl = '';
        if (place.photos && place.photos.length > 0) {
          const photoName = place.photos[0].name;
          photoUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${apiKey}`;
        }
        return { ...place, photoUrl };
      });
      return NextResponse.json({ places: placesWithPhotos });
    }

    return NextResponse.json(data);

  } catch {
    // 不向前端洩漏內部錯誤細節
    return NextResponse.json({ error: '查詢失敗，請稍後再試' }, { status: 500 });
  }
}
