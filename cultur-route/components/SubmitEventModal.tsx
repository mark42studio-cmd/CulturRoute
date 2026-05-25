'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import SubmitEventFormContent from './SubmitEventFormContent';

export default function SubmitEventModal() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  function handleClose() {
    setIsOpen(false);
  }

  return (
    <>
      <button
        id="tour-submit-event-btn"
        onClick={() => setIsOpen(true)}
        className="text-center px-6 py-2.5 rounded-full bg-amber-700 hover:bg-amber-800 text-white text-sm tracking-wide shadow-md transition-all duration-300"
      >
        🎊 我有活動想要上架
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-2 sm:p-8"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full sm:max-w-2xl flex flex-col max-h-[calc(100svh-1rem)] sm:max-h-[calc(100svh-4rem)]">

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
              <div>
                <h2 className="font-bold text-gray-800 text-xl">投稿活動</h2>
                <p className="text-xs text-gray-400 mt-0.5">填寫以下資訊，讓更多人知道您的活動！</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6 py-6">
              <SubmitEventFormContent
                onSuccess={handleClose}
                onCancel={handleClose}
                successButtonLabel="關閉"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
