import { spawn } from "node:child_process";
import type { AppConfig } from "../core/config.js";
import { codexProcessEnvironment } from "./provider-launch.js";

type JsonObject = Record<string, unknown>;

export interface CodexPlugin {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  installPolicy: string;
  authPolicy: string;
}

export interface CodexPluginMarketplace { name: string; root: string }
export interface CodexPluginCatalog { installed: CodexPlugin[]; available: CodexPlugin[]; marketplaces: CodexPluginMarketplace[] }

export interface CodexPluginManagerTransport {
  catalog(): Promise<CodexPluginCatalog>;
  install(pluginId: string): Promise<JsonObject>;
  remove(pluginId: string): Promise<JsonObject>;
  addMarketplace(source: string): Promise<JsonObject>;
  removeMarketplace(name: string): Promise<JsonObject>;
  upgradeMarketplaces(name?: string): Promise<JsonObject>;
}

type CommandExecutor = (args: string[], timeoutMs?: number) => Promise<JsonObject>;

/** Uses the bundled Codex CLI's documented JSON plugin interface. */
export class CodexPluginManager implements CodexPluginManagerTransport {
  private readonly execute: CommandExecutor;

  constructor(private readonly config: AppConfig, executor?: CommandExecutor) {
    this.execute = executor ?? ((args, timeoutMs) => this.run(args, timeoutMs));
  }

  async catalog(): Promise<CodexPluginCatalog> {
    const [plugins, marketplaceResult] = await Promise.all([
      this.execute(["plugin", "list", "--available", "--json"]),
      this.execute(["plugin", "marketplace", "list", "--json"]),
    ]);
    return {
      installed: pluginArray(plugins.installed),
      available: pluginArray(plugins.available),
      marketplaces: marketplaceArray(marketplaceResult.marketplaces),
    };
  }

  install(pluginId: string): Promise<JsonObject> { return this.execute(["plugin", "add", pluginId, "--json"], 120_000); }
  remove(pluginId: string): Promise<JsonObject> { return this.execute(["plugin", "remove", pluginId, "--json"], 60_000); }
  addMarketplace(source: string): Promise<JsonObject> { return this.execute(["plugin", "marketplace", "add", source, "--json"], 180_000); }
  removeMarketplace(name: string): Promise<JsonObject> { return this.execute(["plugin", "marketplace", "remove", name, "--json"], 60_000); }
  upgradeMarketplaces(name?: string): Promise<JsonObject> { return this.execute(["plugin", "marketplace", "upgrade", ...(name ? [name] : []), "--json"], 180_000); }

  private run(args: string[], timeoutMs = 30_000): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.codexPath ?? "codex", args, {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: codexProcessEnvironment(this.config),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, value?: JsonObject) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value ?? {});
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error("Codex 插件操作超时，请检查网络或市场源后重试")); }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 8_000_000) { child.kill(); finish(new Error("Codex 插件目录过大，已停止读取")); }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (settled) return;
        if (code !== 0) return finish(new Error(cleanError(stderr) || `Codex 插件操作失败（退出码 ${code ?? "未知"}）`));
        try { finish(undefined, JSON.parse(stdout) as JsonObject); }
        catch { finish(new Error(`Codex 插件操作未返回有效 JSON${cleanError(stderr) ? `：${cleanError(stderr)}` : ""}`)); }
      });
    });
  }
}

function cleanError(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("WARNING:")).slice(-4).join(" ");
}

function pluginArray(value: unknown): CodexPlugin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    const pluginId = text(item.pluginId, 240);
    const name = text(item.name, 120);
    const marketplaceName = text(item.marketplaceName, 120);
    if (!pluginId || !name || !marketplaceName) return [];
    return [{ pluginId, name, marketplaceName, version: text(item.version, 80), installed: item.installed === true, enabled: item.enabled === true, installPolicy: text(item.installPolicy, 80), authPolicy: text(item.authPolicy, 80) }];
  });
}

function marketplaceArray(value: unknown): CodexPluginMarketplace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    const name = text(item.name, 120);
    return name ? [{ name, root: text(item.root, 1_000) }] : [];
  });
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown, max: number): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
