'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { rejectSubmission } from './actions'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

type PendingEvent = {
  id: string
  title: string
  raw_date: string | null
  start_date: string | null
  end_date: string | null
  location: string
  description: string
  image_url: string | null
  comments: string | null
  created_at: string
}

export default function SubmissionsClient({ items }: { items: PendingEvent[] }) {
  const router = useRouter()
  const [results, setResults] = useState<Record<string, string>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

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
        setResults(prev => ({ ...prev, [id]: `error:${data.error ?? '核准失敗'}` }))
      } else {
        setResults(prev => ({ ...prev, [id]: 'approved' }))
        router.refresh()
      }
    } catch {
      setResults(prev => ({ ...prev, [id]: 'error:網路錯誤，請重試' }))
    } finally {
      setLoadingId(null)
    }
  }

  const handleReject = (id: string) => {
    startTransition(async () => {
      const res = await rejectSubmission(id)
      setResults(prev => ({ ...prev, [id]: res.error ? `error:${res.error}` : 'rejected' }))
    })
  }

  const backLink = (
    <Link
      href="/admin"
      className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-4 py-2 bg-white transition-colors mb-6"
    >
      ⬅️ 返回主後台
    </Link>
  )

  if (items.length === 0) {
    return (
      <>
        {backLink}
        <div className="flex flex-col items-center justify-center py-24 text-gray-400">
          <span className="text-5xl mb-4">📭</span>
          <p className="font-semibold">目前沒有待審核的申請</p>
        </div>
      </>
    )
  }

  return (
    <>
      {backLink}
    <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(item => {
        const result = results[item.id]
        const isDone = result === 'approved' || result === 'rejected'
        const isError = result?.startsWith('error:')

        return (
          <div
            key={item.id}
            className={`bg-white rounded-2xl border shadow-sm flex flex-col overflow-hidden transition-opacity ${isDone ? 'opacity-60' : ''}`}
          >
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
              {item.comments && (
                <p className="text-xs text-gray-400 italic border-t border-gray-100 pt-2 mt-1">
                  💬 {item.comments}
                </p>
              )}
              <p className="text-[10px] text-gray-300 mt-auto pt-2" suppressHydrationWarning>
                {new Date(item.created_at).toLocaleString('zh-TW')}
              </p>
            </div>

            <div className="border-t p-3 flex gap-2">
              {isDone ? (
                <div
                  className={`flex-1 text-center text-sm font-semibold py-1.5 rounded-xl ${
                    result === 'approved' ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-50'
                  }`}
                >
                  {result === 'approved' ? '✅ 已核准' : '❌ 已拒絕'}
                </div>
              ) : isError ? (
                <p className="flex-1 text-xs text-red-500 py-1">{result.replace('error:', '')}</p>
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
                    disabled={isPending}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-red-100 text-red-600 text-sm font-bold rounded-xl hover:bg-red-200 transition-colors disabled:opacity-40"
                  >
                    <XCircle size={13} />
                    拒絕
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
    </>
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
