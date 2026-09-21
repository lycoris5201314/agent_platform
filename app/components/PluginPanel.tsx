"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./AppDialog";

type Plugin = { pluginId: string; name: string; marketplaceName: string; version: string; installed: boolean; enabled: boolean; installPolicy: string; authPolicy: string };
type PluginCatalog = { installed: Plugin[]; available: Plugin[]; marketplaces: Array<{ name: string; root: string }> };
type Props = { api: string; refreshSignal: number; onNotice: (message: string) => void; onCount: (count: number) => void };

export function PluginPanel({ api, refreshSignal, onNotice, onCount }: Props) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [error, setError] = useState("");
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAvailable, setShowAvailable] = useState(false);
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<{ kind: "plugin"; plugin: Plugin } | { kind: "marketplace"; name: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${api}/api/codex/plugins`, { cache: "no-store" });
      const value = await response.json() as PluginCatalog & { error?: string };
      if (!response.ok) throw new Error(value.error ?? "无法读取插件目录");
      setCatalog(value);
      onCount(value.installed.length);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [api, onCount]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh, refreshSignal]);

  const visiblePlugins = useMemo(() => {
    if (!catalog) return [];
    const normalized = query.trim().toLowerCase();
    const source = showAvailable ? [...catalog.installed, ...catalog.available] : catalog.installed;
    return source.filter((plugin) => !normalized || `${plugin.name} ${plugin.pluginId} ${plugin.marketplaceName}`.toLowerCase().includes(normalized)).slice(0, 80);
  }, [catalog, query, showAvailable]);

  async function action(path: string, body: Record<string, string>, success: string, busyKey: string) {
    setBusyItem(busyKey);
    try {
      const response = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "插件操作失败");
      onNotice(success);
      await refresh();
      return true;
    } catch (actionError) {
      onNotice(actionError instanceof Error ? actionError.message : String(actionError));
      return false;
    } finally { setBusyItem(null); }
  }

  function install(plugin: Plugin) {
    void action("/api/codex/plugins/install", { pluginId: plugin.pluginId }, `插件 ${plugin.name} 已安装，新对话将自动加载。`, plugin.pluginId);
  }

  function remove(plugin: Plugin) {
    setPendingRemoval({ kind: "plugin", plugin });
  }

  async function addMarketplace() {
    const source = marketplaceSource.trim();
    if (!source) return;
    if (await action("/api/codex/plugin-marketplaces", { source }, "插件市场已添加。", "marketplace:add")) setMarketplaceSource("");
  }

  function removeMarketplace(name: string) {
    setPendingRemoval({ kind: "marketplace", name });
  }

  async function confirmRemoval() {
    if (!pendingRemoval) return;
    const success = pendingRemoval.kind === "plugin"
      ? await action("/api/codex/plugins/remove", { pluginId: pendingRemoval.plugin.pluginId }, `插件 ${pendingRemoval.plugin.name} 已卸载。`, pendingRemoval.plugin.pluginId)
      : await action("/api/codex/plugin-marketplaces/remove", { name: pendingRemoval.name }, `插件市场 ${pendingRemoval.name} 已移除。`, `marketplace:${pendingRemoval.name}`);
    if (success) setPendingRemoval(null);
  }

  return <><details open className="capability-group plugin-group"><summary>插件 <small>{catalog?.installed.length ?? 0} 已安装 · {catalog?.available.length ?? 0} 可安装</small></summary>
    <div className="plugin-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件或市场" /><label><input type="checkbox" checked={showAvailable} onChange={(event) => setShowAvailable(event.target.checked)} /> 显示可安装插件</label></div>
    {error && <div className="capability-errors"><strong>插件目录无法读取</strong><p>{error}</p></div>}
    <div className="capability-list plugin-list">{visiblePlugins.length ? visiblePlugins.map((plugin) => <div className="capability-row" key={plugin.pluginId}><span className={`capability-dot ${plugin.installed ? "connected" : "off"}`} /><div><strong>{plugin.name}</strong><p>{plugin.installed ? "已安装" : "可安装"}{plugin.version ? ` · v${plugin.version}` : ""}{plugin.authPolicy ? ` · 授权 ${plugin.authPolicy}` : ""}</p><small>{plugin.marketplaceName}</small></div><button type="button" disabled={busyItem !== null} onClick={() => plugin.installed ? remove(plugin) : install(plugin)}>{busyItem === plugin.pluginId ? "处理中…" : plugin.installed ? "卸载" : "安装"}</button></div>) : <div className="capability-empty">{catalog?.marketplaces.length ? "没有匹配的插件。" : "尚未配置插件市场，请在下方添加本地目录或 Git 仓库。"}</div>}</div>
    <div className="marketplace-manager"><div className="marketplace-heading"><strong>插件市场</strong><button type="button" disabled={busyItem !== null || !catalog?.marketplaces.length} onClick={() => void action("/api/codex/plugin-marketplaces/upgrade", {}, "插件市场已更新。", "marketplace:upgrade")}>{busyItem === "marketplace:upgrade" ? "更新中…" : "全部更新"}</button></div>{catalog?.marketplaces.map((marketplace) => <div className="marketplace-row" key={marketplace.name}><div><strong>{marketplace.name}</strong><small title={marketplace.root}>{marketplace.root}</small></div><button type="button" disabled={busyItem !== null} onClick={() => removeMarketplace(marketplace.name)}>{busyItem === `marketplace:${marketplace.name}` ? "处理中…" : "移除"}</button></div>)}<div className="marketplace-add"><input value={marketplaceSource} onChange={(event) => setMarketplaceSource(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addMarketplace(); }} placeholder="本地目录、owner/repo 或 Git 地址" /><button type="button" disabled={busyItem !== null || !marketplaceSource.trim()} onClick={() => void addMarketplace()}>{busyItem === "marketplace:add" ? "添加中…" : "添加市场"}</button></div><p>插件可包含 Skills、MCP 服务和界面能力；安装变更会从下一次模型回合开始生效。</p></div>
  </details><ConfirmDialog open={Boolean(pendingRemoval)} title={pendingRemoval?.kind === "plugin" ? "卸载插件？" : "移除插件市场？"} description={pendingRemoval?.kind === "plugin" ? <><strong>{pendingRemoval.plugin.name}</strong> 将从后续模型回合中移除，已经开始的回合不会中断。</> : <><strong>{pendingRemoval?.name}</strong> 将从市场列表中移除，已安装插件可能失去更新来源。</>} confirmLabel={pendingRemoval?.kind === "plugin" ? "卸载插件" : "移除市场"} danger busy={busyItem !== null} onCancel={() => setPendingRemoval(null)} onConfirm={() => void confirmRemoval()} /></>;
}
