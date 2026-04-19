import Link from 'next/link';

export default function EventNotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white p-8 rounded-2xl shadow-lg max-w-lg w-full border border-gray-100 text-center">
        <p className="text-5xl mb-4">🗺️</p>
        <h1 className="text-2xl font-bold text-gray-800 mb-2">找不到這個活動</h1>
        <p className="text-gray-500 text-sm mb-8 leading-relaxed">
          這個活動可能已下架、或連結已失效。<br />
          回首頁探索其他台東藝文活動吧！
        </p>
        <Link
          href="/"
          className="inline-block px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors"
        >
          回首頁
        </Link>
      </div>
    </div>
  );
}
