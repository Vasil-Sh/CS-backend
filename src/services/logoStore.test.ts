import { describe, it, expect } from 'vitest';
import { parseLogoFile } from './logoStore';

describe('parseLogoFile', () => {
  it('splits rank and name, underscores become spaces', () => {
    expect(parseLogoFile('0037_T1.png')).toEqual({ rank: 37, name: 'T1' });
    expect(parseLogoFile('0896_Entity_Gaming.png')).toEqual({ rank: 896, name: 'Entity Gaming' });
    expect(parseLogoFile('178_B8 Academy.png')).toEqual({ rank: 178, name: 'B8 Academy' });
    expect(parseLogoFile('1217_Nhiều_Số_Sáng_Tạo.svg')).toEqual({ rank: 1217, name: 'Nhiều Số Sáng Tạo' });
  });
  it('keeps names without a rank and skips non-images', () => {
    expect(parseLogoFile('Spirit.webp')).toEqual({ rank: null, name: 'Spirit' });
    expect(parseLogoFile('readme.txt')).toBeNull();
  });
});
