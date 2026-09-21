import type { TurnTokenUsage } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return 0;
}

/** Normalize one provider-reported turn. `last` is preferred over the
 * cumulative thread total so repeated turns are never double counted. */
export function normalizeTurnTokenUsage(value: unknown): TurnTokenUsage {
  const usage = record(value);
  const last = record(usage.last);
  const source = Object.keys(last).length ? last : usage;
  const inputTokens = finite(source, "inputTokens", "input_tokens");
  const cachedInputTokens = finite(source, "cachedInputTokens", "cached_input_tokens");
  const outputTokens = finite(source, "outputTokens", "output_tokens");
  const reasoningOutputTokens = finite(source, "reasoningOutputTokens", "reasoning_output_tokens");
  const explicitTotal = finite(source, "totalTokens", "total_tokens");
  const modelContextWindow = finite(usage, "modelContextWindow", "model_context_window") || null;
  return {
    inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
    modelContextWindow,
  };
}
