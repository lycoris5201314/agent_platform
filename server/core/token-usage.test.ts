import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTurnTokenUsage } from "./token-usage.js";

test("normalizes provider token usage without counting cumulative totals twice", () => {
  assert.deepEqual(normalizeTurnTokenUsage({
    last: { inputTokens: 800, cachedInputTokens: 300, outputTokens: 200, reasoningOutputTokens: 50, totalTokens: 1_000 },
    total: { inputTokens: 8_000, outputTokens: 2_000, totalTokens: 10_000 }, modelContextWindow: 128_000,
  }), { inputTokens: 800, cachedInputTokens: 300, outputTokens: 200, reasoningOutputTokens: 50, totalTokens: 1_000, modelContextWindow: 128_000 });
  assert.deepEqual(normalizeTurnTokenUsage({ input_tokens: 7, output_tokens: 3 }), {
    inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 10, modelContextWindow: null,
  });
});
