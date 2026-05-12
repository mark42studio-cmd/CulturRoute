'use client'

import Image from 'next/image'
import { useState, useTransition, useEffect } from 'react'
import { rejectSubmission, getSubmissions } from './actions'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

type Submission = {
  id: string
  title: string
  raw_date: string | null
  start_date: string | null
  end_date: string | null
  location: string
  description: string
  image_url: string | null
  ticket_url: string | null
  comments: string | null
  created_at: string
  status: 'pending' | 'approved' | 'rejected'
}

type Filter = 'pending' | 'approved' | 'rejected' | 'all'

const FILTERS: { key: Filter; label: (n: number) => string; active: string; base: string }[] = [
  { key: 'pending',  label: n => `待處理 (${n})`, active: 'bg-indigo-600 text-white', base: 'bg-white text-indigo-600 border border-indigo-200' },
  { key: 'approved', label: () => '已核准',        active: 'bg-green-500 text-white',  base: 'bg-white text-green-600 border border-green-200' },
  { key: 'rejected', label: () => '已拒絕',        active: 'bg-red-400 text-white',    base: 'bg-white text-red-500 border border-red-200' },
  { key: 'all',      label: () => '全部',          active: 'bg-slate-700 text-white',  base: 'bg-white text-gray-500 border border-gray-200' },
]

export default function SubmissionsClient() {
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('pending')
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getSubmissions().then(({ data }) => {
      setSubmissions((data ?? []) as Submission[])
      setLoading(false)
    })
  }, [])

  const handleApprove = async (id: string) => {
    setLoadingId(id)
    try {
      const res = await fetch('/api/submissions/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: id }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        alert(`核准失敗：${data.error ?? '請稍後再試'}`)
      } else {
        setSubmissions(prev => prev.map(s => s.id === id ? { ...s, status: 'approved' } : s))
      }
    } catch {
      alert('網路錯誤，請重試')
    } finally {
      setLoadingId(null)
    }
  }

  const handleReject = (id: string) => {
    startTransition(async () => {
      const res = await rejectSubmission(id)
      if (res.error) {
        alert(`拒絕失敗：${res.error}`)
      } else {
        setSubmissions(prev => prev.map(s => s.id === id ? { ...s, status: 'rejected' } : s))
      }
    })
  }

  const pendingCount = submissions.filter(s => s.status === 'pending').length
  const filtered = filter === 'all' ? submissions : submissions.filter(s => s.status === filter)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
        <Loader2 size={16} className="animate-spin" /> 載入中...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold text-gray-800">活動投稿審核</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          待處理：{pendingCount} 件・共 {submissions.length} 件
        </p>
      </div>

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map(({ key, label, active, base }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors ${filter === key ? active : base}`}
          >
            {label(pendingCount)}
          </button>
        ))}
      </div>

      {/* Cards */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400 border-2 border-dashed border-gray-200 rounded-2xl">
          <span className="text-4xl mb-3">📭</span>
          <p className="font-semibold text-sm">此分類沒有資料</p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(item => (
            <div key={item.id} className="bg-white rounded-2xl border shadow-sm flex flex-col overflow-hidden">
              <ImageCell src={item.image_url} alt={item.title} />

              <div className="p-4 flex flex-col gap-2 flex-1">
                <h3 className="font-bold text-gray-900 text-base leading-snug">{item.title}</h3>
                <p className="text-xs text-gray-500">⏰ {item.raw_date ?? '—'}</p>
                {(item.start_date || item.end_date) && (
                  <p className="text-xs text-blue-400">
                    🗓 {item.start_date ?? '?'}{item.end_date && item.end_date !== item.start_date ? ` ～ ${item.end_date}` : ''}
                  </p>
                )}
                <p className="text-xs text-gray-500">📍 {item.location}</p>
                <p className="text-sm text-gray-600 line-clamp-3 mt-1">{item.description}</p>
                {item.ticket_url && (
                  <a href={item.ticket_url} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 underline break-all">
                    🎟️ {item.ticket_url}
                  </a>
                )}
                {item.comments && (
                  <p className="text-xs text-gray-400 italic border-t border-gray-100 pt-2 mt-1">💬 {item.comments}</p>
                )}
                <p className="text-[10px] text-gray-300 mt-auto pt-2" suppressHydrationWarning>
                  {new Date(item.created_at).toLocaleString('zh-TW')}
                </p>
              </div>

              <div className="border-t p-3 flex gap-2">
                {item.status === 'approved' ? (
                  <div className="flex-1 text-center text-sm font-semibold py-1.5 rounded-xl text-green-600 bg-green-50">
                    ✅ 已核准
                  </div>
                ) : item.status === 'rejected' ? (
                  <div className="flex-1 text-center text-sm font-semibold py-1.5 rounded-xl text-red-500 bg-red-50">
                    ❌ 已拒絕
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => handleApprove(item.id)}
                      disabled={loadingId === item.id || isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-green-500 text-white text-sm font-bold rounded-xl hover:bg-green-600 transition-colors disabled:opacity-40"
                    >
                      {loadingId === item.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                      核准
                    </button>
                    <button
                      onClick={() => handleReject(item.id)}
                      disabled={isPending || loadingId === item.id}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-red-100 text-red-600 text-sm font-bold rounded-xl hover:bg-red-200 transition-colors disabled:opacity-40"
                    >
                      <XCircle size={13} />
                      拒絕
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ImageCell({ src, alt }: { src: string | null; alt: string }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return (
      <div className="h-40 bg-gray-100 flex items-center justify-center text-gray-300 text-3xl select-none">
        🖼️
      </div>
    )
  }
  return (
    <div className="relative h-40 bg-gray-100">
      <Image
        src={src}
        alt={alt}
        fill
        className="object-cover"
        onError={() => setBroken(true)}
        sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw"
        unoptimized
      />
    </div>
  )
}
