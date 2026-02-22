// Service pricing (as of Feb 2026)
export const PRICING = {
  // Anthropic Claude Sonnet 4 — per token
  anthropic: {
    inputPerToken: 3.0 / 1_000_000, // $3.00 / 1M input tokens
    outputPerToken: 15.0 / 1_000_000, // $15.00 / 1M output tokens
    cachedInputPerToken: 0.3 / 1_000_000, // $0.30 / 1M cached input tokens
  },
  // Deepgram Nova-3 streaming — per minute
  deepgram: {
    perMinute: 0.0077, // $0.0077 / minute of audio
  },
  // Cartesia Sonic — per character
  cartesia: {
    perCharacter: 46.7 / 1_000_000, // $46.70 / 1M characters
  },
};

export interface CostBreakdown {
  stt: number;
  llm: number;
  tts: number;
  total: number;
}

export interface CostUpdate {
  type: 'cost_update';
  service: 'stt' | 'llm' | 'tts';
  cost: number;
  session: CostBreakdown;
}

export class CostTracker {
  private stt = 0;
  private llm = 0;
  private tts = 0;

  addStt(audioDurationMs: number): number {
    const cost = (audioDurationMs / 60_000) * PRICING.deepgram.perMinute;
    this.stt += cost;
    return cost;
  }

  addLlm(promptTokens: number, completionTokens: number, cachedTokens = 0): number {
    const uncached = Math.max(0, promptTokens - cachedTokens);
    const cost =
      uncached * PRICING.anthropic.inputPerToken +
      cachedTokens * PRICING.anthropic.cachedInputPerToken +
      completionTokens * PRICING.anthropic.outputPerToken;
    this.llm += cost;
    return cost;
  }

  addTts(charactersCount: number): number {
    const cost = charactersCount * PRICING.cartesia.perCharacter;
    this.tts += cost;
    return cost;
  }

  getSession(): CostBreakdown {
    return {
      stt: this.stt,
      llm: this.llm,
      tts: this.tts,
      total: this.stt + this.llm + this.tts,
    };
  }
}

export function formatCost(dollars: number): string {
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}
