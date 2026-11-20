import { describe, expect, it, vi } from 'vitest';
vi.mock('../db/client', () => ({ pool: {} }));
import { templateError, TEMPLATE_VARS } from './settingsService';

describe('templateError', () => {
  it('accepts every known variable', () => {
    expect(templateError(`Привіт, ${TEMPLATE_VARS.join(' ')}`)).toBe('');
  });
  it('names an unknown variable', () => {
    expect(templateError('Підписка закінчується {дата}')).toBe('Змінної {дата} немає');
  });
  it('rejects empty and very long text', () => {
    expect(templateError('   ')).toBe('Шаблон не може бути порожнім');
    expect(templateError('a'.repeat(1001))).toBe('Шаблон — до 1000 символів');
  });
});
