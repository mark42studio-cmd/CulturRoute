import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 py-20 text-center">
      <p className="text-6xl font-bold text-slate-200">404</p>
      <h1 className="text-xl font-semibold text-slate-700">找不到這個頁面</h1>
      <p className="text-slate-500 text-sm">頁面不存在或已移除。</p>
      <Link
        href="/"
        className="mt-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors"
      >
        回首頁
      </Link>
    </main>
  );
}
