const AGODA_BASE = 'https://www.agoda.com/partners/partnersearch.aspx?pcs=1&cid=1963577&city=4740';

const fmt = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Build a dynamic Agoda affiliate URL.
 *
 * @param checkInDate  - ISO string or Date for check-in (required)
 * @param checkOutDate - ISO string or Date for check-out (optional).
 *                       When omitted, defaults to checkIn + 1 day,
 *                       preserving backwards-compatibility for single-event pages.
 */
export function buildAgodaUrl(
  checkInDate: string | Date,
  checkOutDate?: string | Date,
): string {
  const checkIn = new Date(checkInDate);
  const checkOut = checkOutDate
    ? new Date(checkOutDate)
    : (() => { const d = new Date(checkIn); d.setDate(d.getDate() + 1); return d; })();

  const los = Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000));

  const url = new URL(AGODA_BASE);
  url.searchParams.set('checkIn', fmt(checkIn));
  url.searchParams.set('checkOut', fmt(checkOut));
  url.searchParams.set('los', String(los));
  return url.toString();
}
