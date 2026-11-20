import { describe, expect, it } from 'vitest';
import { filterSql, tgEscape } from './adminSupport';

describe('support filters', () => {
  it('open hides resolved and closed', () => expect(filterSql('open')).toContain("NOT IN ('resolved','closed')"));
  it('new is only status open', () => expect(filterSql('new')).toBe("t.status = 'open'"));
  it('mine uses the admin username and skips finished tickets', () => expect(filterSql('mine')).toMatch(/assignee = \$1.*NOT IN/));
  it('resolved covers closed too', () => expect(filterSql('resolved')).toContain("'closed'"));
});

describe('telegram escaping', () => {
  it('escapes html', () => expect(tgEscape('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;'));
});
