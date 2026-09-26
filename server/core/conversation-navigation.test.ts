import assert from "node:assert/strict";
import test from "node:test";
import { requiredRecentTurnCount, sampleNavigationItems, type ConversationNavigationItem } from "../../app/lib/conversation-navigation.js";

test("computes the recent turn window needed for a historical jump", () => {
  assert.equal(requiredRecentTurnCount(120, 120), 1);
  assert.equal(requiredRecentTurnCount(120, 91), 30);
  assert.equal(requiredRecentTurnCount(120, 1), 120);
  assert.equal(requiredRecentTurnCount(120, -10), 120);
});

test("samples a long conversation navigation rail while preserving both ends", () => {
  const items: ConversationNavigationItem[] = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, turn: index, ordinal: index + 1, preview: `turn ${index + 1}`, createdAt: new Date(2026, 0, 1, 0, index).toISOString() }));
  const sampled = sampleNavigationItems(items, 40);
  assert.equal(sampled.length, 40);
  assert.equal(sampled[0].id, 1);
  assert.equal(sampled.at(-1)?.id, 500);
  assert.equal(new Set(sampled.map((item) => item.id)).size, sampled.length);
});
