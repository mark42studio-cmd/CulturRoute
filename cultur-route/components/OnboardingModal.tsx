'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

const STEPS = [
  {
    emoji: '🌿',
    title: '慢活台東，從這裡開始',
    desc: '系統已根據你的旅遊日期，自動將活動分配到每一天的分頁，讓你清楚看到整趟行程的節奏。',
  },
  {
    emoji: '✋',
    title: '拖拉卡片，自由排序',
    desc: '長按活動卡片並上下拖拉，即可調整當天的參觀順序，打造最順路的行程！',
  },
  {
    emoji: '🗺️',
    title: '按下方按鈕，生成地圖路線',
    desc: '排好順序後，點擊畫面最下方的「時間確認，生成路線圖」，一鍵規劃最佳移動路線。',
  },
];

export default function OnboardingModal({ onClose }: Props) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-5">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-7 flex flex-col items-center text-center relative">
        <button
          onClick={onClose}
          aria-label="關閉"
          className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X size={18} />
        </button>

        {/* Emoji icon */}
        <div className="text-5xl mb-4 leading-none">{current.emoji}</div>

        {/* Title */}
        <h2 className="text-lg font-bold text-[#1B2E26] mb-2">{current.title}</h2>

        {/* Description */}
        <p className="text-sm text-gray-500 leading-relaxed mb-6">{current.desc}</p>

        {/* Step dots */}
        <div className="flex gap-1.5 mb-6">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${i === step ? 'bg-[#1B2E26]' : 'bg-gray-200'}`}
            />
          ))}
        </div>

        {/* CTA button */}
        <button
          onClick={isLast ? onClose : () => setStep(s => s + 1)}
          className="w-full py-3 rounded-2xl bg-[#1B2E26] text-white font-bold text-sm hover:bg-[#243d32] active:scale-95 transition-all"
        >
          {isLast ? '開始體驗 🎉' : '下一步 →'}
        </button>
      </div>
    </div>
  );
}
