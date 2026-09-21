"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeCapabilityCatalog, type CapabilityCatalog } from "../lib/capability-catalog";

type Props = { api: string; cwd: string; provider: string; taskId?: string; onNotice: (message: string) => void };

export function CapabilitiesPanel({ api, cwd, provider, taskId, onNotice }: Props) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string | null>(null);

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

  return <section className="capability-center">
    <header><div><h3>能力中心</h3><p>{provider} · 显示当前工作区真正可调用的 Skills、MCP 与权限</p></div><button type="button" disabled={loading || busyItem !== null} onClick={() => void refresh()}>{loading ? "检测中…" : "重新检测"}</button></header>
    {!catalog ? <div className="capability-loading">正在连接 Codex App Server…</div> : <>
      {catalog.errors.length > 0 && <div className="capability-errors"><strong>部分能力无法读取</strong>{catalog.errors.map((error) => <p key={error.section}><b>{error.section}</b>{error.message}</p>)}</div>}
      <div className="capability-summary">
        <span className={catalog.features.webSearch ? "available" : "off"}>联网搜索</span><span className={catalog.features.imageGeneration ? "available" : "off"}>图像生成</span><span className={catalog.features.namespaceTools ? "available" : "off"}>命名工具</span>
        <span>{catalog.skills.filter((skill) => skill.enabled).length} 个 Skills</span><span>{catalog.mcpServers.filter((server) => server.status === "connected").length} / {catalog.mcpServers.length} 个 MCP 已连接</span>
      </div>
      <details open className="capability-group"><summary>Skills <small>{catalog.skills.length}</small></summary><div className="capability-list">{catalog.skills.length ? catalog.skills.map((skill) => <div className="capability-row" key={skill.path}><span className={`capability-dot ${skill.enabled ? "connected" : "off"}`} /><div><strong>{skill.name}</strong><p>{skill.description || skill.path}</p><small>{skill.pluginId ?? skill.scope}</small></div><button type="button" disabled={busyItem !== null} onClick={() => void toggleSkill(skill.path, !skill.enabled)}>{busyItem === skill.path ? "处理中…" : skill.enabled ? "禁用" : "启用"}</button></div>) : <div className="capability-empty">当前工作区没有发现 Skill。可在上方添加额外目录后保存并重新检测。</div>}</div></details>
      <details open className="capability-group"><summary>MCP 连接 <small>{catalog.mcpServers.length}</small><button type="button" disabled={busyItem !== null} onClick={(event) => { event.preventDefault(); void reloadMcp(); }}>{busyItem === "mcp" ? "重载中…" : "重新加载"}</button></summary><div className="capability-list">{catalog.mcpServers.length ? catalog.mcpServers.map((server) => <div className="capability-row" key={server.name}><span className={`capability-dot ${server.status}`} /><div><strong>{server.name}</strong><p>{server.status === "connected" ? `已连接 · ${server.toolCount} 个工具` : server.status === "degraded" ? "正在连接或等待授权" : server.error ?? "当前不可用"}</p><small>{server.pluginId ?? `授权：${server.authStatus}`}</small></div><em>{server.authStatus}</em></div>) : <div className="capability-empty">尚未发现 MCP 服务。请先设置 config.toml，再点击重新加载。</div>}</div></details>
      <div className="capability-footer"><span>权限：{catalog.permissionProfiles.join(" · ") || "未报告"}</span><span>模式：{catalog.collaborationModes.join(" · ") || "未报告"}</span></div>
    </>}
  </section>;
}
