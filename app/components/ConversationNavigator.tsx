"use client";

import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { sampleNavigationItems, type ConversationNavigationItem } from "../lib/conversation-navigation";

type Props = {
  items: ConversationNavigationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (item: ConversationNavigationItem) => void;
  onBrowse: () => void;
};

export function ConversationNavigator({ items, scrollRef, onJump, onBrowse }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(items.at(-1)?.id ?? null);
  const [progress, setProgress] = useState(1);
  const effectiveActiveId = items.some((item) => item.id === activeId) ? activeId : items.at(-1)?.id ?? null;
  const sampledItems = useMemo(() => {
    const sampled = sampleNavigationItems(items);
    const active = items.find((item) => item.id === effectiveActiveId);
    if (!active || sampled.some((item) => item.id === active.id)) return sampled;
    let replaceIndex = 1;
    for (let index = 2; index < sampled.length - 1; index += 1) {
      if (Math.abs(sampled[index].ordinal - active.ordinal) < Math.abs(sampled[replaceIndex].ordinal - active.ordinal)) replaceIndex = index;
    }
    return sampled.map((item, index) => index === replaceIndex ? active : item).sort((left, right) => left.ordinal - right.ordinal);
  }, [effectiveActiveId, items]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () => {
      frame.current = null;
      const maximum = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      setProgress(Math.max(0, Math.min(1, scroller.scrollTop / maximum)));
      const target = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.32;
      let closest: { id: number; distance: number } | null = null;
      for (const element of scroller.querySelectorAll<HTMLElement>("[data-conversation-message-id]")) {
        const id = Number(element.dataset.conversationMessageId);
        const distance = Math.abs(element.getBoundingClientRect().top - target);
        if (Number.isFinite(id) && (!closest || distance < closest.distance)) closest = { id, distance };
      }
      if (closest) setActiveId(closest.id);
    };
    const schedule = () => {
      if (frame.current === null) frame.current = window.requestAnimationFrame(update);
    };
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, [items, scrollRef]);

  function dragThumb(event: ReactPointerEvent<HTMLButtonElement>) {
    const rail = railRef.current;
    const scroller = scrollRef.current;
    if (!rail || !scroller) return;
    event.preventDefault();
    onBrowse();
    event.currentTarget.setPointerCapture(event.pointerId);
    const update = (clientY: number) => {
      const bounds = rail.getBoundingClientRect();
      const next = Math.max(0, Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height)));
      scroller.scrollTop = next * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    };
    update(event.clientY);
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientY);
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  if (items.length < 2) return null;
  const total = items.length;
  return <aside className="conversation-navigator" aria-label={`对话位置导航，共 ${total} 轮`}>
    <div className="conversation-navigator-rail" ref={railRef}>
      <button
        type="button"
        className="conversation-navigator-thumb"
        style={{ top: `${progress * 100}%` }}
        onPointerDown={dragThumb}
        aria-label="拖动浏览对话记录"
        title="拖动浏览对话"
      />
      {sampledItems.map((item) => {
        const position = total <= 1 ? 0 : (item.ordinal - 1) / (total - 1);
        const active = item.id === effectiveActiveId;
        const edge = item.ordinal === 1 ? "edge-start" : item.ordinal === total ? "edge-end" : "";
        return <button
          type="button"
          key={item.id}
          className={`conversation-navigator-marker ${active ? "active" : ""} ${edge}`}
          style={{ top: `${position * 100}%` }}
          onClick={() => onJump(item)}
          aria-label={`跳到第 ${item.ordinal} 轮：${item.preview || "空消息"}`}
          aria-current={active ? "location" : undefined}
        >
          <span className="conversation-navigator-preview" role="tooltip"><b>第 {item.ordinal} / {total} 轮</b><em>{item.preview || "（空消息）"}</em><time>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span>
        </button>;
      })}
    </div>
  </aside>;
}
