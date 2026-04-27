'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

const STEPS = [
  {
    emoji: '🌊',
    gradient: 'from-sky-400 to-teal-600',
    tag: '歡迎來到台東',
    title: '準備出發台東！',
    desc: '我們已自動把行程日期設為「從今天開始」，快來開始排你的台東文化之旅吧！',
  },
  {
    emoji: '👆',
    gradient: 'from-emerald-500 to-teal-700',
    tag: '自由排序',
    title: '長按卡片，拖拉調整',
    desc: '長按活動卡片並上下拖拉，即可調整當天的參觀順序，打造最順路的山海行程！',
  },
  {
    emoji: '🗺️',
    gradient: 'from-amber-400 to-orange-500',
    tag: '生成路線',
    title: '一鍵生成地圖路線',
    desc: '排好順序後，點擊畫面最下方的「時間確認，生成路線圖」，一鍵規劃最佳移動路線。',
  },
];

export default function OnboardingModal({ onClose }: Props) {
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
