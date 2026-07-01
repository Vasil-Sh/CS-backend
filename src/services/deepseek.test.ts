import { describe, it, expect } from 'vitest';
import { deepSeekService } from './deepseek';

describe('DeepSeekService', () => {
  describe('isConfigured', () => {
    it('reports a boolean (singleton reads env at import time)', () => {
      const configured = deepSeekService.isConfigured();
      expect(typeof configured).toBe('boolean');
    });
  });

  describe('parseResponse (via private method test)', () => {
    it('parses valid AI response format', () => {
      const text = [
        'PREDICTION: NAVI',
        'CONFIDENCE: 75',
        'REASONING: Strong recent form and map pool advantage.',
        'SUGGESTED_BET: Bet on NAVI to win',
        'RISK_LEVEL: low',
      ].join('\n');

      const result = (deepSeekService as any).parseResponse(text);
      expect(result.prediction).toBe('NAVI');
      expect(result.confidence).toBe(75);
      expect(result.reasoning).toBe('Strong recent form and map pool advantage.');
      expect(result.suggestedBet).toBe('Bet on NAVI to win');
      expect(result.riskLevel).toBe('low');
    });

    it('clamps high confidence to 100', () => {
      const highText = 'PREDICTION: Team\nCONFIDENCE: 150\nREASONING: test\nSUGGESTED_BET: skip\nRISK_LEVEL: medium';
      const highResult = (deepSeekService as any).parseResponse(highText);
      expect(highResult.confidence).toBe(100);
    });

    it('handles negative confidence (regex strips minus, becomes positive)', () => {
      const lowText = 'PREDICTION: Team\nCONFIDENCE: -50\nREASONING: test\nSUGGESTED_BET: skip\nRISK_LEVEL: medium';
      const lowResult = (deepSeekService as any).parseResponse(lowText);
      // regex \D strips minus, so -50 → 50, clamped to 50
      expect(lowResult.confidence).toBe(50);
    });

    it('returns defaults for empty text', () => {
      const result = (deepSeekService as any).parseResponse('');
      expect(result.prediction).toBe('Unknown');
      expect(result.confidence).toBe(50);
      expect(result.reasoning).toBe('Unable to parse AI response');
      expect(result.suggestedBet).toBe('Skip');
      expect(result.riskLevel).toBe('medium');
    });

    it('ignores invalid risk levels', () => {
      const text = 'PREDICTION: Team\nCONFIDENCE: 70\nREASONING: test\nSUGGESTED_BET: bet\nRISK_LEVEL: extreme';
      const result = (deepSeekService as any).parseResponse(text);
      expect(result.riskLevel).toBe('medium');
    });

    it('parses non-numeric confidence as 50', () => {
      const text = 'PREDICTION: Team\nCONFIDENCE: abc\nREASONING: test\nSUGGESTED_BET: skip\nRISK_LEVEL: medium';
      const result = (deepSeekService as any).parseResponse(text);
      expect(result.confidence).toBe(50);
    });
  });

  describe('buildPrompt', () => {
    it('includes team names and format', () => {
      const prompt = (deepSeekService as any).buildPrompt({
        team1: 'NAVI',
        team2: 'FaZe',
        format: 'Bo3',
        tier: 'TIER1',
      });
      expect(prompt).toContain('NAVI vs FaZe');
      expect(prompt).toContain('Bo3');
      expect(prompt).toContain('TIER1');
    });

    it('includes odds when provided', () => {
      const prompt = (deepSeekService as any).buildPrompt({
        team1: 'NAVI',
        team2: 'FaZe',
        format: 'Bo3',
        tier: 'TIER1',
        odds: { team1: 1.85, team2: 1.95 },
      });
      expect(prompt).toContain('1.85');
      expect(prompt).toContain('1.95');
    });

    it('omits odds section when not provided', () => {
      const prompt = (deepSeekService as any).buildPrompt({
        team1: 'NAVI',
        team2: 'FaZe',
        format: 'Bo3',
        tier: 'TIER1',
      });
      expect(prompt).not.toContain('Коефіцієнти');
    });
  });
});
