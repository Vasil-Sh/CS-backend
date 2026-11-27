/**
 * Text from bet screenshots in channel posts (tesseract.js — free, runs on our server, no keys).
 * One worker, created on first use and closed after each collection pass (it holds ~150 MB).
 * Language data is downloaded once from the tesseract.js CDN into .cache/tessdata (TG_OCR_LANG_PATH + TG_OCR_GZIP=0 point it at a local tessdata folder).
 */
import { join } from 'path';
import { mkdirSync } from 'fs';
import { accountMedia } from './tgAccount';

type Worker = { recognize: (img: Buffer) => Promise<{ data: { text: string } }>; setParameters: (p: Record<string, string>) => Promise<unknown>; terminate: () => Promise<unknown> };
const LANGS = process.env.TG_OCR_LANGS || 'eng+rus+ukr';
const MAX_BYTES = 6 * 1024 * 1024;
let worker: Promise<Worker> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!worker) {
    worker = (async () => {
      const { createWorker } = await import('tesseract.js');
      const cachePath = join(process.cwd(), '.cache', 'tessdata');
      try { mkdirSync(cachePath, { recursive: true }); } catch { /* read-only fs: tesseract keeps data in memory */ }
      const opts: Record<string, unknown> = { cachePath };
      if (process.env.TG_OCR_LANG_PATH) { opts.langPath = process.env.TG_OCR_LANG_PATH; opts.gzip = process.env.TG_OCR_GZIP !== '0'; }
      return (await createWorker(LANGS.split('+'), 1, opts)) as unknown as Worker;
    })();
    worker.catch(() => { worker = null; });
  }
  return worker;
}

/** What the reader did since the start (for the admin). */
export const ocrStats = { images: 0, failed: 0, ms: 0, lastError: null as string | null, lastAt: null as string | null };

/** OCR of one image URL; '' when the image can't be fetched or read. Calls run one at a time. */
export function ocrImage(url: string): Promise<string> {
  const run = async () => {
    const t0 = Date.now();
    try {
      let buf: Buffer;
      if (url.startsWith('tgacc://')) { const b = await accountMedia(url); if (!b) return ''; buf = b; } else {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return '';
        buf = Buffer.from(await res.arrayBuffer());
      }
      if (!buf.length || buf.length > MAX_BYTES) return '';
      const img = await prepare(buf), bw = await prepare(buf, true);
      const w = await getWorker();
      // four passes: page layout, one uniform block (keeps «Карта 1: Переможець карти: X 1.58» on one line), sparse text (small labels: «3DMAX», «1.90»)
      const passes: string[] = [];
      for (const psm of ['3', '6', '11']) { await w.setParameters({ tessedit_pageseg_mode: psm }); passes.push((await w.recognize(img)).data.text); }
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      passes.push((await w.recognize(bw)).data.text); // + black-and-white: faint grey labels
      ocrStats.images++; ocrStats.ms += Date.now() - t0; ocrStats.lastAt = new Date().toISOString();
      return passes.reduce((acc, x) => mergeOcr(acc, x));
    } catch (e) {
      console.warn('[tg] ocr:', (e as Error).message);
      ocrStats.failed++; ocrStats.lastError = (e as Error).message.slice(0, 200);
      return '';
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Channel screenshots are small (≈380 px wide on t.me/s): grey, contrast-stretched and scaled up to ≈1600 px so tesseract sees the small print. */
async function prepare(buf: Buffer, light = false): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const k = w && w < 700 ? Math.min(4, 1600 / w) : 1; // big screenshots are read as they are (CPU)
    let img = sharp(buf).grayscale();
    if (k > 1.05) img = img.resize({ width: Math.round(w * k), kernel: 'lanczos3' });
    img = light ? img.threshold(220) /* light-grey print → black: «Карта 1: Переможець карти» */ : img.clahe({ width: 96, height: 96, maxSlope: 3 }); // local contrast
    return await img.png().toBuffer();
  } catch { return buf; }
}

/** Lines of the first pass, then lines only the second pass found. */
export function mergeOcr(a: string, b: string): string {
  const A = cleanOcr(a), seen = new Set(A.split('\n').map((l) => l.toLowerCase()));
  const extra = cleanOcr(b).split('\n').filter((l) => l && !seen.has(l.toLowerCase()) && !A.toLowerCase().includes(l.toLowerCase()));
  return [A, extra.join(' ')].filter(Boolean).join('\n').slice(0, 3000);
}

/** Frees the worker's memory (after a collection pass). */
export async function closeOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await chain.then(() => w).then((x) => x.terminate()).catch(() => {});
}

/** Drops OCR noise: empty lines and lines with no letters or digits. */
export function cleanOcr(s: string): string {
  return s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => /[\p{L}\d]{2}/u.test(l)).join('\n').slice(0, 3000);
}

/** The money on a bookmaker's slip from OCR text: «Сумма ставки 1 55,00 USDT», «Возможный выигрыш 2 43,35», «Открыта / Выиграна / Проиграна».
 *  OCR splits digits with spaces, so a number is read across them; the payout must be above the stake. */
export function slipFromOcr(text: string): { status: 'won' | 'lost' | 'pending' | 'void' | 'cashout'; stake: number; currency: string | null; payout: number | null; odds: number | null } | null {
  const t = (text || '').replace(/\u00a0/g, ' ');
  const num = (label: RegExp) => {
    const m = new RegExp(`${label.source}[^\\d]{0,24}((?:\\d[\\d ]{0,9})[.,]\\d{2})\\s*(USDT|USD|RUB|UAH|EUR|KZT|[₽$€₴₸]|руб|грн)?`, 'i').exec(t);
    return m ? { n: Number(m[1].replace(/ /g, '').replace(',', '.')), cur: m[2] || null } : null;
  };
  const stake = num(/(?:сумм?а ставки|ставка|stake|bet amount)/);
  if (!stake || !(stake.n > 0)) return null;
  const pay = num(/(?:возможный выигрыш|потенциальный выигрыш|можливий виграш|выигрыш|виграш|выплата|виплата|payout|to win|(?<![\da-z])win(?![a-z]))/); // not the «1win» logo
  const status = /выигран|виграно|выигрыш зачислен|\bwon\b/i.test(t) ? 'won' : /проигран|програно|\blost\b/i.test(t) ? 'lost' : /возврат|повернен|\bvoid\b/i.test(t) ? 'void' : /продан|cash ?out/i.test(t) ? 'cashout' : 'pending';
  const cur = (stake.cur || pay?.cur || (/USDT/i.test(t) ? 'USDT' : null));
  const c = !cur ? null : /USDT/i.test(cur) ? 'USDT' : /USD|\$/.test(cur) ? 'USD' : /RUB|₽|руб/i.test(cur) ? 'RUB' : /UAH|₴|грн/i.test(cur) ? 'UAH' : /EUR|€/.test(cur) ? 'EUR' : /KZT|₸/.test(cur) ? 'KZT' : null;
  const payout = pay && pay.n > stake.n ? pay.n : null;
  // the slip's own odds: (possible) payout ÷ stake — a sold or returned slip pays something else
  const odds = payout && status !== 'cashout' && status !== 'void' ? Math.round((payout / stake.n) * 100) / 100 : null;
  return { status, stake: stake.n, currency: c, payout, odds: odds && odds >= 1.01 && odds <= 50 ? odds : null };
}
