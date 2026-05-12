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
    .from('submissions')
    .select('*')
    .eq('id', safeId)
    .single()
  if (fetchErr || !row) return { error: '找不到申請記錄' }

  // 優先用 AI 解析的 start_date，退回 raw_date 字串解析，最後佔位 30 天後
  let startTime: string
  try {
    const src = (row.start_date as string) || (row.raw_date as string)
    const parsed = new Date(src)
    startTime = isNaN(parsed.getTime())
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : parsed.toISOString()
  } catch {
    startTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  const { error: insertErr } = await sb()
    .from('events')
    .insert([{
      title:          row.title,
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

  await sb().from('submissions').update({ status: 'approved' }).eq('id', safeId)
  revalidatePath('/admin/submissions')
  revalidatePath('/')
  return {}
}

export async function rejectSubmission(id: string): Promise<{ error?: string }> {
  const safeId = validate(UuidSchema, id)
  const { error } = await sb()
    .from('submissions')
    .update({ status: 'rejected' })
    .eq('id', safeId)
  if (error) return { error: error.message }
  revalidatePath('/admin/submissions')
  return {}
}

export async function getSubmissions(): Promise<{ data: Record<string, unknown>[] | null; error?: string }> {
  const { data, error } = await sb()
    .from('submissions')
    .select('*')
    .order('created_at', { ascending: false })
  return { data, error: error?.message }
}
