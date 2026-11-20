// ═══════════════════════════════════════════
// DeepSeek AI proxy service (server-side)
// Falls back to Google Gemini Flash (free tier) if DeepSeek key is missing.
// ═══════════════════════════════════════════

import { GoogleGenerativeAI } from '@google/generative-ai';
import { recordAiUsage } from './insights';

interface MatchData {
  team1: string;
  team2: string;
  format: string;
  tier: string;
  odds?: { team1?: number; team2?: number };
}

/** From Налаштування → AI-аналіз: who asks (for usage per person), the wording rule, words that force a rewrite. */
export interface AiOptions { userId?: number; rule?: string; stopWords?: string[] }

/** Stop words found in the answer (case-insensitive, whole phrase). */
export function stopWordHits(r: { prediction: string; reasoning: string; suggestedBet: string }, words: string[] = []): string[] {
  const text = `${r.prediction}\n${r.reasoning}\n${r.suggestedBet}`.toLowerCase();
  return words.filter((w) => w && text.includes(w.toLowerCase()));
}

/** Last resort after a rewrite still used them: drop the phrases so they never reach the user. */
export function maskStopWords<T extends { prediction: string; reasoning: string; suggestedBet: string }>(r: T, words: string[]): T {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = words.length ? new RegExp(words.map(esc).join('|'), 'gi') : null;
  const clean = (t: string) => (re ? t.replace(re, '…').replace(/\s{2,}/g, ' ').trim() : t);
  return { ...r, prediction: clean(r.prediction), reasoning: clean(r.reasoning), suggestedBet: clean(r.suggestedBet) };
}

interface AIRecommendation {
  prediction: string;
  confidence: number;
  reasoning: string;
  suggestedBet: string;
  riskLevel: 'low' | 'medium' | 'high';
}

class DeepSeekService {
  private apiKey: string;
  private baseUrl = 'https://api.deepseek.com/v1';
  private model = 'deepseek-chat';

  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
  }

  isConfigured(): boolean {
    return (
      (!!this.apiKey && this.apiKey.length > 10) ||
      !!(process.env.GEMINI_API_KEY)
    );
  }

  async getMatchRecommendation(matchData: MatchData, opts: AiOptions = {}): Promise<AIRecommendation> {
    const call = (extra = '') => {
      // Prefer DeepSeek if key exists, otherwise fall back to Gemini Flash (free tier)
      if (this.apiKey && this.apiKey.length > 10) return this.callDeepSeek(matchData, opts, extra);
      if (process.env.GEMINI_API_KEY) return this.callGemini(matchData, opts, extra);
      throw new Error('No AI API key configured (set DEEPSEEK_API_KEY or GEMINI_API_KEY)');
    };
    let result = await call();
    const words = opts.stopWords || [];
    let hits = stopWordHits(result, words);
    if (hits.length) {
      // «Заборонені слова — відповідь перепишеться»: one rewrite, then mask whatever is left.
      result = await call(`\nНе використовуй ці слова й вирази: ${words.map((w) => `«${w}»`).join(', ')}.`);
      hits = stopWordHits(result, words);
      if (hits.length) result = maskStopWords(result, hits);
    }
    return result;
  }

  async callDeepSeek(matchData: MatchData, opts: AiOptions = {}, extra = ''): Promise<AIRecommendation> {
    const prompt = this.buildPrompt(matchData, 'CS2') + extra;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemPrompt(opts) },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${err}`);
    }

    const data = await response.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    // DeepSeek deepseek-chat pricing (USD per 1M tokens)
    const cost = (promptTokens * 0.27 + completionTokens * 1.10) / 1_000_000;
    void recordAiUsage({ userId: opts.userId, provider: 'deepseek', model: this.model, promptTokens, completionTokens, cost, status: 'success' });
    return this.parseResponse(text);
  }

  /** Free Gemini Flash 2.0 fallback — works without DeepSeek key */
  async callGemini(matchData: MatchData, opts: AiOptions = {}, extra = ''): Promise<AIRecommendation> {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `${this.systemPrompt(opts)}\n\n${this.buildPrompt(matchData, 'esports')}${extra}`;
    const result = await Promise.race([
      model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini API timeout')), 15_000),
      ),
    ]);

    const text = (result as any).response.text();
    const usage = (result as any).response?.usageMetadata;
    const promptTokens = Number(usage?.promptTokenCount ?? 0);
    const completionTokens = Number(usage?.candidatesTokenCount ?? 0);
    // Gemini 2.0 Flash is free — track tokens, zero cost.
    void recordAiUsage({ userId: opts.userId, provider: 'gemini', model: 'gemini-2.0-flash', promptTokens, completionTokens, cost: 0, status: 'success' });
    return this.parseResponse(text);
  }

  /** Base instruction plus the wording rule from Налаштування. */
  private systemPrompt(opts: AiOptions): string {
    const base = 'Ти аналізуєш кіберспортивні матчі. Відповідай тільки у вказаному форматі.';
    return opts.rule ? `${base}\nПравило формулювань: ${opts.rule}` : base;
  }

  private buildPrompt(matchData: MatchData, game: string): string {
    const { team1, team2, format, tier, odds } = matchData;

    let prompt = `Ти експерт з аналізу матчів ${game === 'CS2' ? 'CS2' : 'кіберспорту'}. Проаналізуй наступний матч і опиши, що показують дані.\n\nМатч: ${team1} vs ${team2}\nФормат: ${format}\nРівень: ${tier}`;

    if (odds?.team1 && odds?.team2) {
      prompt += `\nКоефіцієнти: ${team1} - ${odds.team1}, ${team2} - ${odds.team2}`;
    }

    prompt += `\n\nНадай відповідь у наступному форматі (СТРОГО дотримуйся цього формату):\n
PREDICTION: [Назва команди-фаворита або "Рівні шанси"]
CONFIDENCE: [Число від 0 до 100]
REASONING: [Детальне обґрунтування 2-3 речення]
SUGGESTED_BET: [Що варто врахувати — без порад ставити й без обіцянок результату]
RISK_LEVEL: [low/medium/high]`;

    return prompt;
  }

  private parseResponse(text: string): AIRecommendation {
    const lines = text.split('\n');
    const result: AIRecommendation = {
      prediction: 'Unknown',
      confidence: 50,
      reasoning: 'Unable to parse AI response',
      suggestedBet: 'Skip',
      riskLevel: 'medium',
    };

    for (const line of lines) {
      if (line.includes('PREDICTION:')) {
        result.prediction = line.split('PREDICTION:')[1].trim();
      } else if (line.includes('CONFIDENCE:')) {
        result.confidence = parseInt(line.split('CONFIDENCE:')[1].trim().replace(/\D/g, ''), 10) || 50;
      } else if (line.includes('REASONING:')) {
        result.reasoning = line.split('REASONING:')[1].trim();
      } else if (line.includes('SUGGESTED_BET:')) {
        result.suggestedBet = line.split('SUGGESTED_BET:')[1].trim();
      } else if (line.includes('RISK_LEVEL:')) {
        const level = line.split('RISK_LEVEL:')[1].trim().toLowerCase();
        if (['low', 'medium', 'high'].includes(level)) {
          result.riskLevel = level as 'low' | 'medium' | 'high';
        }
      }
    }

    result.confidence = Math.max(0, Math.min(100, result.confidence));
    return result;
  }
}

export const deepSeekService = new DeepSeekService();
