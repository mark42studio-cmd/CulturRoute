import { createClient } from '@supabase/supabase-js';
import EventBrowser from '@/components/EventBrowser'; // 🌟 引入新做的瀏覽器元件

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default async function Home() {
  // 伺服器端依然負責最快速度抓取資料
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('is_published', true)
    .order('start_time', { ascending: true });

  if (error) return <div className="p-10 text-red-500">哎呀，載入活動失敗了...</div>;

  return (
    <main className="min-h-screen max-w-7xl mx-auto px-4 py-12 bg-[#f8f6f0]">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-slate-800 mb-2">CulturRoute 臺東藝文 - 你若來台東</h1>
        <p className="text-slate-500 text-lg">探索此時此地的文化路徑</p>
      </header>

      {/* 🌟 把抓到的資料交給 Client Component 去處理互動與篩選 */}
      <EventBrowser initialEvents={events || []} />
    </main>
  );
}