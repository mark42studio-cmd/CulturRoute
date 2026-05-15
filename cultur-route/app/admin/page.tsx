import { createClient } from '@supabase/supabase-js'
import AdminClient, { type AdminEvent } from './AdminClient'

// 每次進入後台都取最新資料，不做靜態快取
export const dynamic = 'force-dynamic'
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default async function AdminPage() {
  // 忽略 is_published，讓後台看到全部活動（含已下架）
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, start_time, end_time, venue_name, latitude, longitude, is_published, image_captured, ticket_url, category, sub_category')
    .order('start_time', { ascending: false })

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-500 font-bold">
        無法載入活動資料：{error.message}
      </div>
    )
  }

  return <AdminClient initialEvents={(events ?? []) as AdminEvent[]} />
}
