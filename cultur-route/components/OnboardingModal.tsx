'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export type OnboardingContext = 'explore' | 'itinerary';

interface Props {
  context: OnboardingContext;
  onClose: () => void;
}

const exploreSteps = [
  {
    emoji: '🌊',
    gradient: 'from-sky-400 to-teal-600',
    tag: '步驟 1 — 探索',
    title: '探索在地藝文',
    desc: '滑動查看推薦活動，找到你感興趣的文化路徑。',
  },
  {
    emoji: '➕',
    gradient: 'from-emerald-500 to-teal-700',
    tag: '步驟 2 — 加入行程',
    title: '一鍵加入行程',
    desc: '點擊卡片看詳情，或直接按下右下角的「+」即可加入專屬行程。',
  },
  {
    emoji: '🏷️',
    gradient: 'from-amber-400 to-orange-500',
    tag: '步驟 3 — 篩選',
    title: '分類快速篩選',
    desc: '利用上方的滑動標籤，快速切換市區、海線或演出、展覽。',
  },
];

const itinerarySteps = [
  {
    emoji: '✋',
    gradient: 'from-sky-400 to-teal-600',
    tag: '步驟 1 — 排序',
    title: '拖曳排序行程',
    desc: '長按活動卡片即可上下拖曳排序，或跨天移動（限定演出除外）。',
  },
  {
    emoji: '🕐',
    gradient: 'from-emerald-500 to-teal-700',
    tag: '步驟 2 — 時間',
    title: '彈性修改時間',
    desc: '點擊卡片上的綠色時間文字，可以獨立修改預計停留時間。',
  },
  {
    emoji: '🗑️',
    gradient: 'from-rose-400 to-pink-600',
    tag: '步驟 3 — 管理',
    title: '輕鬆管理活動',
    desc: '若改變心意，點擊卡片右上角的「X」即可將活動移出行程。',
  },
];

export default function OnboardingModal({ context, onClose }: Props) {
  const STEPS = context === 'explore' ? exploreSteps : itinerarySteps;
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-5">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden relative">

        {/* 漸層視覺區 */}
        <div className={`bg-gradient-to-br ${current.gradient} px-6 pt-8 pb-6 flex flex-col items-center text-center`}>
          <span className="text-[10px] font-bold tracking-widest uppercase text-white/70 mb-3">{current.tag}</span>
          <div className="text-6xl leading-none mb-1 drop-shadow-md">{current.emoji}</div>
        </div>

        <button
          onClick={onClose}
          aria-label="關閉"
          className="absolute top-3 right-3 p-1.5 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors"
        >
          <X size={16} />
        </button>

        {/* 文字區 */}
        <div className="px-7 pt-5 pb-7 flex flex-col items-center text-center">
          <h2 className="text-base font-bold text-[#1B2E26] mb-2">{current.title}</h2>
          <p className="text-sm text-gray-500 leading-relaxed mb-5">{current.desc}</p>

          {/* 步驟點 */}
          <div className="flex gap-2 mb-5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`rounded-full transition-all duration-300 ${
                  i === step ? 'w-5 h-2 bg-[#1B2E26]' : 'w-2 h-2 bg-gray-200'
                }`}
              />
            ))}
          </div>

          <button
            onClick={isLast ? onClose : () => setStep(s => s + 1)}
            className="w-full py-3 rounded-2xl bg-[#1B2E26] text-white font-bold text-sm hover:bg-[#243d32] active:scale-95 transition-all shadow-sm"
          >
            {isLast ? '開始體驗 🎉' : '下一步 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
