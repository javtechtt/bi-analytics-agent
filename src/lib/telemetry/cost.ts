/**
 * Phase 0: OpenAI pricing table and cost computation.
 *
 * Prices are USD per 1M tokens. Update when OpenAI changes pricing.
 * For embeddings the rate is per 1M total tokens (no output dimension).
 * Realtime audio is billed per minute, not per token, so it's handled
 * separately in the realtime session route — not in this table.
 *
 * Source: https://openai.com/pricing (verify quarterly).
 * Last verified: 2026-01.
 */

export interface ModelPricing {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens (0 for embeddings)
}

/** Per-million-token pricing. Add new models here as we adopt them. */
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // Chat / completion / structured-output models
  "gpt-4.1":             { input: 2.00,  output: 8.00 },
  "gpt-4.1-mini":        { input: 0.40,  output: 1.60 },
  "gpt-4o":              { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":         { input: 0.15,  output: 0.60 },
  "gpt-4o-mini-transcribe": { input: 0.15, output: 0.60 },

  // Reasoning models
  "o4-mini":             { input: 1.10,  output: 4.40 },
  "o3-mini":             { input: 1.10,  output: 4.40 },

  // Embeddings (input only — output dimension is the vector, not billed by token)
  "text-embedding-3-small": { input: 0.02, output: 0.00 },
  "text-embedding-3-large": { input: 0.13, output: 0.00 },
};

/**
 * Compute USD cost for a single call. Returns 0 if the model isn't in the
 * pricing table (with a console warning so we add it). Token counts may be
 * null when OpenAI doesn't return usage; in that case the call cost is null
 * and aggregate dashboards will show the gap.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  const pricing = OPENAI_PRICING[model];
  if (!pricing) {
    if (typeof console !== "undefined") {
      console.warn(`[telemetry/cost] Unknown model "${model}" — pricing not recorded`);
    }
    return null;
  }
  const inCost = ((inputTokens ?? 0) / 1_000_000) * pricing.input;
  const outCost = ((outputTokens ?? 0) / 1_000_000) * pricing.output;
  return Number((inCost + outCost).toFixed(6));
}

/**
 * Format a cost value for display. Sub-cent gets ¢ notation, sub-$0.01M gets
 * USD with 4 decimals, everything else gets 2 decimals.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `${(usd * 100).toFixed(3)}¢`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
