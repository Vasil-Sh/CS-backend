import { Hono } from 'hono';
import { getPastMatches } from '../services/matchHistoryService';
import { generateLogoFallback } from '../services/createMatchesRouter';

const router = new Hono();

// ── GET /matches-history?game=dota2|cs2|all&days=7 ──
router.get('/', async (c) => {
  const game = (c.req.query('game') || 'all') as 'dota2' | 'cs2' | 'all';
  const days = parseInt(c.req.query('days') || '7', 10);

  try {
    const matches = await getPastMatches(game, Math.min(days, 30)); // cap at 30 days

    // Resolve logos — same logic as main matches API
    // History stores raw CDN URLs from scraper; resolve to local when available
    for (const m of matches) {
      const prefix = m.game === 'cs2' ? 'cs2-matches' : 'dota2-matches';
      m.logoTeam1 = m.logoTeam1 && m.logoTeam1.startsWith('http')
        ? `/api/v1/${prefix}/logo/external/${Buffer.from(m.logoTeam1).toString('base64url')}`
        : generateLogoFallback(m.team1, prefix);
      m.logoTeam2 = m.logoTeam2 && m.logoTeam2.startsWith('http')
        ? `/api/v1/${prefix}/logo/external/${Buffer.from(m.logoTeam2).toString('base64url')}`
        : generateLogoFallback(m.team2, prefix);
    }

    return c.json(matches);
  } catch (err) {
    console.error('[matches-history] Query failed:', (err as Error).message);
    return c.json({ error: 'Failed to fetch match history' }, 500);
  }
});

export default router;
