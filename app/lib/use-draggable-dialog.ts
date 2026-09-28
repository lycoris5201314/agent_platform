"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

type Rect = { left: number; top: number; right: number; bottom: number };
type Viewport = { width: number; height: number };

export function clampDialogDelta(rect: Rect, deltaX: number, deltaY: number, viewport: Viewport, padding = 8): { x: number; y: number } {
  return {
    x: Math.max(padding - rect.left, Math.min(deltaX, viewport.width - padding - rect.right)),
    y: Math.max(padding - rect.top, Math.min(deltaY, viewport.height - padding - rect.bottom)),
  };
}

export function useDraggableDialog(open: boolean) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const stopActiveDragRef = useRef<(() => void) | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) {
      stopActiveDragRef.current?.();
      return;
    }
    const timer = window.setTimeout(() => {
      setOffset({ x: 0, y: 0 });
      setDragging(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => () => stopActiveDragRef.current?.(), []);

  useEffect(() => {
    if (!open) return;
    const keepVisible = () => {
      const rect = dialogRef.current?.getBoundingClientRect();
      if (!rect) return;
      const correction = clampDialogDelta(rect, 0, 0, { width: window.innerWidth, height: window.innerHeight });
      if (correction.x || correction.y) setOffset((current) => ({ x: current.x + correction.x, y: current.y + correction.y }));
    };
    window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [open]);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, textarea, select, a"))) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    stopActiveDragRef.current?.();
    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    const start = { clientX: event.clientX, clientY: event.clientY, offset };
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      const delta = clampDialogDelta(rect, moveEvent.clientX - start.clientX, moveEvent.clientY - start.clientY, { width: window.innerWidth, height: window.innerHeight });
      setOffset({ x: start.offset.x + delta.x, y: start.offset.y + delta.y });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopActiveDragRef.current = null;
    };
    const finish = () => {
      cleanup();
      setDragging(false);
    };
    stopActiveDragRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  return [
    dialogRef,
    { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` } satisfies CSSProperties,
    { className: `dialog-drag-handle ${dragging ? "dragging" : ""}`, onPointerDown, title: "按住拖动对话框" },
  ] as const;
}
