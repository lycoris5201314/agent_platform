"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type TerminalSession = { id: string; shell: string; sandboxMode: string; permissionProfile: string; status: "running" | "exited" };

export function TerminalPanel({ api, taskId }: { api: string; taskId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let stream: EventSource | null = null;
    let observer: ResizeObserver | null = null;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 12, scrollback: 4_000,
      theme: { background: "#1f201f", foreground: "#e7e7e1", cursor: "#f2a65a", selectionBackground: "#59645f" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const resize = () => { try { fit.fit(); } catch { /* panel can be hidden while resizing */ } };
    resize();
    void fetch(`${api}/api/tasks/${taskId}/terminal/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }) })
      .then(async (response) => {
        const value = await response.json() as { session?: TerminalSession; error?: string };
        if (!response.ok || !value.session) throw new Error(value.error ?? "无法打开终端");
        if (disposed) return;
        const opened = value.session;
        setSession(opened);
        stream = new EventSource(`${api}/api/tasks/${taskId}/terminal/sessions/${opened.id}/stream`);
        stream.onmessage = (event) => { const chunk = JSON.parse(event.data) as { data?: string }; if (chunk.data) terminal.write(chunk.data); };
        stream.onerror = () => { if (!disposed) setError("终端连接已中断，切换标签页可重新连接。"); };
        terminal.onData((data) => { void fetch(`${api}/api/tasks/${taskId}/terminal/sessions/${opened.id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }); });
        const sendSize = () => void fetch(`${api}/api/tasks/${taskId}/terminal/sessions/${opened.id}/resize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }) });
        observer = new ResizeObserver(() => { resize(); sendSize(); });
        if (host.current) observer.observe(host.current);
      }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; stream?.close(); observer?.disconnect(); terminal.dispose(); };
  }, [api, taskId]);

  const close = async () => {
    if (!session) return;
    await fetch(`${api}/api/tasks/${taskId}/terminal/sessions/${session.id}`, { method: "DELETE" });
    setSession((current) => current ? { ...current, status: "exited" } : current);
  };

  return <div className="interactive-terminal"><header><span>{session ? `${session.shell} · ${session.permissionProfile}` : "正在启动交互终端…"}</span>{session?.status === "running" && <button onClick={() => void close()}>关闭终端</button>}</header>{error && <div className="terminal-error">{error}</div>}<div ref={host} className="xterm-host" aria-label="交互终端" /></div>;
}
