import { describe, it, expect } from 'vitest';
import { csvCell } from './csv';

describe('csvCell', () => {
  it('quotes and escapes double quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
  });
  it('neutralizes formula-like text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@admin')).toBe(`"'@admin"`);
    expect(csvCell('+380')).toBe(`"'+380"`);
  });
  it('leaves plain negative numbers alone', () => {
    expect(csvCell('-5')).toBe('"-5"');
    expect(csvCell('-12,50')).toBe('"-12,50"');
  });
});
