import { NextRequest, NextResponse } from 'next/server';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

export async function POST(req: NextRequest) {
  const { rawDate } = await req.json();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !rawDate) {
    return NextResponse.json({ start_date: null, end_date: null });
  }

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text:
              `今天是 ${new Date().toISOString().slice(0, 10)}。` +
              `將以下活動時間字串解析為 JSON：{"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"}。` +
              `若無結束日期則 end_date 與 start_date 相同。只輸出 JSON，不加其他文字。\n輸入：${rawDate}`,
          }],
        }],
        generationConfig: { maxOutputTokens: 60, temperature: 0 },
      }),
    });

    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const { start_date, end_date } = JSON.parse(match[0]);
      return NextResponse.json({ start_date: start_date ?? null, end_date: end_date ?? null });
    }
  } catch {
    // Gemini 失敗時回傳 null，呼叫端會 fallback 保留 raw_date
  }

  return NextResponse.json({ start_date: null, end_date: null });
}
