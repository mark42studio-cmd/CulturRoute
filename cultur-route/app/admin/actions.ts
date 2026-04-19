'use server'

import { createClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export async function togglePublished(id: string, current: boolean): Promise<void> {
  const { error } = await sb()
    .from('events')
    .update({ is_published: !current })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/')
  revalidatePath('/admin')
}

export async function geocodeAddress(address: string): Promise<{
  latitude: number
  longitude: number
  formatted: string
}> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
  const res = await fetch(url)
  const json = await res.json()
  if (json.status !== 'OK' || !json.results?.[0]) {
    console.error('[geocodeAddress] Google API error:', json.status, json.error_message ?? '', '| query:', address)
    throw new Error(`找不到座標（${json.status}）：請嘗試更詳細的地址`)
  }
  const { lat, lng } = json.results[0].geometry.location
  return {
    latitude: lat as number,
    longitude: lng as number,
    formatted: json.results[0].formatted_address as string,
  }
}

export async function updateEventFields(
  id: string,
  fields: {
    start_time?: string
    end_time?: string | null
    venue_name?: string
    latitude?: number
    longitude?: number
    image_captured?: string | null
  }
): Promise<void> {
  const { data, error } = await sb()
    .from('events')
    .update(fields)
    .eq('id', id)
    .select('id')
  if (error) {
    console.error('[updateEventFields] Supabase error:', error.message, '| id:', id, '| fields:', fields)
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    console.error('[updateEventFields] 0 rows affected — RLS may be blocking the update | id:', id)
    throw new Error('更新失敗：無資料被更動，請至 Supabase 確認 RLS Policy 是否允許此操作')
  }
  revalidatePath('/')
  revalidatePath('/admin')
  revalidatePath(`/event/${id}`)
}

export async function insertPlace(payload: Record<string, unknown>): Promise<void> {
  const { error } = await sb().from('places').insert([payload])
  if (error) throw new Error(error.message)
}

export async function insertFood(payload: Record<string, unknown>): Promise<void> {
  const { error } = await sb().from('foods').insert([payload])
  if (error) throw new Error(error.message)
}

export async function deleteEvent(id: string): Promise<void> {
  const { data, error } = await sb().from('events').delete().eq('id', id).select('id')
  if (error) {
    console.error('[deleteEvent] Supabase error:', error.message, '| id:', id)
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    console.error('[deleteEvent] 0 rows affected — RLS may be blocking the delete | id:', id)
    throw new Error('刪除失敗：無資料被更動，請至 Supabase 確認 RLS Policy 是否允許此操作')
  }
  revalidatePath('/')
  revalidatePath('/admin')
}
