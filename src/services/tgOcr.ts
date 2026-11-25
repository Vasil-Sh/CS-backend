/**
 * Text from bet screenshots in channel posts (tesseract.js — free, runs on our server, no keys).
 * One worker, created on first use and closed after each collection pass (it holds ~150 MB).
 * Language data is downloaded once from the tesseract.js CDN into .cache/tessdata (TG_OCR_LANG_PATH + TG_OCR_GZIP=0 point it at a local tessdata folder).
 */
import { join } from 'path';
import { mkdirSync } from 'fs';

type Worker = { recognize: (img: Buffer) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
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
      const w = await getWorker();
      const { data } = await w.recognize(buf);
      return cleanOcr(data.text);
    } catch (e) {
      console.warn('[tg] ocr:', (e as Error).message);
      return '';
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
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
