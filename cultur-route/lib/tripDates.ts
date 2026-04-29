/** YYYY-MM-DD from a local Date object or an already-formatted string. */
export const getLocalYYYYMMDD = (date: string | Date): string => {
  const d = typeof date === 'string' ? new Date(date) : date;
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
};

/**
 * Build a continuous date array covering the trip range AND every event's
 * assigned_date.  Max 60 days.  Falls back to today if all inputs are empty.
 *
 * This is the single source of truth used by both ItinerarySidebar and the
 * itinerary page so "Day N" always refers to the same calendar date.
 */
export const buildTripDateRange = (
  tripStart: string,
  tripEnd: string,
  eventDates: string[],
): string[] => {
  const seeds = eventDates.filter(Boolean);
  if (tripStart) seeds.push(tripStart);
  if (tripEnd) seeds.push(tripEnd);
  if (seeds.length === 0) return [getLocalYYYYMMDD(new Date())];

  const minDate = seeds.reduce((a, b) => (a < b ? a : b));
  const maxDate = seeds.reduce((a, b) => (a > b ? a : b));

  const [sy, sm, sd] = minDate.split('-').map(Number);
  const [ey, em, ed] = maxDate.split('-').map(Number);
  let curr = new Date(sy, sm - 1, sd);
  const endD = new Date(ey, em - 1, ed);

  const dates: string[] = [];
  let count = 0;
  while (curr <= endD && count < 60) {
    dates.push(getLocalYYYYMMDD(curr));
    curr.setDate(curr.getDate() + 1);
    count++;
  }
  return dates.length > 0 ? dates : [getLocalYYYYMMDD(new Date())];
};
