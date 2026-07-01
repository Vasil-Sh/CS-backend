import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { setBankrollSchema, adjustBankrollSchema } from '../middleware/validation';
import { bankrollBackendService } from '../services/bankrollBackendService';

const bankroll = new Hono();

bankroll.get('/', requireAuth, async (c) => {
  const stats = await bankrollBackendService.getStats(c.get('user').userId);
  return c.json(stats);
});

bankroll.post('/', requireAuth, async (c) => {
  let body;
  try { body = setBankrollSchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const result = await bankrollBackendService.setInitialBank(c.get('user').userId, body.initialBank, body.initialBankUSD, body.exchangeRate);
  return c.json(result, 201);
});

bankroll.post('/adjust', requireAuth, async (c) => {
  let body;
  try { body = adjustBankrollSchema.parse(await c.req.json()); } catch (e: any) { return c.json({ error: 'Invalid input', details: e.errors }, 400); }
  const updated = await bankrollBackendService.adjust(c.get('user').userId, body.amount);
  if (!updated) return c.json({ error: 'Bankroll not initialized' }, 400);
  return c.json(updated);
});

export default bankroll;
