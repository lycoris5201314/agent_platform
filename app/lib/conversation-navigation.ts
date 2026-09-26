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
