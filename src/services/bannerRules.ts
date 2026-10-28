export const bannerScreens = [
  "matches",
  "journal",
  "analytics",
  "strategies",
  "risky-teams",
];
export type Period = { startsOn?: string | null; endsOn?: string | null };
export function validDate(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validPlacement(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    (b.screen === undefined || bannerScreens.includes(b.screen as string)) &&
    (b.slot === undefined || b.slot === 1 || b.slot === 2) &&
    (b.active === undefined || typeof b.active === "boolean") &&
    validDate(b.startsOn) &&
    validDate(b.endsOn) &&
    !(
      typeof b.startsOn === "string" &&
      typeof b.endsOn === "string" &&
      b.startsOn > b.endsOn
    )
  );
}
export function periodsOverlap(a: Period, b: Period) {
  return (
    (a.startsOn || "0000-01-01") <= (b.endsOn || "9999-12-31") &&
    (b.startsOn || "0000-01-01") <= (a.endsOn || "9999-12-31")
  );
}
export class BannerConflict extends Error {}
export class BannerPeriodError extends Error {}
