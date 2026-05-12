type KlookLinkType = 'car' | 'ticket';

// YYYY-MM-DD
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

// Klook datetime fields require "YYYY-MM-DD HH:mm". Pick-up fixed at 10:00.
const fmtKlookDateTime = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 10:00`;

/**
 * Injects date params into a Klook affiliate URL.
 *
 * Klook encodes the destination URL inside the `k_site` query param.
 * We decode it, mutate the inner URL, then re-encode it back into k_site —
 * keeping aid/aff_adid on the outer URL untouched.
 *
 * Car rental:
 *   The /car-rentals/?city_id=47 landing page ignores date params.
 *   We replace it with the search-results page and inject:
 *     pDate, dDate ("YYYY-MM-DD HH:mm"), pCityId, pick
 *
 * Ticket:
 *   start_date / end_date ("YYYY-MM-DD")
 *
 * Falls back to the original URL if parsing fails for any reason.
 */
export function buildKlookUrl(
  baseAffiliateUrl: string,
  startTime: string,
  endTime: string | undefined,
  type: KlookLinkType,
): string {
  try {
    const start = new Date(startTime);

    const mainUrl = new URL(baseAffiliateUrl);
    const kSiteRaw = mainUrl.searchParams.get('k_site');
    if (!kSiteRaw) return baseAffiliateUrl;

    const kSiteUrl = new URL(kSiteRaw);

    if (type === 'car') {
      const dropOff = endTime ? new Date(endTime) : (() => {
        const d = new Date(start);
        d.setDate(d.getDate() + 3);
        return d;
      })();

      // Switch to the search-results page which actually accepts date params.
      // Preserve locale prefix if present (e.g. /zh-TW/), otherwise use default.
      kSiteUrl.pathname = '/zh-TW/car-rentals/results/';

      // Clear all existing params before setting the required ones,
      // so no stale city_id or other landing-page params bleed through.
      kSiteUrl.search = '';
      kSiteUrl.searchParams.set('pDate',     fmtKlookDateTime(start));
      kSiteUrl.searchParams.set('dDate',     fmtKlookDateTime(dropOff));
      kSiteUrl.searchParams.set('pCityId',   '47');
      kSiteUrl.searchParams.set('pick',      '台東火車站');
      kSiteUrl.searchParams.set('pPoiId',    '50007450');
      kSiteUrl.searchParams.set('lat',       '22.793512');
      kSiteUrl.searchParams.set('long',      '121.122354');
      kSiteUrl.searchParams.set('pCityName', '臺東縣');
      kSiteUrl.searchParams.set('code',      'TW');
    } else {
      const end = endTime ? new Date(endTime) : (() => {
        const d = new Date(start);
        d.setDate(d.getDate() + 1);
        return d;
      })();
      kSiteUrl.searchParams.set('start_date', fmtDate(start));
      kSiteUrl.searchParams.set('end_date',   fmtDate(end));
    }

    mainUrl.searchParams.set('k_site', kSiteUrl.toString());
    return mainUrl.toString();
  } catch {
    return baseAffiliateUrl;
  }
}
