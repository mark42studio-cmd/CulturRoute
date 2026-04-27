'use server'

import { createClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import {
  validate,
  TogglePublishedSchema,
  GeocodeAddressSchema,
  UpdateEventFieldsSchema,
  InsertPlaceSchema,
  InsertFoodSchema,
  DeleteEventSchema,
} from '@/lib/validation'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export async function togglePublished(id: string, current: boolean): Promise<void> {
  const { id: safeId } = validate(TogglePublishedSchema, { id, current });

  const { error } = await sb()
    .from('events')
    .update({ is_published: !current })
    .eq('id', safeId)
  if (error) throw new Error(error.message)
  revalidatePath('/')
  revalidatePath('/admin')
}

export async function geocodeAddress(address: string): Promise<{
  latitude: number
  longitude: number
  formatted: string
}> {
  const { address: safeAddress } = validate(GeocodeAddressSchema, { address });

  const key = process.env.GOOGLE_MAPS_API_KEY
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(safeAddress)}&key=${key}`
  const res = await fetch(url)
  const json = await res.json()
  if (json.status !== 'OK' || !json.results?.[0]) {
    console.error('[geocodeAddress] Google API error:', json.status, json.error_message ?? '', '| query:', safeAddress)
    throw new Error(`找不到座標（${json.status}）：請嘗試更詳細的地址`)
  }
  const { lat, lng } = json.results[0].geometry.location
  return {
    latitude:  lat as number,
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
  // .strict() Schema 確保 fields 只能包含白名單欄位，防止欄位注入
  const { id: safeId, fields: safeFields } = validate(UpdateEventFieldsSchema, { id, fields });

  const { data, error } = await sb()
    .from('events')
    .update(safeFields)
    .eq('id', safeId)
    .select('id')
  if (error) {
    console.error('[updateEventFields] Supabase error:', error.message, '| id:', safeId)
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    console.error('[updateEventFields] 0 rows affected — RLS may be blocking the update | id:', safeId)
    throw new Error('更新失敗：無資料被更動，請至 Supabase 確認 RLS Policy 是否允許此操作')
  }
  revalidatePath('/')
  revalidatePath('/admin')
  revalidatePath(`/event/${safeId}`)
}

export async function insertPlace(payload: Record<string, unknown>): Promise<void> {
  // .strip() 靜默移除白名單外欄位，避免未知欄位寫入 DB
  const safePayload = validate(InsertPlaceSchema, payload);

  const { error } = await sb().from('places').insert([safePayload])
  if (error) throw new Error(error.message)
}

export async function insertFood(payload: Record<string, unknown>): Promise<void> {
  const safePayload = validate(InsertFoodSchema, payload);

  const { error } = await sb().from('foods').insert([safePayload])
  if (error) throw new Error(error.message)
}

export async function deleteEvent(id: string): Promise<void> {
  const { id: safeId } = validate(DeleteEventSchema, { id });

  const { data, error } = await sb().from('events').delete().eq('id', safeId).select('id')
  if (error) {
    console.error('[deleteEvent] Supabase error:', error.message, '| id:', safeId)
    throw new Error(error.message)
  }
  if (!data || data.length === 0) {
    console.error('[deleteEvent] 0 rows affected — RLS may be blocking the delete | id:', safeId)
    throw new Error('刪除失敗：無資料被更動，請至 Supabase 確認 RLS Policy 是否允許此操作')
  }
  revalidatePath('/')
  revalidatePath('/admin')
}

// ── Affiliate Links ───────────────────────────────────────────────────────────

export type AffiliateLink = {
  id: string
  key: string
  label: string
  url: string | null
  icon: string
  is_active: boolean
}

export async function getAffiliateLinks(): Promise<AffiliateLink[]> {
  const { data, error } = await sb()
    .from('affiliate_links')
    .select('*')
    .order('key')
  if (error) throw new Error(error.message)
  return (data ?? []) as AffiliateLink[]
}

export async function upsertAffiliateLink(
  link: Omit<AffiliateLink, 'id'>
): Promise<void> {
  const { error } = await sb()
    .from('affiliate_links')
    .upsert([link], { onConflict: 'key' })
  if (error) throw new Error(error.message)
  revalidatePath('/admin')
}
