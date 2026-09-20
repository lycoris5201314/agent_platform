export type ScreenPoint = { x: number; y: number };
export type WindowRectangle = { x: number; y: number; width: number; height: number };
export type WindowSize = { width: number; height: number };

export function isScreenPoint(value: unknown): value is ScreenPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ScreenPoint>;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isPointOutsideWindow(point: ScreenPoint, bounds: WindowRectangle, margin = 6): boolean {
  return point.x < bounds.x - margin
    || point.x > bounds.x + bounds.width + margin
    || point.y < bounds.y - margin
    || point.y > bounds.y + bounds.height + margin;
}

export function clampDetachedWindowPosition(point: ScreenPoint, workArea: WindowRectangle, size: WindowSize): ScreenPoint {
  const maximumX = Math.max(workArea.x, workArea.x + workArea.width - size.width);
  const maximumY = Math.max(workArea.y, workArea.y + workArea.height - size.height);
  return {
    x: Math.round(Math.min(maximumX, Math.max(workArea.x, point.x - 72))),
    y: Math.round(Math.min(maximumY, Math.max(workArea.y, point.y - 28))),
  };
}

export function conversationWindowUrl(siteOrigin: string, apiOrigin: string, taskId: string): string {
  const url = new URL(siteOrigin);
  url.searchParams.set("api", apiOrigin);
  url.searchParams.set("task", taskId);
  url.searchParams.set("detached", "1");
  return url.toString();
}
