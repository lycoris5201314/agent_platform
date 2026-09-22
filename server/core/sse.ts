export function sseResumeOffset(queryOffset: unknown, lastEventId: unknown): number {
  const values = [queryOffset, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId]
    .map((value) => typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN)
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return values.length > 0 ? Math.max(...values) : 0;
}

export function encodeSseEvent(id: number, value: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify(value)}\n\n`;
}
