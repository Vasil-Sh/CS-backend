import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { deepSeekService } from '../services/deepseek';

const ai = new Hono();

const recommendationSchema = z.object({
  team1: z.string().min(1),
  team2: z.string().min(1),
  format: z.string().default('Bo3'),
  tier: z.string().default('TIER2'),
  odds: z
    .object({
      team1: z.number().optional(),
      team2: z.number().optional(),
    })
    .optional(),
});

// ── POST /api/ai/recommend ──
ai.post('/recommend', requireAuth, async (c) => {
  if (!deepSeekService.isConfigured()) {
    return c.json({ error: 'AI service not configured' }, 503);
  }

  let body;
  try {
    body = recommendationSchema.parse(await c.req.json());
  } catch (e: any) {
    return c.json({ error: 'Invalid input', details: e.errors }, 400);
  }

  try {
    const recommendation = await deepSeekService.getMatchRecommendation(body);
    return c.json(recommendation);
  } catch (err: any) {
    console.error('[DeepSeek]', err.message);
    return c.json({ error: 'AI service error', message: err.message }, 502);
  }
});

// ── POST /api/ai/advice (balance advice — rule-based, no AI call needed) ──
const adviceSchema = z.object({
  state: z.enum(['growing', 'stable', 'dipping', 'falling']),
  percentOfPeak: z.number(),
  currentBank: z.number(),
  allTimeHigh: z.number(),
  bets: z.number(),
  profit: z.number(),
});

ai.post('/advice', requireAuth, async (c) => {
  let body;
  try { body = adviceSchema.parse(await c.req.json()); }
  catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }

  const tips: Record<string, string[]> = {
    growing: [
      'Банк на піку — це чудово. Фіксуй прибуток: виведи частину коштів як резерв і продовжуй з тією ж стратегією.',
      'Ти на максимумі. Раджу зняти 20-30% прибутку як подушку безпеки, а рештою продовжуй грати обережно.',
    ],
    stable: [
      'Банк стабільний — хороший знак. Продовжуй дотримуватися стратегії, але уникай імпульсивних ставок на високі коефіцієнти.',
      'Усе під контролем. Якщо хочеш рости — збільшуй кількість якісних ставок, а не суми.',
    ],
    dipping: [
      'Банк просідає. Зменш розмір ставок удвічі на 3-5 днів і грай тільки на коефіцієнтах 1.3-1.8, поки не повернешся до 90% від максимуму.',
      'Ризики зависокі. Зроби паузу на день-два, переглянь останні 10 програшів і знайди патерн помилок.',
    ],
    falling: [
      'Банк серйозно просів. Зупинись на тиждень. Переглянь усю стратегію: можливо ти ставиш на зависокі коефіцієнти або емоційно відіграєшся.',
      'Критичне падіння. Рекомендую припинити ставки, вивести залишок і почати з меншого банку після аналізу помилок.',
    ],
  };

  const advice = tips[body.state]?.[Math.floor(Math.random() * tips[body.state].length)] || tips.stable[0];
  return c.json({ advice });
});

export default ai;
