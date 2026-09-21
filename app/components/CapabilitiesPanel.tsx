"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeCapabilityCatalog, type CapabilityCatalog } from "../lib/capability-catalog";
import { PluginPanel } from "./PluginPanel";

type Props = { api: string; cwd: string; provider: string; taskId?: string; onNotice: (message: string) => void };
type McpOAuthOperation = { id: string; name: string; authorizationUrl: string; status: "pending" | "succeeded" | "failed"; error: string | null; expiresAt: string };

export function CapabilitiesPanel({ api, cwd, provider, taskId, onNotice }: Props) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [pluginCount, setPluginCount] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [oauthOperation, setOauthOperation] = useState<McpOAuthOperation | null>(null);
  const oauthOperationId = oauthOperation?.id;
  const oauthOperationName = oauthOperation?.name;
  const oauthOperationStatus = oauthOperation?.status;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ cwd, provider });
      if (taskId) query.set("taskId", taskId);
      const response = await fetch(`${api}/api/codex/catalog?${query}`, { cache: "no-store" });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(value.error ?? "无法读取 Codex 能力"));
      setCatalog(normalizeCapabilityCatalog(value));
    } catch (error) {
      setCatalog({ healthy: false, features: { namespaceTools: false, imageGeneration: false, webSearch: false }, skills: [], mcpServers: [], permissionProfiles: [], collaborationModes: [], errors: [{ section: "catalog", message: error instanceof Error ? error.message : String(error) }] });
    } finally { setLoading(false); }
  }, [api, cwd, provider, taskId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!oauthOperationId || !oauthOperationName || oauthOperationStatus !== "pending") return;
    const operationId = oauthOperationId;
    const serverName = oauthOperationName;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`${api}/api/codex/mcp/oauth/${encodeURIComponent(operationId)}`, { cache: "no-store" });
        const value = await response.json() as { operation?: McpOAuthOperation; error?: string };
        if (!response.ok || !value.operation) throw new Error(value.error ?? "无法读取授权状态");
        if (stopped) return;
        setOauthOperation(value.operation);
        if (value.operation.status === "succeeded") { onNotice(`${serverName} 已连接。`); await refresh(); }
        else if (value.operation.status === "failed") onNotice(value.operation.error ?? `${serverName} 授权失败`);
      } catch (error) { if (!stopped) onNotice(error instanceof Error ? error.message : String(error)); }
    };
    const timer = window.setInterval(() => void poll(), 1_500);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [api, oauthOperationId, oauthOperationName, oauthOperationStatus, onNotice, refresh]);

  async function toggleSkill(path: string, enabled: boolean) {
    setBusyItem(path);
    try {
      const response = await fetch(`${api}/api/codex/skills/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, enabled, provider, taskId }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Skill 配置失败");
      onNotice(`Skill 已${enabled ? "启用" : "禁用"}。`);
      await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyItem(null); }
  }

  async function reloadMcp() {
    setBusyItem("mcp");
    try {
      const response = await fetch(`${api}/api/codex/mcp/reload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, taskId }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "MCP 重载失败");
      onNotice("MCP 配置已重新加载。");
      await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyItem(null); }
  }

  async function authorizeMcp(name: string) {
    setBusyItem(`mcp:${name}`);
    try {
      const response = await fetch(`${api}/api/codex/mcp/oauth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, provider, taskId }) });
      const value = await response.json() as { operation?: McpOAuthOperation; error?: string };
      if (!response.ok || !value.operation) throw new Error(value.error ?? "无法开始 MCP 授权");
      setOauthOperation(value.operation);
      window.open(value.operation.authorizationUrl, "_blank", "noopener,noreferrer");
      onNotice(`已开始连接 ${name}，请在浏览器完成授权。`);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyItem(null); }
  }

  return <section className="capability-center">
    <header><div><h3>能力中心</h3><p>{provider} · 管理当前运行时真正可调用的插件、Skills、MCP 与权限</p></div><button type="button" disabled={loading || busyItem !== null} onClick={() => { setRefreshSignal((value) => value + 1); void refresh(); }}>{loading ? "检测中…" : "重新检测"}</button></header>
    {!catalog ? <div className="capability-loading">正在连接 Codex App Server…</div> : <>
      {catalog.errors.length > 0 && <div className="capability-errors"><strong>部分能力无法读取</strong>{catalog.errors.map((error) => <p key={error.section}><b>{error.section}</b>{error.message}</p>)}</div>}
      <div className="capability-summary">
        <span className={catalog.features.webSearch ? "available" : "off"}>联网搜索</span><span className={catalog.features.imageGeneration ? "available" : "off"}>图像生成</span><span className={catalog.features.namespaceTools ? "available" : "off"}>命名工具</span>
        <span>{pluginCount} 个插件</span><span>{catalog.skills.filter((skill) => skill.enabled).length} 个 Skills</span><span>{catalog.mcpServers.filter((server) => server.status === "connected").length} / {catalog.mcpServers.length} 个 MCP 已连接</span>
      </div>
      <PluginPanel api={api} refreshSignal={refreshSignal} onNotice={onNotice} onCount={setPluginCount} />
      <details open className="capability-group"><summary>Skills <small>{catalog.skills.length}</small></summary><div className="capability-list">{catalog.skills.length ? catalog.skills.map((skill) => <div className="capability-row" key={skill.path}><span className={`capability-dot ${skill.enabled ? "connected" : "off"}`} /><div><strong>{skill.name}</strong><p>{skill.description || skill.path}</p><small>{skill.pluginId ?? skill.scope}</small></div><button type="button" disabled={busyItem !== null} onClick={() => void toggleSkill(skill.path, !skill.enabled)}>{busyItem === skill.path ? "处理中…" : skill.enabled ? "禁用" : "启用"}</button></div>) : <div className="capability-empty">当前工作区没有发现 Skill。可在上方添加额外目录后保存并重新检测。</div>}</div></details>
      <details open className="capability-group"><summary>MCP 连接 <small>{catalog.mcpServers.length}</small><button type="button" disabled={busyItem !== null} onClick={(event) => { event.preventDefault(); void reloadMcp(); }}>{busyItem === "mcp" ? "重载中…" : "重新加载"}</button></summary>{oauthOperation?.status === "pending" && <div className="oauth-progress"><span>正在等待 {oauthOperation.name} 授权完成</span><a href={oauthOperation.authorizationUrl} target="_blank" rel="noreferrer">在浏览器继续授权</a></div>}{oauthOperation?.status === "failed" && <div className="oauth-progress failed"><span>{oauthOperation.error ?? "授权失败"}</span><button type="button" onClick={() => setOauthOperation(null)}>关闭</button></div>}<div className="capability-list">{catalog.mcpServers.length ? catalog.mcpServers.map((server) => <div className="capability-row" key={server.name}><span className={`capability-dot ${server.status}`} /><div><strong>{server.name}</strong><p>{server.status === "connected" ? `已连接 · ${server.toolCount} 个工具` : server.status === "degraded" ? "正在连接或等待授权" : server.error ?? "当前不可用"}</p><small>{server.pluginId ?? `授权：${server.authStatus}`}</small></div>{server.authStatus === "notLoggedIn" ? <button type="button" disabled={busyItem !== null || oauthOperation?.status === "pending"} onClick={() => void authorizeMcp(server.name)}>{busyItem === `mcp:${server.name}` ? "启动中…" : "连接"}</button> : <em>{server.authStatus === "oAuth" ? "已授权" : server.authStatus === "bearerToken" ? "令牌" : "无需授权"}</em>}</div>) : <div className="capability-empty">尚未发现 MCP 服务。请先设置 config.toml，再点击重新加载。</div>}</div></details>
      <div className="capability-footer"><span>权限：{catalog.permissionProfiles.join(" · ") || "未报告"}</span><span>模式：{catalog.collaborationModes.join(" · ") || "未报告"}</span></div>
    </>}
  </section>;
}
