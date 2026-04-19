/**
 * 行程匯出工具
 * - generateICS / downloadICS : 產生符合 RFC 5545 的 .ics 檔（純 Vanilla JS，無額外套件）
 * - downloadReportImage       : 使用 html2canvas 將 Modal DOM 轉為 PNG 下載（動態 import，避免 SSR 錯誤）
 */

import type { PlannedEvent } from '@/types';

// ── ICS 工具 ─────────────────────────────────────────────────────────────────

/**
 * 將任意 ISO 8601 字串轉為 ICS 格式的 UTC 時間字串
 * 輸入：2026-04-15T14:00:00+08:00
 * 輸出：20260415T060000Z
 */
const toICSDateTime = (isoStr: string): string =>
  new Date(isoStr)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

/**
 * RFC 5545 §3.1：每行不超過 75 個 octet，超過以 CRLF + SPACE 折行
 */
const foldLine = (line: string): string => {
  if (line.length <= 75) return line;
  const out: string[] = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    out.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return out.join('\r\n');
};

/**
 * 逸出 ICS 屬性值中的特殊字元（RFC 5545 §3.3.11）
 */
const escapeICS = (str: string | null | undefined): string => {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
};

/**
 * 產生 VCALENDAR 字串
 */
export const generateICS = (events: PlannedEvent[]): string => {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CulturRoute//台東藝文行程//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    const dtStart = toICSDateTime(event.start_time);

    // 結束時間：優先使用 end_time，否則用 start_time + stay_duration（分鐘）
    const endMs = event.end_time
      ? new Date(event.end_time).getTime()
      : new Date(event.start_time).getTime() + (event.stay_duration ?? 90) * 60_000;
    const dtEnd = toICSDateTime(new Date(endMs).toISOString());

    // DESCRIPTION：簡介 + 訂房提醒（若由多留一下加入）+ 購票連結
    const descParts = [
      event.description ?? '',
      event.isExtraDayTrigger ? '💡 多留了一天，記得多訂住宿！' : '',
      event.ticket_url ? `購票連結：${event.ticket_url}` : '',
      event.source_url ? `活動頁面：${event.source_url}` : '',
    ].filter(Boolean);

    const eventLines = [
      'BEGIN:VEVENT',
      `UID:${event.id}@culturroute`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${escapeICS(event.title)}`,
      `LOCATION:${escapeICS(event.venue_name)}`,
      `DESCRIPTION:${escapeICS(descParts.join('\\n'))}`,
      'END:VEVENT',
    ];

    lines.push(...eventLines.map(foldLine));
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 §3.1：行分隔符為 CRLF
  return lines.join('\r\n');
};

/**
 * 觸發 .ics 檔案下載
 */
export const downloadICS = (events: PlannedEvent[]): void => {
  const content = generateICS(events);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `CulturRoute_台東行程_${new Date().toISOString().substring(0, 10)}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── 圖片下載 ──────────────────────────────────────────────────────────────────

/**
 * 將目標 DOM 節點截圖並下載為 PNG（明信片模式）
 *
 * 動態 import html2canvas 避免 Next.js SSR 期間碰到 window。
 * 錯誤處理原則：
 *   - import 失敗 → console.error + throw，確保 html2canvas 絕不以 undefined 被呼叫
 *   - 截圖失敗    → console.error + alert，onEnd 在 finally 中必然執行
 */
export const downloadReportImage = async (
  element: HTMLElement,
  onStart?: () => void,
  onEnd?: () => void,
  scale = 3,
  filename = `CulturRoute_台東明信片_${new Date().toISOString().substring(0, 10)}.png`,
): Promise<void> => {
  onStart?.();
  try {
    // 套件載入失敗時立刻 throw，後續程式碼完全不執行
    const { default: html2canvas } = await import('html2canvas').catch((err) => {
      console.error('[CulturRoute] html2canvas 套件載入失敗:', err);
      throw new Error('html2canvas 套件未安裝，請執行：npm install html2canvas');
    });

    const canvas = await html2canvas(element, {
      useCORS: true,        // 允許跨域圖片（活動海報）
      allowTaint: false,    // 與 useCORS 搭配，拒絕汙染 canvas 的跨域圖片
      scale,                // scale:3 → 1800×2700px → 300 DPI 列印品質
      backgroundColor: '#f8f6f0',
      logging: false,
    });

    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('[CulturRoute] 明信片生成失敗:', err);
    alert('下載失敗，請稍後再試。\n詳細錯誤請查看瀏覽器 Console（F12）。');
  } finally {
    onEnd?.();
  }
};
