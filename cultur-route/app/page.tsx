import { createClient } from '@supabase/supabase-js';
import EventBrowser from '@/components/EventBrowser';
import ReportIssueModal from '@/components/ReportIssueModal';
import type { Event } from '@/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const toTaipeiDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

function filterUpcoming(events: Event[]): Event[] {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  return events.filter(event => {
    const effectiveEnd =
      event.end_date ??
      (event.end_time  ? toTaipeiDate(event.end_time)  : null) ??
      (event.start_time ? toTaipeiDate(event.start_time) : null);
    return effectiveEnd === null || effectiveEnd >= today;
  });
}

export default async function Home() {
  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('is_published', true)
    .order('start_time', { ascending: true });

  if (error) return <div className="p-10 text-red-500">哎呀，載入活動失敗了...</div>;

  const upcomingEvents = filterUpcoming(events ?? []);

  return (
    <main className="w-full min-h-screen max-w-7xl mx-auto px-4 py-12 bg-[#f8f6f0] overflow-x-hidden">
      <header id="tour-home-header" className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-8 w-full">
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold text-slate-800 mb-2 break-words">
            CultureRoute 臺東藝文 - 你若來台東
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full ml-3 align-middle font-normal tracking-normal">測試版</span>
          </h1>
          <p className="text-slate-500 text-lg">探索此時此地的文化路徑</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto shrink-0">
          <a
            href="/submit-event"
            className="text-center px-6 py-2.5 rounded-full bg-amber-700 hover:bg-amber-800 text-white text-sm tracking-wide shadow-md transition-all duration-300"
          >
            🎊 我有活動想要上架
          </a>
          <ReportIssueModal />
        </div>
      </header>

      {/* 🌟 把抓到的資料交給 Client Component 去處理互動與篩選 */}
      <EventBrowser initialEvents={upcomingEvents} />
    </main>
  );
}