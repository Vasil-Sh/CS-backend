import {validDate} from './bannerRules';
export type PaymentInput={requestId:string;amount:string;paidOn:string;periodStart:string;periodEnd:string;note:string;extendSubscription:boolean};
export function parsePayment(value:unknown,today:string):PaymentInput|null {
 if(!value || typeof value!=='object')return null; const v=value as Record<string,unknown>;
 if(typeof v.requestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.requestId))return null;
 if(typeof v.amount!=='string' || !/^\d{1,9}([.,]\d{1,2})?$/.test(v.amount.trim()))return null;
 const amount=Number(v.amount.trim().replace(',','.'));if(!Number.isFinite(amount)||amount<=0)return null;
 for(const key of ['paidOn','periodStart','periodEnd'])if(typeof v[key]!=='string'||!validDate(v[key])||!(v[key] as string))return null;
 if(String(v.paidOn)>today || String(v.periodStart)>String(v.periodEnd))return null;
 if(typeof v.note!=='string'||v.note.length>1000||typeof v.extendSubscription!=='boolean')return null;
 return {requestId:v.requestId,amount:amount.toFixed(2),paidOn:v.paidOn as string,periodStart:v.periodStart as string,periodEnd:v.periodEnd as string,note:v.note.trim(),extendSubscription:v.extendSubscription};
}
export function extendedEnd(current:string|null,periodEnd:string){return current && current>periodEnd ? current : periodEnd}
