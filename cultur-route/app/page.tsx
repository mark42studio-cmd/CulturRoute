import { createClient } from '@supabase/supabase-js';
import EventBrowser from '@/components/EventBrowser';
import ReportIssueModal from '@/components/ReportIssueModal';
import SubmitEventModal from '@/components/SubmitEventModal';
import type { Event } from '@/types';

export const revalidate = 60;

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
    <main className="w-full min-h-screen max-w-7xl mx-auto px-4 pt-12 pb-28 md:pb-12 bg-[#f8f6f0] overflow-x-hidden">
      <header id="tour-home-header" className="mb-8">
        <h1 className="text-3xl font-bold text-slate-800 mb-2 break-words">
          CultureRoute 臺東藝文 - 你若來台東
          <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full ml-3 align-middle font-normal tracking-normal">測試版</span>
        </h1>
        <p className="text-slate-500 text-lg">探索此時此地的文化路徑</p>
      </header>

      <EventBrowser initialEvents={upcomingEvents} />

      {/* 上架/報修入口：置於頁尾，不干擾核心瀏覽動線 */}
      <div id="tour-action-buttons" className="mt-12 pt-8 border-t border-stone-200 flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
        <SubmitEventModal />
        <ReportIssueModal />
      </div>
    </main>
  );
}