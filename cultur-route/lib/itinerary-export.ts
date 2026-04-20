/**
 * 行程匯出工具
 * - generateICS / downloadICS     : 產生符合 RFC 5545 的 .ics 檔（以活動原始 start_time 為基準）
 * - downloadItineraryICS          : 以使用者規劃的 assigned_date + visit_time 產生 .ics，含防呆標記
 * - downloadReportImage           : 使用 html2canvas 將 Modal DOM 轉為 PNG 下載（動態 import，避免 SSR 錯誤）
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

// ── 行程 ICS（以使用者規劃時間為準）────────────────────────────────────────────

/**
 * 將 YYYY-MM-DD + HH:MM（台北時間 UTC+8）轉為 ICS UTC 時間字串
 * 例：('2026-04-15', '14:00') → '20260415T060000Z'
 */
const toICSDateTimeFromPlanned = (date: string, hhmm: string): string => {
  const iso = `${date}T${hhmm}:00+08:00`;
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
};

/**
 * 以使用者規劃的行程資料（assigned_date + visit_time）產生 iCalendar 字串
 *
 * 規則：
 *  - 有 visit_time → 具體時間區塊（DTSTART/DTEND UTC）
 *  - 無 visit_time → 全天事件（DTSTART;VALUE=DATE），標題加 [待確認]，
 *                    DESCRIPTION 第一行加 ⚠️ 提醒
 */
const generateItineraryICS = (events: PlannedEvent[]): string => {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CulturRoute//台東藝文行程//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    const { assigned_date, visit_time, stay_duration, title, venue_name } = event;
    const hasTimed = !!visit_time;

    // ── 描述文字 ─────────────────────────────────────────────────────────────
    const descParts: string[] = [];
    if (!hasTimed) {
      descParts.push('⚠️ 此為預排行程，請自行確認實際營業或活動時間。');
    }
    if (event.description)       descParts.push(event.description);
    if (event.isExtraDayTrigger) descParts.push('💡 多留了一天，記得多訂住宿！');
    if (event.ticket_url)        descParts.push(`購票連結：${event.ticket_url}`);
    if (event.source_url)        descParts.push(`活動頁面：${event.source_url}`);
    // 使用真實換行符，escapeICS 會將其轉為 ICS 規範的 \n
    const description = escapeICS(descParts.join('\n'));

    // ── 地點：優先使用 address，其次 venue_name ───────────────────────────────
    const location = escapeICS(event.address ?? venue_name);

    let eventLines: string[];

    if (hasTimed) {
      // 有具體時間：轉為 UTC 時間區塊
      const dtStart = toICSDateTimeFromPlanned(assigned_date, visit_time!);
      const endMs =
        new Date(`${assigned_date}T${visit_time}:00+08:00`).getTime() +
        (stay_duration ?? 90) * 60_000;
      const dtEnd = new Date(endMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

      eventLines = [
        'BEGIN:VEVENT',
        `UID:planned-${event.id}@culturroute`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeICS(title)}`,
        `LOCATION:${location}`,
        `DESCRIPTION:${description}`,
        'END:VEVENT',
      ];
    } else {
      // 無具體時間：全天事件
      const dateCompact = assigned_date.replace(/-/g, '');
      // DTEND 為下一天（RFC 5545 §3.6.1 全天事件為開區間）
      const nextDay = new Date(`${assigned_date}T00:00:00+08:00`);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayCompact = nextDay.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');

      eventLines = [
        'BEGIN:VEVENT',
        `UID:planned-${event.id}@culturroute`,
        `DTSTART;VALUE=DATE:${dateCompact}`,
        `DTEND;VALUE=DATE:${nextDayCompact}`,
        `SUMMARY:${escapeICS(`[待確認] ${title}`)}`,
        `LOCATION:${location}`,
        `DESCRIPTION:${description}`,
        'END:VEVENT',
      ];
    }

    lines.push(...eventLines.map(foldLine));
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
};

/**
 * 觸發行程 .ics 檔案下載（以使用者規劃時間為準）
 * 檔名：CulturRoute-Itinerary.ics
 *
 * 手機相容性：
 *  - target="_blank" 提高手機瀏覽器觸發下載的成功率
 *  - setTimeout 10 秒後才釋放 Blob URL，給慢速手機足夠緩衝
 */
export const downloadItineraryICS = (events: PlannedEvent[]): void => {
  const content = generateItineraryICS(events);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'CulturRoute-Itinerary.ics';
  a.target = '_blank';   // 手機瀏覽器提高下載成功率的關鍵屬性
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// ── 圖片下載 ──────────────────────────────────────────────────────────────────

/**
 * 將目標 DOM 節點截圖並下載為 PNG（明信片模式）
 *
 * 手機相容性策略：
 *  1. scale 固定 1（避免手機 OOM 閃退）
 *  2. useCORS + allowTaint: false（防止 Canvas 污染）
 *  3. canvas.toBlob() → Blob URL（比 toDataURL 更省記憶體，手機友好）
 *  4. iOS 偵測：直接開新分頁顯示圖片，提示長按儲存（iOS 不支援 download 屬性）
 *  5. onEnd 放在 finally，確保無論成功/失敗按鈕都會恢復
 */
export const downloadReportImage = async (
  element: HTMLElement,
  onStart?: () => void,
  onEnd?: () => void,
  filename = `CulturRoute_台東明信片_${new Date().toISOString().substring(0, 10)}.png`,
): Promise<void> => {
  onStart?.();
  try {
    const { default: html2canvas } = await import('html2canvas').catch((err) => {
      console.error('[CulturRoute] html2canvas 套件載入失敗:', err);
      throw new Error('html2canvas 套件未安裝，請執行：npm install html2canvas');
    });

    const canvas = await html2canvas(element, {
      useCORS: true,
      allowTaint: false,
      // @ts-ignore — `scale` 為有效執行時屬性，但 @types/html2canvas 型別定義未包含
      scale: 1,           // 固定 1x：手機不會 OOM，桌機也夠清晰
      backgroundColor: '#f8f6f0',
      logging: false,
    });

    // toBlob 比 toDataURL 更省記憶體（手機必備）；包成 Promise 確保 finally 時序正確
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else   reject(new Error('canvas.toBlob 回傳 null'));
      }, 'image/png');
    });

    const url = URL.createObjectURL(blob);

    // iOS 不支援 <a download>；改開新分頁讓使用者長按儲存
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isIOS) {
      window.open(url, '_blank', 'noopener');
      alert('長按圖片即可儲存至相簿 📸');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    // 延遲釋放，給慢速手機足夠緩衝
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    console.error('[CulturRoute] 明信片生成失敗:', err);
    alert('下載失敗，請稍後再試。\n詳細錯誤請查看瀏覽器 Console（F12）。');
  } finally {
    onEnd?.();
  }
};
