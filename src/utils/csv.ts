/**
 * Quote a value for CSV. Text starting with = + - @ (or tab/CR) is prefixed
 * with an apostrophe so Excel/Sheets show it as text instead of running it
 * as a formula. Plain numbers like "-5" are left as they are.
 */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
