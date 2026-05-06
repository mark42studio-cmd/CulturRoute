import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent'

const VALID_REGIONS = ['市區', '山線', '海線', '南迴', '離島'] as const

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export async function POST(req: NextRequest) {
  const { submission_id } = await req.json()
  if (!submission_id) {
    return NextResponse.json({ error: '缺少 submission_id' }, { status: 400 })
  }

  const supabase = sb()

  const { data: row, error: fetchErr } = await supabase
    .from('submissions')
    .select('*')
    .eq('id', submission_id)
    .single()

  if (fetchErr || !row) {
    return NextResponse.json({ error: '找不到申請記錄' }, { status: 404 })
  }

  // Gemini：地理解析 + 描述清洗
  let latitude: number | null = null
  let longitude: number | null = null
  let region = '市區'
  let cleanedDescription: string = row.description ?? ''

  const apiKey = process.env.GEMINI_API_KEY
  if (apiKey) {
    try {
      const prompt =
        `你是台灣台東在地地理專家。根據以下活動地點與描述，只輸出 JSON，不加任何說明：\n` +
        `{"latitude":數字,"longitude":數字,"region":"市區|山線|海線|南迴|離島","cleaned_description":"清洗後乾淨的活動介紹"}\n\n` +
        `地點：${row.location}\n描述：${row.description ?? ''}`

      const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0 },
        }),
      })
      const geminiData = await geminiRes.json()
      const text: string = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const match = text.match(/\{[\s\S]*?\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (typeof parsed.latitude === 'number') latitude = parsed.latitude
        if (typeof parsed.longitude === 'number') longitude = parsed.longitude
        if (VALID_REGIONS.includes(parsed.region)) region = parsed.region
        if (parsed.cleaned_description) cleanedDescription = parsed.cleaned_description
      }
    } catch {
      // Gemini 失敗時用原始值繼續
    }
  }

  // 解析活動時間
  const startDateStr: string | null = (row.start_date as string) || null
  const endDateStr: string | null = (row.end_date as string) || null

  let startTime: string
  try {
    const src = startDateStr || (row.raw_date as string)
    const parsed = new Date(src)
    startTime = isNaN(parsed.getTime())
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : parsed.toISOString()
  } catch {
    startTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  // 寫入 events
  const { error: insertErr } = await supabase.from('events').insert([{
    title:            row.title,
    start_time:       startTime,
    start_date:       startDateStr,
    end_date:         endDateStr,
    venue_name:       row.location,
    address:          row.location,
    description:      cleanedDescription,
    long_description: cleanedDescription,
    image_url:        row.image_url ?? null,
    latitude,
    longitude,
    region,
    is_published:     true,
    affiliate_links: {
      rental:        { label: '租車/租機車', url: null },
      ticket:        { label: '售票連結',   url: null },
      accommodation: { label: '周邊住宿',   url: null },
    },
  }])

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  await supabase.from('submissions').update({ status: 'approved' }).eq('id', submission_id)

  return NextResponse.json({ ok: true })
}
