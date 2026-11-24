/**
 * Night mode (Kyiv time, 02:00–06:00 by default): the parsers slow down instead of stopping —
 * Liquipedia's ticker every 15 min (5 min while a match is live), no tournament pages, no Cito / OddsPapi
 * requests, PandaScore every 30 min. Live matches keep their normal refresh: bets settle on «finished».
 */
const FROM = Number(process.env.NIGHT_FROM_HOUR ?? 2);
const TO = Number(process.env.NIGHT_TO_HOUR ?? 6);

export function kyivHour(now = Date.now()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

export function isNight(now = Date.now()): boolean {
  if (FROM === TO) return false;
  const h = kyivHour(now);
  return FROM < TO ? h >= FROM && h < TO : h >= FROM || h < TO;
}

export const nightWindow = () => ({ from: FROM, to: TO });
