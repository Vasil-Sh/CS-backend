/**
 * Text from bet screenshots in channel posts (tesseract.js — free, runs on our server, no keys).
 * One worker, created on first use and closed after each collection pass (it holds ~150 MB).
 * Language data is downloaded once from the tesseract.js CDN into .cache/tessdata (TG_OCR_LANG_PATH + TG_OCR_GZIP=0 point it at a local tessdata folder).
 */
import { join } from 'path';
import { mkdirSync } from 'fs';

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

/** OCR of one image URL; '' when the image can't be fetched or read. Calls run one at a time. */
export function ocrImage(url: string): Promise<string> {
  const run = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return '';
      const img = await prepare(buf);
      const w = await getWorker();
      // two passes: page layout (lines in order) + sparse text (small labels on coloured tickets: «3DMAX», «1.90»)
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      const a = (await w.recognize(img)).data.text;
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const b = (await w.recognize(img)).data.text;
      return mergeOcr(a, b);
    } catch (e) {
      console.warn('[tg] ocr:', (e as Error).message);
      return '';
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Channel screenshots are small (≈380 px wide on t.me/s): grey, contrast-stretched and scaled up to ≈1200 px so tesseract sees the small print. */
async function prepare(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const k = w && w < 1100 ? Math.min(3, 1200 / w) : 1;
    let img = sharp(buf).grayscale().normalize();
    if (k > 1.05) img = img.resize({ width: Math.round(w * k), kernel: 'lanczos3' });
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
