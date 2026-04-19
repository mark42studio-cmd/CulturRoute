import { notFound } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';

// 活動詳細頁：總是從 DB 即時讀取，不做靜態快取
export const dynamic = 'force-dynamic';
import { ArrowLeft, ExternalLink, Ticket, Car, BedDouble, Link2 } from 'lucide-react';
import AddItineraryButton from '@/components/AddItineraryButton';
import EventMapWrapper from '@/components/EventMapWrapper';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// 🌟 1. 修正 TypeScript 定義：Next.js 15 的 params 必須是 Promise
interface EventPageProps {
  params: Promise<{ id: string }>;
}

export default async function EventDetailPage({ params }: EventPageProps) {
  // 🌟 2. 關鍵修正：必須先 await 解開 params，才能取得 id！
  const resolvedParams = await params;
  const id = resolvedParams.id;

  const { data: event, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', id)
    .eq('is_published', true)
    .single();

  if (error || !event) {
    // Supabase 查無資料或網路錯誤 → 顯示 Next.js 404 頁面
    notFound();
  }

  const formatTime = (timeStr: string) => new Date(timeStr).toLocaleString('zh-TW', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  return (
    <main className="min-h-screen bg-gray-50 pb-20">
      
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-200 fixed top-0 w-full z-40">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center">
          <Link href="/" className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors flex items-center gap-2 font-bold text-sm">
            <ArrowLeft size={18} /> 返回首頁
          </Link>
        </div>
      </header>

      <section className="relative w-full h-[50vh] min-h-[400px] pt-16">
        {event.image_captured ? (
          <Image
            src={event.image_captured}
            alt={event.title}
            fill
            className="object-cover"
            priority
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-900 to-slate-800 flex items-center justify-center">
            <span className="text-white/30 font-bold text-xl tracking-widest uppercase">CulturRoute</span>
          </div>
        )}
        
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent flex flex-col justify-end p-6 md:p-12 pb-16">
          <div className="max-w-5xl mx-auto w-full">
            <h1 className="text-3xl md:text-5xl font-bold text-white mb-3 leading-tight drop-shadow-lg">
              {event.title}
            </h1>
            <p className="text-white/90 text-lg font-medium drop-shadow-md">
              {formatTime(event.start_time)} ~ {formatTime(event.end_time || event.start_time)}
            </p>
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 mt-8 grid grid-cols-1 md:grid-cols-3 gap-8 relative z-10 -mt-10">
        
        <div className="md:col-span-2 space-y-8">
          <section className="flex flex-wrap gap-3 bg-white p-6 rounded-2xl shadow-sm">
            <span className={`px-4 py-1.5 rounded-full text-sm font-bold shadow-sm ${event.is_free ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
              {event.is_free ? '免費參加' : '付費活動'}
            </span>
            
            {event.weather_resilience && (
               <span className="px-4 py-1.5 rounded-full text-sm font-bold bg-blue-50 text-blue-700 border border-blue-100 shadow-sm">
                氣候韌性: {event.weather_resilience}/5
              </span>
            )}

            {event.vibe_tags?.map((tag: string) => (
              <span key={tag} className="px-4 py-1.5 rounded-full text-sm font-medium bg-gray-100 text-gray-600">
                #{tag.replace(/^#+/, '')}
              </span>
            ))}
          </section>

          <section className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
            <h2 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
              活動介紹
            </h2>
            <div className="text-gray-600 leading-relaxed whitespace-pre-wrap text-lg">
              {event.long_description || event.description || '目前暫無詳細介紹。'}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="bg-white p-6 rounded-2xl shadow-lg border border-gray-100 sticky top-24">
            
            <div className="mb-6 space-y-3">
              <AddItineraryButton event={event} />
              
              {event.ticket_url && (
                <a href={event.ticket_url} target="_blank" rel="noopener noreferrer" className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 text-white py-3 rounded-xl font-bold transition-colors shadow-sm">
                  <Ticket size={18} /> 前往購票 / 報名
                </a>
              )}
              
              {event.source_url && (
                <a href={event.source_url} target="_blank" rel="noopener noreferrer" className="w-full flex items-center justify-center gap-2 bg-gray-50 hover:bg-gray-100 text-gray-600 py-3 rounded-xl font-bold transition-colors border border-gray-200">
                  <ExternalLink size={18} /> 官方網站
                </a>
              )}
            </div>

            <hr className="my-6 border-gray-100" />

            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">活動地點</h2>
            <p className="text-gray-800 font-bold mb-4 text-lg">{event.venue_name}</p>
            
            <div className="w-full h-56 rounded-xl overflow-hidden border border-gray-200 shadow-inner">
              <EventMapWrapper event={event} />
            </div>
            
            <div className="mt-4 text-xs text-gray-400 font-mono bg-gray-50 p-2 rounded text-center">
              GPS: {event.latitude}, {event.longitude}
            </div>

            {/* 行程周邊（分潤連結） — 只要有任一 url 才顯示整個區塊 */}
            {event.affiliate_links && (event.affiliate_links.rental.url || event.affiliate_links.ticket.url || event.affiliate_links.accommodation.url) && (
              <>
                <hr className="my-6 border-gray-100" />
                <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-3">行程周邊</h2>
                <div className="flex flex-col gap-2">
                  {event.affiliate_links.rental.url && (
                    <a
                      href={event.affiliate_links.rental.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full flex items-center gap-3 bg-sky-50 hover:bg-sky-100 text-sky-700 px-4 py-3 rounded-xl font-bold text-sm transition-colors border border-sky-100"
                    >
                      <Car size={16} className="shrink-0" />
                      {event.affiliate_links.rental.label}
                    </a>
                  )}
                  {event.affiliate_links.ticket.url && (
                    <a
                      href={event.affiliate_links.ticket.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full flex items-center gap-3 bg-amber-50 hover:bg-amber-100 text-amber-700 px-4 py-3 rounded-xl font-bold text-sm transition-colors border border-amber-100"
                    >
                      <Link2 size={16} className="shrink-0" />
                      {event.affiliate_links.ticket.label}
                    </a>
                  )}
                  {event.affiliate_links.accommodation.url && (
                    <a
                      href={event.affiliate_links.accommodation.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full flex items-center gap-3 bg-purple-50 hover:bg-purple-100 text-purple-700 px-4 py-3 rounded-xl font-bold text-sm transition-colors border border-purple-100"
                    >
                      <BedDouble size={16} className="shrink-0" />
                      {event.affiliate_links.accommodation.label}
                    </a>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

      </div>
    </main>
  );
}