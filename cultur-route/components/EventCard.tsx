import React from 'react';
import Image from 'next/image';
import { Calendar, MapPin } from 'lucide-react';
import type { Event } from '@/types';

interface EventProps {
  event: Event;
  /** 游標滑入時通知父層（用於列表 ↔ 地圖連動） */
  onMouseEnter?: () => void;
  /** 游標滑出時通知父層 */
  onMouseLeave?: () => void;
}

/** 根據活動標題產生一個穩定的色系索引（0–4），讓每張卡的底色不同但固定 */
function getTitleColorIndex(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) & 0xffff;
  }
  return hash % 5;
}

/** 質感預設海報：SVG 背景 + 活動標題大字 */
const DefaultPoster = ({ title, vibe_tags }: { title: string; vibe_tags: string[] }) => {
  const palettes = [
    // 台東海洋藍
    { from: '#0f4c81', to: '#1a7a9a', accent: '#7ecef0', text: '#e8f6fc' },
    // 都蘭暮色橙
    { from: '#7c3600', to: '#c85a00', accent: '#f4a940', text: '#fff8ed' },
    // 縱谷翠綠
    { from: '#1a4731', to: '#2e7d52', accent: '#7ec8a4', text: '#edfaf3' },
    // 原民赭紅
    { from: '#6b1c1c', to: '#a03030', accent: '#e88c6c', text: '#fdf2ee' },
    // 太平洋紫暮
    { from: '#2d1b69', to: '#5b3fa0', accent: '#b39ddb', text: '#f3f0ff' },
  ];
  const p = palettes[getTitleColorIndex(title)];
  // 取第一個 vibe tag 作為副標
  const tag = vibe_tags?.[0]?.replace(/^#+/, '') ?? '台東藝文';
  // 取標題前 8 字顯示在海報上
  const short = title.length > 8 ? title.slice(0, 8) : title;

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden select-none"
      style={{ background: `linear-gradient(135deg, ${p.from} 0%, ${p.to} 100%)` }}
      aria-label={title}
    >
      {/* 裝飾幾何圓 */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 224" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <circle cx="340" cy="30"  r="90"  fill={p.accent} fillOpacity="0.12" />
        <circle cx="60"  cy="190" r="70"  fill={p.accent} fillOpacity="0.10" />
        <circle cx="200" cy="112" r="130" fill="white"    fillOpacity="0.03" />
        {/* 細格線質感 */}
        <line x1="0" y1="56"  x2="400" y2="56"  stroke={p.accent} strokeOpacity="0.08" strokeWidth="1" />
        <line x1="0" y1="168" x2="400" y2="168" stroke={p.accent} strokeOpacity="0.08" strokeWidth="1" />
      </svg>

      {/* 主文字區 */}
      <div className="relative z-10 flex flex-col items-center gap-2 px-6 text-center">
        <span
          className="font-black leading-tight tracking-tight"
          style={{ color: p.text, fontSize: 'clamp(1.4rem, 4vw, 2rem)', textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}
        >
          {short}
        </span>
        <span
          className="text-xs font-semibold tracking-[0.2em] uppercase px-3 py-1 rounded-full"
          style={{ background: `${p.accent}30`, color: p.accent, border: `1px solid ${p.accent}60` }}
        >
          {tag}
        </span>
      </div>

      {/* 底部品牌水印 */}
      <span
        className="absolute bottom-3 right-4 text-[10px] font-bold tracking-widest uppercase opacity-40"
        style={{ color: p.text }}
      >
        CultureRoute
      </span>
    </div>
  );
};

const EventCard = ({ event, onMouseEnter, onMouseLeave }: EventProps) => {
  const rawImageUrl = event.image_captured || event.engagement_metrics?.image_captured;
  const imageUrl = rawImageUrl ? encodeURI(rawImageUrl) : null;
  const [imgError, setImgError] = React.useState(false);

  // 在 render 前攔截明確是 HTML 頁面而非圖檔的 URL
  // facebook.com/photo、/photos、/permalink、/story 等都是頁面連結，無法當 <img src>
  // fbcdn.net 才是真正的圖片 CDN，允許通過
  const isFbPageUrl = imageUrl != null && (
    /facebook\.com\/(photo|photos|permalink\.php|story)/.test(imageUrl) ||
    (imageUrl.includes('facebook.com') && !imageUrl.includes('fbcdn.net'))
  );

  const showDefault = !imageUrl || imgError || isFbPageUrl;

  return (
    <div
      className="flex flex-col h-full w-full min-w-0 bg-white rounded-3xl relative group overflow-hidden shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all duration-500 ease-in-out"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >

      {/* ── 圖片區：固定高度，不壓縮 ── */}
      <div className="relative h-56 shrink-0 w-full overflow-hidden rounded-t-3xl bg-stone-900">
        {!showDefault && imageUrl ? (
          <Image
            src={imageUrl}
            alt={event.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            onError={() => setImgError(true)}
          />
        ) : (
          <DefaultPoster title={event.title} vibe_tags={event.vibe_tags} />
        )}

        {/* 底部漸層 */}
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />

        {/* 右上角徽章（absolute 僅在圖片容器內） */}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 items-end">
{event.is_free && (
            <div className="bg-teal-800/90 backdrop-blur-sm text-white px-2.5 py-0.5 text-[10px] font-medium tracking-wider">
              免費
            </div>
          )}
        </div>
      </div>

      {/* ── 內容區：純正 flex-col，用 gap 分隔，絕不使用 absolute ── */}
      <div className="flex flex-col flex-1 p-5 gap-3">

        {/* 標籤：膠囊狀 */}
        <div className="flex flex-wrap gap-2">
          {event.vibe_tags?.map((tag) => (
            <span key={tag} className="px-3 py-1 rounded-full bg-stone-50 border border-stone-100 text-stone-500 text-xs tracking-wide">
              {tag.replace(/^#+/, '')}
            </span>
          ))}
        </div>

        {/* 標題 */}
        <h3 className="text-xl font-serif font-bold text-stone-800 leading-snug line-clamp-2 break-words group-hover:text-teal-800 transition-colors">
          {event.title}
        </h3>

        {/* 內文 */}
        <p className="text-sm text-stone-600 line-clamp-2 leading-relaxed">
          {event.description}
        </p>

        {/* 底部 Meta：日期 + 地點，推到卡片最下方 */}
        <div className="mt-auto pt-4 border-t border-stone-200 space-y-2">
          <div className="flex items-center text-stone-400 text-xs gap-2">
            <Calendar size={12} className="shrink-0" />
            {event.end_date ? (
              <span>
                {new Date(event.start_time).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric' })}
                {' – '}
                {new Date(event.end_date).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric' })}
              </span>
            ) : (
              <span>{new Date(event.start_time).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric' })}</span>
            )}
          </div>
          <div className="flex items-center text-stone-400 text-xs gap-2">
            {(() => {
              const hasCoords = typeof event.latitude === 'number' && typeof event.longitude === 'number';
              return (
                <>
                  <MapPin size={12} className={`shrink-0 ${hasCoords ? '' : 'text-stone-300'}`} />
                  <span className="line-clamp-1 flex-1">{event.venue_name}</span>
                  {!hasCoords && (
                    <span className="shrink-0 text-[10px] text-stone-300 italic">尚無地圖標記</span>
                  )}
                </>
              );
            })()}
          </div>
        </div>

      </div>
    </div>
  );
};

export default EventCard;