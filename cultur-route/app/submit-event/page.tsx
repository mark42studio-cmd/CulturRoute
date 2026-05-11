'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import SubmitEventFormContent from '@/components/SubmitEventFormContent';

function SubmitEventPage() {
  const router = useRouter();

  return (
    <main className="min-h-screen bg-[#f8f6f0] px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <button
            onClick={() => router.push('/')}
            className="text-slate-500 hover:text-slate-700 text-sm mb-4 flex items-center gap-1 transition-colors"
          >
            ← 返回
          </button>
          <h1 className="text-3xl font-bold text-slate-800 mb-1">投稿活動</h1>
          <p className="text-slate-500">填寫以下資訊，讓更多人知道您的活動！</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-8">
          <SubmitEventFormContent
            onSuccess={() => router.push('/')}
            successButtonLabel="確認，返回首頁"
          />
        </div>
      </div>
    </main>
  );
}

export default function SubmitEventPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f8f6f0]" />}>
      <SubmitEventPage />
    </Suspense>
  );
}
