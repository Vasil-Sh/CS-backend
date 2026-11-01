/** Today's calendar date in Kyiv as YYYY-MM-DD. */
export function kyivToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * A subscription end date is inclusive: access lasts through that whole day in Kyiv.
 * `endDate` is a Postgres DATE (YYYY-MM-DD, possibly with a time suffix).
 * Comparing `new Date(endDate) < now` instead cut access at 00:00 UTC
 * (02:00–03:00 Kyiv) on the last paid day.
 */
export function isSubscriptionExpired(endDate: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!endDate) return false;
  const end = endDate instanceof Date
    ? kyivToday(endDate)
    : String(endDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  return end < kyivToday(now);
}
