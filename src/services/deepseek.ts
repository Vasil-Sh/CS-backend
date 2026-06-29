// ═══════════════════════════════════════════
// DeepSeek AI proxy service (server-side)
// ═══════════════════════════════════════════

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
    return !!this.apiKey && this.apiKey.length > 10;
  }

  async getMatchRecommendation(matchData: MatchData): Promise<AIRecommendation> {
    if (!this.isConfigured()) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }

    const prompt = this.buildPrompt(matchData);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'Ти експерт з аналізу матчів CS2. Відповідай тільки у вказаному форматі.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return this.parseResponse(text);
  }

  private buildPrompt(matchData: MatchData): string {
    const { team1, team2, format, tier, odds } = matchData;

    let prompt = `Ти експерт з аналізу матчів CS2 (Counter-Strike 2). Проаналізуй наступний матч і дай свою рекомендацію для ставки.\n\nМатч: ${team1} vs ${team2}\nФормат: ${format}\nРівень: ${tier}`;

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
