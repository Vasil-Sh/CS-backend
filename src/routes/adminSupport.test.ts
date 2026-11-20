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

import { supportHints } from './adminSupport';
describe('support hints', () => {
  it('AI limit reached', () => expect(supportHints({ aiToday: 5, aiLimit: 5, lastPayment: null, endDate: null, plan: 'basic' })[0]).toMatch(/Ліміт AI/));
  it('payment recorded but subscription not extended', () => expect(supportHints({ aiToday: 0, aiLimit: 5, lastPayment: { paidOn: '2026-11-19', periodEnd: '2026-12-19' }, endDate: '2026-11-20', plan: 'basic' })[0]).toMatch(/Оплата від/));
  it('nothing to hint', () => expect(supportHints({ aiToday: 1, aiLimit: 5, lastPayment: { paidOn: '2026-11-01', periodEnd: '2026-12-01' }, endDate: '2026-12-01', plan: 'pro' })).toEqual([]));
});
