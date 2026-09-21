"use client";

import { FormEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type DialogBaseProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onCancel: () => void;
};

function useDialogFocus(open: boolean, busy: boolean, onCancel: () => void) {
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; }, [onCancel]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => primary.current?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      cancel.current();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [busy, open]);
  return primary;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "取消", busy = false, danger = false, onCancel, onConfirm }: DialogBaseProps & { onConfirm: () => void }) {
  const titleId = useId();
  const primary = useDialogFocus(open, busy, onCancel);
  if (!open || typeof document === "undefined") return null;
  return createPortal(<div className="modal-backdrop app-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
    <form className={`app-dialog ${danger ? "danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      <header><span className="app-dialog-icon" aria-hidden="true">{danger ? "!" : "?"}</span><div><h2 id={titleId}>{title}</h2><div className="app-dialog-description">{description}</div></div></header>
      <footer><button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button><button ref={primary} className={danger ? "danger-button" : "primary"} disabled={busy}>{busy ? "处理中…" : confirmLabel}</button></footer>
    </form>
  </div>, document.body);
}

type TextPromptDialogProps = DialogBaseProps & { onConfirm: (value: string) => void; placeholder?: string };

function OpenTextPromptDialog({ title, description, confirmLabel, cancelLabel = "取消", busy = false, onCancel, onConfirm, placeholder = "" }: Omit<TextPromptDialogProps, "open">) {
  const titleId = useId();
  const [value, setValue] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      cancel.current();
    };
    window.addEventListener("keydown", keydown);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [busy]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.trim()) onConfirm(value.trim()); };
  return <div className="modal-backdrop app-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
    <form className="app-dialog prompt-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}>
      <header><span className="app-dialog-icon" aria-hidden="true">✎</span><div><h2 id={titleId}>{title}</h2><div className="app-dialog-description">{description}</div></div></header>
      <textarea ref={input} value={value} onChange={(event) => setValue(event.target.value)} rows={5} placeholder={placeholder} disabled={busy} />
      <footer><button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button><button className="primary" disabled={busy || !value.trim()}>{busy ? "正在保存…" : confirmLabel}</button></footer>
    </form>
  </div>;
}

export function TextPromptDialog({ open, ...props }: TextPromptDialogProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<OpenTextPromptDialog {...props} />, document.body);
}
