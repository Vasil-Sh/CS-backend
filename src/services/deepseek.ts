// ═══════════════════════════════════════════
// DeepSeek AI proxy service (server-side)
// Falls back to Google Gemini Flash (free tier) if DeepSeek key is missing.
// ═══════════════════════════════════════════

import { GoogleGenerativeAI } from '@google/generative-ai';

interface MatchData {
  team1: string;
  team2: string;
  format: string;
  tier: string;
  odds?: { team1?: number; team2?: number };
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

  async getMatchRecommendation(matchData: MatchData): Promise<AIRecommendation> {
    // Prefer DeepSeek if key exists, otherwise fall back to Gemini Flash (free tier)
    if (this.apiKey && this.apiKey.length > 10) {
      return this.callDeepSeek(matchData);
    }
    if (process.env.GEMINI_API_KEY) {
      return this.callGemini(matchData);
    }
    throw new Error('No AI API key configured (set DEEPSEEK_API_KEY or GEMINI_API_KEY)');
  }

  async callDeepSeek(matchData: MatchData): Promise<AIRecommendation> {
    const prompt = this.buildPrompt(matchData, 'CS2');

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'Ти експерт з аналізу матчів. Відповідай тільки у вказаному форматі.' },
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

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content || '';
    return this.parseResponse(text);
  }

  /** Free Gemini Flash 2.0 fallback — works without DeepSeek key */
  async callGemini(matchData: MatchData): Promise<AIRecommendation> {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = this.buildPrompt(matchData, 'esports');
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
    return this.parseResponse(text);
  }

  private buildPrompt(matchData: MatchData, game: string): string {
    const { team1, team2, format, tier, odds } = matchData;

    let prompt = `Ти експерт з аналізу матчів ${game === 'CS2' ? 'CS2' : 'кіберспорту'}. Проаналізуй наступний матч і дай свою рекомендацію для ставки.\n\nМатч: ${team1} vs ${team2}\nФормат: ${format}\nРівень: ${tier}`;

    if (odds?.team1 && odds?.team2) {
      prompt += `\nКоефіцієнти: ${team1} - ${odds.team1}, ${team2} - ${odds.team2}`;
    }

    prompt += `\n\nНадай відповідь у наступному форматі (СТРОГО дотримуйся цього формату):\n
PREDICTION: [Назва команди-фаворита або "Рівні шанси"]
CONFIDENCE: [Число від 0 до 100]
REASONING: [Детальне обґрунтування 2-3 речення]
SUGGESTED_BET: [Конкретна рекомендація]
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
