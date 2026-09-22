"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type TerminalSession = { id: string; shell: string; sandboxMode: string; permissionProfile: string; status: "running" | "exited" };

export function TerminalPanel({ api, taskId }: { api: string; taskId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let stream: EventSource | null = null;
    let observer: ResizeObserver | null = null;
    let inputTimer: number | null = null;
    let resizeTimer: number | null = null;
    let inputBuffer = "";
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
        stream.onopen = () => { if (!disposed) setError(null); };
        stream.onmessage = (event) => {
          try { const chunk = JSON.parse(event.data) as { data?: string }; if (chunk.data) terminal.write(chunk.data); }
          catch { if (!disposed) setError("收到无法识别的终端输出，正在等待下一条数据。"); }
        };
        stream.onerror = () => { if (!disposed) setError("终端连接暂时中断，正在自动重新连接…"); };
        const post = async (suffix: "input" | "resize", body: object) => {
          try {
            const response = await fetch(`${api}/api/tasks/${taskId}/terminal/sessions/${opened.id}/${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (!disposed) setError(null);
          } catch {
            if (!disposed) setError("终端操作未送达，连接恢复后请重试。");
          }
        };
        const flushInput = () => {
          inputTimer = null;
          const data = inputBuffer;
          inputBuffer = "";
          if (data) void post("input", { data });
        };
        terminal.onData((data) => {
          inputBuffer += data;
          while (inputBuffer.length >= 32_000) {
            const chunk = inputBuffer.slice(0, 32_000);
            inputBuffer = inputBuffer.slice(32_000);
            void post("input", { data: chunk });
          }
          if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 16);
        });
        const sendSize = () => void post("resize", { cols: terminal.cols, rows: terminal.rows });
        observer = new ResizeObserver(() => {
          resize();
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(sendSize, 80);
        });
        if (host.current) observer.observe(host.current);
      }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      disposed = true; stream?.close(); observer?.disconnect(); terminal.dispose();
    };
  }, [api, taskId]);

  const close = async () => {
    if (!session || closing) return;
    setClosing(true); setError(null);
    try {
      const response = await fetch(`${api}/api/tasks/${taskId}/terminal/sessions/${session.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSession((current) => current ? { ...current, status: "exited" } : current);
    } catch { setError("关闭终端失败，请检查本地服务后重试。"); }
    finally { setClosing(false); }
  };

  return <div className="interactive-terminal"><header><span>{session ? `${session.shell} · ${session.permissionProfile}` : "正在启动交互终端…"}</span>{session?.status === "running" && <button onClick={() => void close()} disabled={closing}>{closing ? "关闭中…" : "关闭终端"}</button>}</header>{error && <div className="terminal-error" role="status">{error}</div>}<div ref={host} className="xterm-host" aria-label="交互终端" /></div>;
}
