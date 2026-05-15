'use client';

import { X, AlertTriangle } from 'lucide-react';

interface Props {
  eventTitle: string;
  eventDateDisplay: string;  // e.g. "5月20日"
  tripRangeDisplay: string;  // e.g. "5月15日 ~ 5月17日"
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DateMismatchModal({
  eventTitle,
  eventDateDisplay,
  tripRangeDisplay,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 頂部警告色條 */}
        <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-400" />

        <div className="p-8 space-y-5">
          {/* 關閉按鈕 */}
          <button
            onClick={onCancel}
            className="absolute top-5 right-5 w-8 h-8 rounded-full bg-stone-100 text-stone-500 flex items-center justify-center hover:bg-stone-200 transition-colors"
            aria-label="關閉"
          >
            <X size={15} />
          </button>

          {/* 標頭 */}
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle size={18} className="text-amber-500" />
            </div>
            <div>
              <h3 className="font-bold text-stone-800 text-base tracking-wide">日期不符提醒</h3>
              <p className="text-xs text-stone-400 mt-0.5">此活動的實際舉辦時間不在您的行程內</p>
            </div>
          </div>

          {/* 說明 */}
          <div className="bg-stone-50 rounded-2xl p-4 space-y-2 text-sm">
            <p className="text-stone-700 leading-relaxed">
              《<span className="font-semibold">{eventTitle}</span>》
              限定於{' '}
              <span className="font-bold text-teal-700">{eventDateDisplay}</span>{' '}
              舉辦。
            </p>
            <p className="text-stone-400">
              您目前的行程日期為{' '}
              <span className="text-stone-600">{tripRangeDisplay}</span>。
            </p>
          </div>

          {/* 操作按鈕 */}
          <div className="space-y-2.5 pt-1">
            <button
              onClick={onConfirm}
              className="w-full py-3 px-4 bg-teal-800 text-white text-sm font-medium tracking-wide hover:bg-teal-700 active:scale-[0.98] transition-all rounded-xl"
            >
              將活動加入至 {eventDateDisplay}（自動調整行程）
            </button>
            <button
              onClick={onCancel}
              className="w-full py-3 px-4 bg-stone-100 text-stone-500 text-sm font-medium hover:bg-stone-200 active:scale-[0.98] transition-all rounded-xl"
            >
              取消加入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
