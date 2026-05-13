'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { X, MapPin, ExternalLink, Ticket, Car, BedDouble, Link2 } from 'lucide-react';
import AddItineraryButton from '@/components/AddItineraryButton';
import { buildAgodaUrl } from '@/lib/agoda';
import { buildKlookUrl } from '@/lib/klook';
import type { Event } from '@/types';

const EventMapWrapper = dynamic(
  () => import('@/components/EventMapWrapper'),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-stone-50 flex items-center justify-center text-stone-400 text-sm animate-pulse rounded-xl">
        地圖載入中...
      </div>
    ),
  }
);

const formatTime = (timeStr: string) =>
  new Date(timeStr).toLocaleString('zh-TW', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

interface Props {
  event: Event | null;
  onClose: () => void;
}

export default function EventDetailModal({ event, onClose }: Props) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => { setImgError(false); }, [event?.id]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (event) {
      document.body.style.overflow = 'hidden';
    }
    return () => { document.body.style.overflow = ''; };
  }, [event]);

  if (!event) return null;

  const rawImageUrl = event.image_captured || event.engagement_metrics?.image_captured;
  const imageUrl = rawImageUrl ? encodeURI(rawImageUrl) : null;
  const isFbPageUrl = imageUrl != null && (
    /facebook\.com\/(photo|photos|permalink\.php|story)/.test(imageUrl) ||
    (imageUrl.includes('facebook.com') && !imageUrl.includes('fbcdn.net'))
  );
  const showImage = !!(imageUrl && !imgError && !isFbPageUrl);
  const hasMap = typeof event.latitude === 'number' && typeof event.longitude === 'number';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 關閉按鈕 */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-9 h-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition-colors"
          aria-label="關閉"
        >
          <X size={18} />
        </button>

        {/* Hero 圖片 */}
        <div className="relative w-full h-64 bg-stone-900 shrink-0">
          {showImage ? (
            <Image
              src={imageUrl!}
              alt={event.title}
              fill
              className="object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-teal-900 flex items-center justify-center">
              <span className="text-white/20 font-black text-4xl tracking-widest">CultureRoute</span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-6">
            <h2 className="text-2xl font-bold text-white leading-tight mb-1">{event.title}</h2>
            <p className="text-white/80 text-sm">
              {formatTime(event.start_time)}
              {event.end_time && ` ~ ${formatTime(event.end_time)}`}
            </p>
          </div>
        </div>

        {/* 內容區 */}
        <div className="p-6 space-y-6">

          {/* 標籤 */}
          <div className="flex flex-wrap gap-2">
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${event.is_free ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
              {event.is_free ? '免費參加' : '付費活動'}
            </span>
            {event.vibe_tags?.map((tag) => (
              <span key={tag} className="px-3 py-1 rounded-full text-xs bg-stone-100 text-stone-600">
                #{tag.replace(/^#+/, '')}
              </span>
            ))}
          </div>

          {/* 介紹 */}
          <div>
            <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-3">活動介紹</h3>
            <p className="text-stone-700 leading-relaxed whitespace-pre-wrap text-sm">
              {event.long_description || event.description || '目前暫無詳細介紹。'}
            </p>
          </div>

          {/* 行動按鈕 */}
          <div className="space-y-2">
            <AddItineraryButton event={event} />
            {event.ticket_url && (
              <a
                href={event.ticket_url}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-xl font-bold text-sm transition-colors"
              >
                <Ticket size={16} /> 前往購票 / 報名
              </a>
            )}
            {event.source_url && (
              <a
                href={event.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-stone-50 hover:bg-stone-100 text-stone-600 py-2.5 rounded-xl font-bold text-sm transition-colors border border-stone-200"
              >
                <ExternalLink size={16} /> 官方網站
              </a>
            )}
          </div>

          {/* 地點 */}
          <div>
            <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">活動地點</h3>
            <div className="flex items-center gap-2 mb-3">
              <MapPin size={14} className="text-teal-600 shrink-0" />
              <span className="font-bold text-stone-800">{event.venue_name}</span>
            </div>
            {hasMap && (
              <div className="w-full h-48 rounded-xl overflow-hidden border border-stone-200">
                <EventMapWrapper event={event} />
              </div>
            )}
          </div>

          {/* 行程周邊區塊暫時隱藏 */}
          {/* {event.affiliate_links && (
            <div>
              <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-3">行程周邊</h3>
              <div className="flex flex-col gap-2">
                {event.affiliate_links.rental.url && (
                  <a
                    href={buildKlookUrl(event.affiliate_links.rental.url, event.start_time, event.end_time, 'car')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 bg-sky-50 hover:bg-sky-100 text-sky-700 px-4 py-3 rounded-xl font-bold text-sm border border-sky-100 transition-colors"
                  >
                    <Car size={16} className="shrink-0" />{event.affiliate_links.rental.label}
                  </a>
                )}
                {event.affiliate_links.ticket.url && (
                  <a
                    href={buildKlookUrl(event.affiliate_links.ticket.url, event.start_time, event.end_time, 'ticket')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 bg-amber-50 hover:bg-amber-100 text-amber-700 px-4 py-3 rounded-xl font-bold text-sm border border-amber-100 transition-colors"
                  >
                    <Link2 size={16} className="shrink-0" />{event.affiliate_links.ticket.label}
                  </a>
                )}
                <a
                  href={buildAgodaUrl(event.start_time)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 bg-purple-50 hover:bg-purple-100 text-purple-700 px-4 py-3 rounded-xl font-bold text-sm border border-purple-100 transition-colors"
                >
                  <BedDouble size={16} className="shrink-0" />{event.affiliate_links.accommodation.label}
                </a>
              </div>
            </div>
          )} */}
        </div>
      </div>
    </div>
  );
}
