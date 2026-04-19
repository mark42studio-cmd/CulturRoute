import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { query } = body;

    if (!query) {
      return NextResponse.json({ error: '請提供搜尋關鍵字' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: '未設定 Google API Key' }, { status: 500 });
    }

    // 1. 向 Google 索取資料 (🌟 注意 FieldMask 多加了 places.photos)
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
    
    // 2. 如果有抓到資料，我們幫前端把「圖片真實網址」組合好
    if (data.places) {
      const placesWithPhotos = data.places.map((place: any) => {
        let photoUrl = '';
        // 判斷這家店有沒有上傳照片
        if (place.photos && place.photos.length > 0) {
          // 拿第一張照片的代號
          const photoName = place.photos[0].name; 
          // 🌟 組合出可以直接在 <img> 標籤顯示的真實網址 (限制最大寬度 800px 節省流量)
          photoUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${apiKey}`;
        }
        
        return {
          ...place,
          photoUrl // 把組合好的網址塞回資料裡傳給前端
        };
      });

      return NextResponse.json({ places: placesWithPhotos });
    }

    return NextResponse.json(data);
    
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}