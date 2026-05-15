const AGODA_BASE = 'https://www.agoda.com/partners/partnersearch.aspx?pcs=1&cid=1963577&city=4740';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toYMD(input: string | Date): string {
  if (typeof input === 'string' && ISO_DATE.test(input)) return input;
  const d = typeof input === 'string' ? new Date(input) : input;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addOneDay(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, '0');
  const nd = String(next.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const msFrom = new Date(fy, fm - 1, fd).getTime();
  const msTo   = new Date(ty, tm - 1, td).getTime();
  return Math.max(1, Math.round((msTo - msFrom) / 86_400_000));
}

export function buildAgodaUrl(
  checkInDate: string | Date,
  checkOutDate?: string | Date,
): string {
  const checkIn  = toYMD(checkInDate);
  const checkOut = checkOutDate ? toYMD(checkOutDate) : addOneDay(checkIn);
  const los      = daysBetween(checkIn, checkOut);

  const url = new URL(AGODA_BASE);
  url.searchParams.set('checkIn', checkIn);
  url.searchParams.set('checkOut', checkOut);
  url.searchParams.set('los', String(los));
  return url.toString();
}
