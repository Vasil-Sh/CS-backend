import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isTracked, trackedFiles } from './durableFiles';

describe('durable cache files', () => {
  it('tracks the listed files and one level of a listed folder, nothing outside', () => {
    expect(isTracked('cs2_matches.json')).toBe(true);
    expect(isTracked('logos/tournaments/iem.png')).toBe(true);
    expect(isTracked('logos/tournaments/x/y.png')).toBe(false);
    expect(isTracked('../etc/passwd')).toBe(false);
    expect(isTracked('oddspapi.json')).toBe(false);
  });
  it('lists the files that exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dur-'));
    writeFileSync(join(root, 'a.json'), '{}');
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'x.png'), 'x');
    expect(trackedFiles(root, ['a.json', 'b.json', 'd/']).sort()).toEqual(['a.json', 'd/x.png']);
  });
});
