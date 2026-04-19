'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function EventError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[EventDetailPage] Server error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white p-8 rounded-2xl shadow-lg max-w-lg w-full border border-red-100">
        <h1 className="text-2xl font-bold text-red-500 mb-3">頁面載入失敗</h1>
        <p className="text-gray-600 text-sm mb-4 leading-relaxed">
          這個活動頁面在載入時發生了錯誤，可能是網路或資料庫暫時問題。
        </p>
        <p className="font-mono text-xs text-gray-400 bg-gray-50 p-3 rounded-lg mb-6 break-all">
          {error.message}
        </p>
        <div className="flex gap-3">
          <button
            onClick={reset}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors"
          >
            重試
          </button>
          <Link
            href="/"
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-xl text-sm font-bold hover:bg-gray-200 transition-colors text-center"
          >
            返回首頁
          </Link>
        </div>
      </div>
    </div>
  );
}
