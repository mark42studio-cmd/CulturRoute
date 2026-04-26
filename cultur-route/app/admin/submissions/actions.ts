'use server'

import { createClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { validate, UuidSchema } from '@/lib/validation'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export async function approveSubmission(id: string): Promise<{ error?: string }> {
  const safeId = validate(UuidSchema, id)

  const { data: row, error: fetchErr } = await sb()
    .from('pending_events')
    .select('*')
    .eq('id', safeId)
    .single()
  if (fetchErr || !row) return { error: '找不到申請記錄' }

  // 嘗試解析時間字串，無法解析時用 30 天後作為佔位（管理員可在 AdminClient 修正）
  let startTime: string
  try {
    const parsed = new Date(row.time as string)
    startTime = isNaN(parsed.getTime())
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : parsed.toISOString()
  } catch {
    startTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  const { error: insertErr } = await sb()
    .from('events')
    .insert([{
      title:          row.name,
      start_time:     startTime,
      venue_name:     row.location,
      image_captured: (row.image_url as string) || null,
      is_published:   false,
      affiliate_links: {
        rental:        { label: '租車/租機車', url: null },
        ticket:        { label: '售票連結',   url: null },
        accommodation: { label: '周邊住宿',   url: null },
      },
    }])
  if (insertErr) return { error: insertErr.message }

  await sb().from('pending_events').update({ status: 'approved' }).eq('id', safeId)
  revalidatePath('/admin/submissions')
  revalidatePath('/')
  return {}
}

export async function rejectSubmission(id: string): Promise<{ error?: string }> {
  const safeId = validate(UuidSchema, id)
  const { error } = await sb()
    .from('pending_events')
    .update({ status: 'rejected' })
    .eq('id', safeId)
  if (error) return { error: error.message }
  revalidatePath('/admin/submissions')
  return {}
}
