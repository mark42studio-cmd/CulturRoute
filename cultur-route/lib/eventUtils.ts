import type { Event } from '@/types';

/** Taipei-timezone YYYY-MM-DD from any ISO string */
export const dateOnlyTaipei = (iso: string): string =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

/** Format YYYY-MM-DD as "5月20日" */
export const formatDateZH = (yyyymmdd: string): string => {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('zh-TW', {
    month: 'long', day: 'numeric',
  });
};

/**
 * Returns true for events with a concrete, non-midnight start time
 * and a duration under 24 h — i.e., a real session (演出/講座/工作坊).
 * Multi-day exhibitions always return false.
 */
export const isSingleDayEvent = (event: Event): boolean => {
  if (event.time_type === '單日活動') return true;

  if (!event.start_time || !event.end_time) return false;
  const startMs = new Date(event.start_time).getTime();
  const endMs   = new Date(event.end_time).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return false;

  const startHHMM = new Date(event.start_time).toLocaleTimeString('sv-SE', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit',
  });
  return startHHMM !== '00:00' && (endMs - startMs) < 86_400_000;
};

/**
 * If the event is a single-day session whose actual date falls outside
 * [tripStart, tripEnd], returns the event's YYYY-MM-DD date string.
 * Returns null when no mismatch (or trip dates not set).
 */
export const getDateMismatch = (
  event: Event,
  tripStart: string,
  tripEnd: string,
): string | null => {
  if (!isSingleDayEvent(event)) return null;
  if (!tripStart || !tripEnd) return null;
  const eventDate = dateOnlyTaipei(event.start_time);
  if (eventDate >= tripStart && eventDate <= tripEnd) return null;
  return eventDate;
};
