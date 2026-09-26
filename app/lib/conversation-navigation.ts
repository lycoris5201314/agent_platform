export type ConversationNavigationItem = {
  id: number;
  turn: number;
  ordinal: number;
  preview: string;
  createdAt: string;
};

export function conversationTurnElementId(messageId: number): string {
  return `conversation-turn-${messageId}`;
}

export function requiredRecentTurnCount(totalTurns: number, ordinal: number): number {
  if (!Number.isFinite(totalTurns) || totalTurns <= 0) return 1;
  const boundedOrdinal = Math.max(1, Math.min(Math.floor(ordinal), Math.floor(totalTurns)));
  return Math.max(1, Math.floor(totalTurns) - boundedOrdinal + 1);
}

export function sampleNavigationItems(items: ConversationNavigationItem[], maximum = 96): ConversationNavigationItem[] {
  const limit = Math.max(2, Math.floor(maximum));
  if (items.length <= limit) return items;
  const sampled: ConversationNavigationItem[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const item = items[Math.round(index * (items.length - 1) / (limit - 1))];
    if (!seen.has(item.id)) {
      seen.add(item.id);
      sampled.push(item);
    }
  }
  return sampled;
}
