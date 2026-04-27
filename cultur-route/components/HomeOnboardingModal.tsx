'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export const HOME_ONBOARDING_KEY = 'hasSeenHomeTour_v1';

interface Props {
  onClose: () => void;
}

const STEPS = [
  {
    emoji: '🎪',
    title: '探索台東藝文日常！',
    desc: '這裡匯集了最新的展覽、演出與講座。',
  },
  {
    emoji: '🎯',
    title: '善用分類篩選',
    desc: '點擊上方的分類按鈕，快速找到你有興趣的活動。',
  },
  {
    emoji: '➕',
    title: '加入專屬行程',
    desc: '看到喜歡的活動，點擊右下角的「+」號，就能先收進口袋名單！',
  },
];

export default function HomeOnboardingModal({ onClose }: Props) {
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

        <div className="text-5xl mb-4 leading-none">{current.emoji}</div>
        <h2 className="text-lg font-bold text-[#1B2E26] mb-2">{current.title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-6">{current.desc}</p>

        <div className="flex gap-1.5 mb-6">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${i === step ? 'bg-[#1B2E26]' : 'bg-gray-200'}`}
            />
          ))}
        </div>

        <button
          onClick={isLast ? onClose : () => setStep(s => s + 1)}
          className="w-full py-3 rounded-2xl bg-[#1B2E26] text-white font-bold text-sm hover:bg-[#243d32] active:scale-95 transition-all"
        >
          {isLast ? '開始探索 🎉' : '下一步 →'}
        </button>
      </div>
    </div>
  );
}
