import {describe,it,expect} from 'vitest';import {parsePayment,extendedEnd} from './paymentRules';
const base={requestId:'44aa44aa-1111-4111-8111-111111111111',amount:'250,50',paidOn:'2026-10-29',periodStart:'2026-10-29',periodEnd:'2026-11-27',note:' paid ',extendSubscription:false};
describe('payment validation',()=>{
 it('normalizes decimal amount without losing cents',()=>{expect(parsePayment(base,'2026-10-29')).toEqual({...base,amount:'250.50',note:'paid'})});
 it('rejects nonpositive amounts, excessive precision, invalid and future dates',()=>{for(const patch of [{amount:'0'},{amount:'-5'},{amount:'1.001'},{amount:'Infinity'},{paidOn:'2026-10-30'},{paidOn:'2026-02-30'},{periodEnd:'2026-10-01'},{requestId:'bad'},{extendSubscription:'true'},{note:'x'.repeat(1001)}])expect(parsePayment({...base,...patch},'2026-10-29')).toBeNull()});
 it('never shortens existing subscription',()=>{expect(extendedEnd('2027-01-01','2026-11-27')).toBe('2027-01-01');expect(extendedEnd('2026-10-01','2026-11-27')).toBe('2026-11-27');expect(extendedEnd(null,'2026-11-27')).toBe('2026-11-27')});
});
