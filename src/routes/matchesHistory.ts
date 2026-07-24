import { Hono } from 'hono';
import { getPastMatches } from '../services/matchHistoryService';

const router = new Hono();

// ── GET /matches-history?game=dota2|cs2|all&days=7 ──
router.get('/', async (c) => {
  const game = (c.req.query('game') || 'all') as 'dota2' | 'cs2' | 'all';
  const days = parseInt(c.req.query('days') || '7', 10);

  try {
    const matches = await getPastMatches(game, Math.min(days, 30)); // cap at 30 days
    return c.json(matches);
  } catch (err) {
    console.error('[matches-history] Query failed:', (err as Error).message);
    return c.json({ error: 'Failed to fetch match history' }, 500);
  }
});

export default router;
