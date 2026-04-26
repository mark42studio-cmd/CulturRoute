'use server'

import { createClient } from '@supabase/supabase-js'
import { validate, SubmitEventSchema } from '@/lib/validation'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export async function submitEvent(payload: {
  name: string
  time: string
  location: string
  description: string
  image_url: string
  comments: string
}): Promise<{ error?: string }> {
  const safe = validate(SubmitEventSchema, payload)

  if (safe.image_url) {
    try {
      const res = await fetch(safe.image_url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(6000),
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.startsWith('image/')) {
        return { error: '圖片連結無效：URL 必須指向圖片檔案（Content-Type 須為 image/*）' }
      }
    } catch {
      return { error: '無法存取圖片連結，請確認 URL 是否可公開存取' }
    }
  }

  const { error } = await sb()
    .from('pending_events')
    .insert([{
      name:        safe.name,
      time:        safe.time,
      location:    safe.location,
      description: safe.description,
      image_url:   safe.image_url || null,
      comments:    safe.comments  || null,
      status:      'pending',
    }])

  if (error) return { error: error.message }
  return {}
}
