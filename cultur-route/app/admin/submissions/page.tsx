import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import SubmissionsClient from './SubmissionsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default async function SubmissionsPage() {
  const { data, error } = await supabase
    .from('pending_events')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-500 font-bold">
        無法載入申請資料：{error.message}
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-[#f8f6f0] p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">🎉 活動上架申請審核</h1>
            <p className="text-sm text-gray-500 mt-1">待審核：{data?.length ?? 0} 件</p>
          </div>
          <Link
            href="/admin"
            className="text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-4 py-2 bg-white transition-colors"
          >
            ← 返回後台
          </Link>
        </div>
        <SubmissionsClient items={data ?? []} />
      </div>
    </main>
  )
}
