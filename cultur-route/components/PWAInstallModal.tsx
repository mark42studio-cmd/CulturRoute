'use client';

import { useEffect, useState } from 'react';
import { X, AlertTriangle, Smartphone } from 'lucide-react';
import { usePWAInstall, type BrowserType } from '@/hooks/usePWAInstall';

type TabId = 'ios-safari' | 'ios-chrome' | 'android';

const TABS: { id: TabId; label: string; sublabel: string }[] = [
  { id: 'ios-safari', label: 'iPhone / iPad', sublabel: 'Safari' },
  { id: 'ios-chrome', label: 'iPhone / iPad', sublabel: 'Chrome' },
  { id: 'android',    label: 'Android',       sublabel: 'Chrome' },
];

const STEPS: Record<TabId, { icon: string; text: string; sub?: string }[]> = {
  'ios-safari': [
    { icon: '📤', text: '點擊底部工具列的「分享」按鈕' },
    { icon: '➕', text: '向下滑動清單，點擊「加入主畫面」' },
  ],
  'ios-chrome': [
    { icon: '📤', text: '點擊網址列右側的「分享」按鈕' },
    { icon: '➕', text: '向下滑動清單，點擊「加入主畫面」' },
  ],
  android: [
    { icon: '⋮', text: '點擊網址列右側的「選單」按鈕' },
    {
      icon: '📥',
      text: '選擇「加到主畫面」，即可在桌面看到 App 圖示',
      sub: '若出現「主畫面已鎖定」，請長按桌面空白處，進入桌面設定關閉鎖定後再試一次',
    },
  ],
};

function toTabId(b: BrowserType): TabId {
  if (b === 'ios-chrome') return 'ios-chrome';
  if (b === 'android') return 'android';
  return 'ios-safari';
}

export default function PWAInstallModal() {
  const { browserType, isStandalone } = usePWAInstall();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('ios-safari');

  useEffect(() => {
    setActiveTab(toTabId(browserType));
  }, [browserType]);

  // 已安裝為 App 時不顯示觸發按鈕
  if (isStandalone) return null;

  const steps = STEPS[activeTab];
  const isNonNative = browserType === 'non-native';

  return (
    <>
      {/* 觸發按鈕 — 供 Tour Step 4 高亮 */}
      <button
        id="tour-pwa-install-btn"
        onClick={() => setIsOpen(true)}
        aria-label="安裝 CulturRoute 為 App"
        title="安裝為 App"
        className="fixed right-4 bottom-[9rem] md:bottom-[9rem] z-50 bg-white text-[#1B2E26] border border-stone-200 shadow-md hover:shadow-lg hover:scale-105 active:scale-95 transition-all duration-200 flex items-center gap-1.5 px-3 py-2.5 rounded-full text-sm font-medium"
      >
        <Smartphone size={16} className="shrink-0" />
        <span className="hidden sm:inline">安裝 App</span>
      </button>

      {/* 彈窗 */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}
        >
          <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full sm:max-w-md overflow-hidden">

            {/* 標題漸層區 */}
            <div className="bg-gradient-to-br from-teal-500 to-emerald-700 px-6 pt-7 pb-5 text-white relative">
              <button
                onClick={() => setIsOpen(false)}
                aria-label="關閉"
                className="absolute top-4 right-4 p-1.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
              >
                <X size={16} />
              </button>
              <div className="flex items-center gap-3 mb-1">
                <Smartphone size={20} className="shrink-0" />
                <h2 className="text-lg font-bold">安裝 CulturRoute 捷徑</h2>
              </div>
              <p className="text-sm text-teal-100 leading-relaxed">
                享受宛如原生 App 的全螢幕流暢體驗！
              </p>
            </div>

            {/* 非原生瀏覽器警告 */}
            {isNonNative && (
              <div className="mx-4 mt-4 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  建議使用 <strong>Safari</strong> 或 <strong>Chrome</strong> 開啟此頁面，以獲得最佳安裝體驗。
                </p>
              </div>
            )}

            {/* 分頁標籤 */}
            <div className="flex border-b border-stone-200 px-4 pt-4 gap-1">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'flex-1 pb-2.5 text-center text-xs font-medium transition-all',
                    activeTab === tab.id
                      ? 'text-teal-700 border-b-2 border-teal-600'
                      : 'text-stone-400 hover:text-stone-600',
                  ].join(' ')}
                >
                  <div>{tab.label}</div>
                  <div className="text-[10px] opacity-75">{tab.sublabel}</div>
                </button>
              ))}
            </div>

            {/* 步驟列表 */}
            <div className="px-6 py-5 space-y-4">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div className="shrink-0 w-9 h-9 rounded-full bg-teal-50 border border-teal-100 flex items-center justify-center text-lg">
                    {step.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-stone-700 leading-relaxed">
                      <span className="text-xs text-teal-600 font-semibold mr-1.5">步驟 {i + 1}</span>
                      {step.text}
                    </p>
                    {step.sub && (
                      <p className="mt-1.5 text-[11px] text-stone-400 leading-relaxed">{step.sub}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* 底部按鈕（含 safe area） */}
            <div
              className="px-6 pt-0 pb-7"
              style={{ paddingBottom: 'max(1.75rem, env(safe-area-inset-bottom))' }}
            >
              <button
                onClick={() => setIsOpen(false)}
                className="w-full py-3 rounded-2xl bg-[#1B2E26] text-white font-bold text-sm hover:bg-[#243d32] active:scale-95 transition-all"
              >
                知道了 ✓
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
