'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export const HOME_ONBOARDING_KEY = 'hasSeenHomeTour_v1';

interface Props {
  onClose: () => void;
}

const STEPS = [
  {
    emoji: '🏔️',
    gradient: 'from-emerald-500 to-teal-700',
    tag: '台東山海日常',
    title: '探索台東藝文日常！',
    desc: '這裡匯集了最新的展覽、演出與講座，帶你感受台東山海之間的文化溫度。',
  },
  {
    emoji: '🎭',
    gradient: 'from-violet-400 to-purple-600',
    tag: '快速找活動',
    title: '善用分類篩選',
    desc: '點擊上方的分類按鈕，快速找到你感興趣的活動類型。',
  },
  {
    emoji: '📌',
    gradient: 'from-rose-400 to-orange-400',
    tag: '收進口袋名單',
    title: '加入專屬行程',
    desc: '看到喜歡的活動，點擊右下角的「+」號，就能先收進口袋名單，再前往行程頁整理！',
  },
];

export default function HomeOnboardingModal({ onClose }: Props) {
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
            {isLast ? '開始探索 🎉' : '下一步 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
