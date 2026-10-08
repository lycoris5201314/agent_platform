"use client";

import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

type Position = { x: number; y: number };

export function MovableComposer({ children, draft = false }: { children: ReactNode; draft?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const position = useRef<Position>({ x: 0, y: 0 });
  const cleanupDrag = useRef<(() => void) | null>(null);
  const [offset, setOffset] = useState<Position>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  function moveTo(next: Position) {
    position.current = next;
    setOffset(next);
  }

  function constrain(rect: DOMRect, delta: Position): Position {
    const pane = surface.current?.closest(".conversation-pane");
    const bounds = pane?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    const header = pane?.querySelector(":scope > .conversation-header")?.getBoundingClientRect();
    return {
      x: Math.max(bounds.left + 6 - rect.left, Math.min(delta.x, bounds.right - 6 - rect.right)),
      y: Math.max((header?.bottom ?? bounds.top) + 6 - rect.top, Math.min(delta.y, bounds.bottom - 6 - rect.bottom)),
    };
  }

  function reset() {
    cleanupDrag.current?.();
    setDragging(false);
    moveTo({ x: 0, y: 0 });
  }

  useEffect(() => {
    const element = surface.current;
    const pane = element?.closest(".conversation-pane");
    if (!element || !pane) return;
    let frame = 0;
    const keepVisible = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const bounds = pane.getBoundingClientRect();
        const header = pane.querySelector(":scope > .conversation-header")?.getBoundingClientRect();
        const x = Math.max(bounds.left + 6 - rect.left, Math.min(0, bounds.right - 6 - rect.right));
        const y = Math.max((header?.bottom ?? bounds.top) + 6 - rect.top, Math.min(0, bounds.bottom - 6 - rect.bottom));
        if (Math.abs(x) > .5 || Math.abs(y) > .5) {
          const next = { x: position.current.x + x, y: position.current.y + y };
          position.current = next;
          setOffset(next);
        }
      });
    };
    const observer = new ResizeObserver(keepVisible);
    observer.observe(element);
    observer.observe(pane);
    window.addEventListener("resize", keepVisible);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepVisible);
      cancelAnimationFrame(frame);
      cleanupDrag.current?.();
    };
  }, []);

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !surface.current) return;
    event.preventDefault();
    cleanupDrag.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const rect = surface.current.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, offset: position.current };
    handle.setPointerCapture(pointerId);
    setDragging(true);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const delta = constrain(rect, { x: next.clientX - start.x, y: next.clientY - start.y });
      moveTo({ x: start.offset.x + delta.x, y: start.offset.y + delta.y });
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("blur", finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      cleanupDrag.current = null;
    };
    const finish = () => { cleanup(); setDragging(false); };
    cleanupDrag.current = cleanup;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    window.addEventListener("blur", finish);
  }

  return <div className={`composer-dock movable-composer-dock ${draft ? "draft-composer-dock" : ""}`}>
    <div ref={surface} className={`composer-movable ${dragging ? "is-dragging" : ""}`} style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
      <div className="composer-move-toolbar">
        <button type="button" className="composer-drag-handle" aria-label="拖动消息输入框" title="按住拖动；方向键移动；双击或 Home 恢复底部位置" onPointerDown={startDrag} onDoubleClick={reset} onKeyDown={(event) => {
          if (event.key === "Home") { event.preventDefault(); reset(); return; }
          const step = event.shiftKey ? 48 : 16;
          const direction: Record<string, Position> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
          if (!direction[event.key] || !surface.current) return;
          event.preventDefault();
          const delta = constrain(surface.current.getBoundingClientRect(), direction[event.key]);
          moveTo({ x: position.current.x + delta.x, y: position.current.y + delta.y });
        }}><span aria-hidden="true">⠿</span> 按住拖动输入框</button>
        <button type="button" className="composer-reset-position" disabled={Math.abs(offset.x) < .5 && Math.abs(offset.y) < .5} onClick={reset}>恢复底部位置</button>
      </div>
      {children}
    </div>
  </div>;
}
