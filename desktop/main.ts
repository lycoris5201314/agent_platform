import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, safeStorage, screen, shell, Tray } from "electron";
import updater from "electron-updater";
import { createAgentApplication, type AgentApplication } from "../server/app.js";
import { loadConfig } from "../server/core/config.js";
import { startDesktopSite, type DesktopSite } from "./site-server.js";
import { writeSupportBundle, type SupportBundleResult } from "./support-bundle.js";
import { clearEncryptedDraft, readEncryptedDraft, readEncryptedFollowUpDraft, writeEncryptedDraft, writeEncryptedFollowUpDraft } from "./draft-store.js";
import { clampDetachedWindowPosition, conversationWindowUrl, isPointOutsideWindow, isScreenPoint, type ScreenPoint } from "./window-detach.js";

const { autoUpdater } = updater;

const realSmokeTest = process.argv.includes("--real-smoke-test");
const windowSmokeTest = process.argv.includes("--window-smoke-test");
const smokeTest = process.argv.includes("--smoke-test") || realSmokeTest || windowSmokeTest;
const smokeUserDataDirectory = smokeTest ? path.join(app.getPath("temp"), `agent-foundry-electron-${process.pid}`) : "";
if (smokeUserDataDirectory) {
  fs.mkdirSync(smokeUserDataDirectory, { recursive: true });
  app.setPath("userData", smokeUserDataDirectory);
}
const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
const detachedWindows = new Map<string, BrowserWindow>();
let agentApplication: AgentApplication | null = null;
let desktopSite: DesktopSite | null = null;
let configPath = "";
let stopping = false;
let smokeDataDirectory = "";
let tray: Tray | null = null;
let isQuitting = false;
let taskMonitor: NodeJS.Timeout | null = null;
let sleepBlockerId: number | null = null;
const taskStates = new Map<string, string>();
let smokeLogPath = "";
let configReloadTimer: NodeJS.Timeout | null = null;
let environmentFileKeys = new Set<string>();

function smokeProgress(message: string): void {
  if (!smokeTest) return;
  try {
    smokeLogPath ||= path.join(app.getPath("temp"), "agent-foundry-desktop-smoke.log");
    fs.appendFileSync(smokeLogPath, `[${new Date().toISOString()}] pid=${process.pid} ${message}\n`, "utf8");
  } catch { /* smoke diagnostics must not alter the result */ }
}

type WindowState = { x?: number; y?: number; width: number; height: number; maximized?: boolean };

function windowStatePath(): string { return path.join(app.getPath("userData"), "window-state.json"); }
function pendingDraftPath(): string { return path.join(process.env.AGENT_DATA_DIR ?? path.join(app.getPath("userData"), "data"), "ui", "pending-conversation-draft.bin"); }
function pendingFollowUpDraftsPath(): string { return path.join(process.env.AGENT_DATA_DIR ?? path.join(app.getPath("userData"), "data"), "ui", "pending-follow-up-drafts.bin"); }
function readWindowState(): WindowState {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), "utf8")) as WindowState; }
  catch { return { width: 1440, height: 920 }; }
}
function writeWindowState(window: BrowserWindow): void {
  if (window.isMinimized() || window.isFullScreen()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  try { fs.writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, maximized: window.isMaximized() }), "utf8"); } catch { /* cosmetic state only */ }
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function notify(title: string, body: string, taskId?: string): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", () => {
    showMainWindow();
    if (taskId) mainWindow?.webContents.send("agent:focus-conversation", taskId);
  });
  notification.show();
  return true;
}

async function prepareSupportBundle(openDirectory = true): Promise<SupportBundleResult> {
  if (!agentApplication) throw new Error("本地服务尚未启动");
  const result = writeSupportBundle({
    dataDir: agentApplication.config.dataDir,
    userDataDir: app.getPath("userData"),
    appVersion: app.getVersion(),
    config: agentApplication.config,
    store: agentApplication.store,
  });
  if (openDirectory) {
    const error = await shell.openPath(result.directory);
    if (error) throw new Error(error);
  }
  return result;
}

function startTaskMonitor(): void {
  if (taskMonitor) return;
  const activeStates = new Set(["queued", "preparing", "running", "verifying", "waiting_timer", "waiting_external", "waiting_approval", "waiting_retry"]);
  const tick = () => {
    if (!agentApplication) {
      taskMonitor = setTimeout(tick, 12_000);
      return;
    }
    const tasks = agentApplication.store.listTasksFor({ tenantId: "local", userId: "local-user", role: "owner" }, 100, false);
    const hasActive = tasks.some((task) => activeStates.has(task.status));
    if (hasActive && sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    if (!hasActive && sleepBlockerId !== null) { powerSaveBlocker.stop(sleepBlockerId); sleepBlockerId = null; }
    for (const task of tasks) {
      const previous = taskStates.get(task.id);
      taskStates.set(task.id, task.status);
      if (!previous || previous === task.status) continue;
      if (task.status === "waiting_approval") notify("Agent Foundry 等待审批", task.title);
      else if (task.status === "succeeded") notify("Agent 任务已完成", task.title);
      else if (task.status === "failed") notify("Agent 任务执行失败", task.title);
    }
    taskMonitor = setTimeout(tick, hasActive ? 4_000 : 12_000);
  };
  tick();
}

function installTray(): void {
  const image = nativeImage.createFromPath(process.execPath).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("Agent Foundry");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Agent Foundry", click: showMainWindow },
    { label: "打开数据目录", click: () => void shell.openPath(process.env.AGENT_DATA_DIR!) },
    { label: "生成并打开问题反馈资料", click: () => void prepareSupportBundle().catch((error) => appendCrashLog("support bundle", error)) },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; void shutdownAndQuit(); } },
  ]));
  tray.on("double-click", showMainWindow);
}

function appendCrashLog(kind: string, error: unknown): void {
  try {
    const directory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(directory, { recursive: true });
    const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
    fs.appendFileSync(path.join(directory, "crash.log"), `[${new Date().toISOString()}] ${kind}\n${message}\n\n`, "utf8");
  } catch { /* logging must never crash the app */ }
}

process.on("uncaughtException", (error) => appendCrashLog("uncaughtException", error));
process.on("unhandledRejection", (error) => appendCrashLog("unhandledRejection", error));

function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(import.meta.dirname, "..");
}

function preferredConfigDirectory(): string {
  if (app.isPackaged) return path.dirname(process.execPath);
  return path.resolve(import.meta.dirname, "..");
}

function bundledCodexPath(): string {
  const segments = ["node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"];
  return app.isPackaged
    ? path.join(resourcesRoot(), "app.asar.unpacked", ...segments)
    : path.join(resourcesRoot(), ...segments);
}

function configureCodexExecutable(): void {
  const configuredPath = process.env.CODEX_PATH?.trim();
  if (configuredPath && fs.existsSync(configuredPath)) return;
  const bundledPath = bundledCodexPath();
  if (fs.existsSync(bundledPath)) {
    process.env.CODEX_PATH = bundledPath;
    return;
  }
  throw new Error(`Codex 运行时文件缺失：${bundledPath}\n请重新安装依赖或重新构建 Agent Foundry。`);
}

function bundledCodexVersion(): string {
  const executable = process.env.CODEX_PATH?.trim();
  if (!executable) return "不可用";
  const result = spawnSync(executable, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  return String(result.stdout || result.stderr || "不可用").trim().replace(/^codex-cli\s+/i, "") || "不可用";
}

function configureDockerExecutable(): void {
  if (process.env.DOCKER_PATH && fs.existsSync(process.env.DOCKER_PATH)) return;
  const candidates = [
    path.join("E:\\docker", "app", "resources", "bin", "docker.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
    ...String(process.env.Path ?? "").split(path.delimiter).map((entry) => path.join(entry, "docker.exe")),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) process.env.DOCKER_PATH = found;
}

function prepareEnvironment(): string {
  const templatePath = app.isPackaged
    ? path.join(resourcesRoot(), "agent.env.example")
    : path.join(resourcesRoot(), "desktop", "agent.env.example");
  const candidates = [preferredConfigDirectory(), app.getPath("userData")];
  let selected = "";
  for (const directory of candidates) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "agent.env");
      if (!fs.existsSync(target)) fs.copyFileSync(templatePath, target, fs.constants.COPYFILE_EXCL);
      selected = target;
      break;
    } catch {
      // The chosen installation directory may be read-only; userData is the safe fallback.
    }
  }
  if (!selected) throw new Error("无法创建 agent.env 配置文件");
  applyEnvironmentFile(selected);
  if (smokeTest) {
    smokeDataDirectory = path.join(app.getPath("temp"), `agent-foundry-smoke-${process.pid}`);
    fs.mkdirSync(smokeDataDirectory, { recursive: true });
    process.env.AGENT_DATA_DIR = smokeDataDirectory;
    process.env.AGENT_RUNTIME = realSmokeTest ? "codex" : "mock";
    process.env.AGENT_WORKSPACE_MODE = "native";
    process.env.AGENT_SANDBOX = "native";
  } else {
    process.env.AGENT_DATA_DIR ??= path.join(app.getPath("userData"), "data");
  }
  process.env.AGENT_FOUNDRY_SANDBOX_CODEX_HOME ??= path.join(app.getPath("userData"), "codex-sandbox");
  configureCodexExecutable();
  configureDockerExecutable();
  Object.assign(process.env, { NODE_ENV: "production" });
  return selected;
}

function applyEnvironmentFile(filePath: string): void {
  const values = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const key of environmentFileKeys) {
    if (!(key in values)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  environmentFileKeys = new Set(Object.keys(values));
}

function watchConfigFile(): void {
  fs.watchFile(configPath, { interval: 750 }, (current, previous) => {
    if (stopping || (current.mtimeMs === previous.mtimeMs && current.size === previous.size)) return;
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (stopping) return;
      try {
        applyEnvironmentFile(configPath);
        configureCodexExecutable();
        process.env.AGENT_ENV_RELOADED_AT = new Date().toISOString();
        const refreshed = loadConfig();
        if (agentApplication) {
          agentApplication.config.defaultRuntime = refreshed.defaultRuntime;
          agentApplication.config.providers = refreshed.providers;
        }
        mainWindow?.webContents.reloadIgnoringCache();
        notify("Agent Foundry 配置已加载", "Provider 与可用模型已根据 agent.env 刷新。");
      } catch (error) {
        appendCrashLog("agent.env reload", error);
        notify("agent.env 加载失败", error instanceof Error ? error.message : String(error));
      }
    }, 1_000);
  });
}

async function openConfig(): Promise<void> {
  const error = await shell.openPath(configPath);
  if (error) await dialog.showMessageBox({ type: "error", title: "无法打开配置", message: error });
}

type UpdateCheckResult = { status: "development" | "current" | "available" | "downloading" | "error"; currentVersion: string; availableVersion?: string; error?: string };

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) {
    await dialog.showMessageBox({ type: "info", title: "检查更新", message: "开发模式不检查更新。" });
    return { status: "development", currentVersion };
  }
  try {
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    const nextVersion = result?.updateInfo.version;
    if (!nextVersion || nextVersion === currentVersion) {
      await dialog.showMessageBox({ type: "info", title: "检查更新", message: `当前已是最新版 ${currentVersion}。` });
      return { status: "current", currentVersion };
    }
    const choice = await dialog.showMessageBox({ type: "info", title: "发现新版本", message: `Agent Foundry ${nextVersion} 可以下载。`, detail: "更新下载失败时会保留当前可运行版本。", buttons: ["下载并安装", "稍后"], defaultId: 0, cancelId: 1 });
    if (choice.response === 0) {
      await autoUpdater.downloadUpdate();
      return { status: "downloading", currentVersion, availableVersion: nextVersion };
    }
    return { status: "available", currentVersion, availableVersion: nextVersion };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCrashLog("auto update check", error);
    const choice = await dialog.showMessageBox({ type: "warning", title: "无法自动检查更新", message, detail: "如果仓库是私有的，自动更新需要访问凭据；也可以打开 GitHub Release 手动下载。", buttons: ["打开 Release 页面", "关闭"], cancelId: 1 });
    if (choice.response === 0) void shell.openExternal("https://github.com/lycoris5201314/agent_platform/releases");
    return { status: "error", currentVersion, error: message };
  }
}

function initializeUpdater(): void {
  autoUpdater.on("error", (error) => {
    appendCrashLog("auto update", error);
    if (!stopping) notify("Agent Foundry 更新失败", "当前版本不受影响，可稍后重新检查更新。");
  });
  autoUpdater.on("update-downloaded", async (event) => {
    const choice = await dialog.showMessageBox({ type: "info", title: "更新已准备好", message: `Agent Foundry ${event.version} 已下载。`, detail: "现在重启并安装，或稍后从菜单重新检查。", buttons: ["重启安装", "稍后"], defaultId: 0, cancelId: 1 });
    if (choice.response === 0) { isQuitting = true; autoUpdater.quitAndInstall(false, true); }
  });
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Agent Foundry",
      submenu: [
        { label: "编辑 API Key 配置", click: () => void openConfig() },
        { label: "打开数据目录", click: () => void shell.openPath(process.env.AGENT_DATA_DIR!) },
        { label: "生成并打开问题反馈资料", click: () => void prepareSupportBundle().catch((error) => appendCrashLog("support bundle", error)) },
        { label: "检查更新", click: () => void checkForUpdates() },
        { type: "separator" },
        { label: "重启应用", click: () => { app.relaunch(); app.quit(); } },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "查看",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "togglefullscreen", label: "切换全屏" },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ]));
}

async function startServices(): Promise<{ apiOrigin: string; siteOrigin: string }> {
  configPath = prepareEnvironment();
  agentApplication = await createAgentApplication();
  const apiOrigin = await agentApplication.app.listen({ host: "127.0.0.1", port: 0 });
  desktopSite = await startDesktopSite(path.join(app.getAppPath(), "dist"));
  return { apiOrigin, siteOrigin: desktopSite.origin };
}

async function stopServices(): Promise<void> {
  smokeProgress("stopServices begin");
  if (configPath) fs.unwatchFile(configPath);
  if (configReloadTimer) clearTimeout(configReloadTimer);
  configReloadTimer = null;
  if (taskMonitor) clearTimeout(taskMonitor);
  taskMonitor = null;
  if (sleepBlockerId !== null) powerSaveBlocker.stop(sleepBlockerId);
  sleepBlockerId = null;
  for (const window of detachedWindows.values()) {
    if (!window.isDestroyed()) window.destroy();
  }
  detachedWindows.clear();
  if (isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  tray?.destroy(); tray = null;
  const site = desktopSite;
  const agent = agentApplication;
  desktopSite = null;
  agentApplication = null;
  await Promise.allSettled([site?.close(), agent?.close()]);
  smokeProgress("stopServices complete");
}

async function shutdownAndQuit(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  isQuitting = true;
  await stopServices();
  if (smokeDataDirectory) {
    try { fs.rmSync(smokeDataDirectory, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
    smokeDataDirectory = "";
  }
  if (smokeUserDataDirectory) {
    try { fs.rmSync(smokeUserDataDirectory, { recursive: true, force: true }); } catch { /* Chromium may retain cache handles until process exit */ }
  }
  smokeProgress(`app.exit(${exitCode})`);
  app.exit(exitCode);
}

async function runSmokeTest(apiOrigin: string, siteOrigin: string): Promise<void> {
  smokeProgress("services online; checking web and API");
  const [health, page] = await Promise.all([
    fetch(`${apiOrigin}/api/health`),
    fetch(`${siteOrigin}/`),
  ]);
  if (!health.ok || !page.ok || !(await page.text()).includes("Agent Foundry")) {
    throw new Error(`Desktop smoke test failed: API ${health.status}, Web ${page.status}`);
  }
  const configResponse = await fetch(`${apiOrigin}/api/config`);
  const modelsResponse = await fetch(`${apiOrigin}/api/models`);
  if (!configResponse.ok || !modelsResponse.ok) {
    throw new Error(`Desktop smoke test failed: config ${configResponse.status}, models ${modelsResponse.status}`);
  }
  const publicConfiguration = await configResponse.json() as { providers?: Array<{ id: string; configured: boolean }> };
  const modelCatalog = await modelsResponse.json() as { models?: Array<{ provider: string; model: string }>; errors?: unknown[] };
  const configuredProviderIds = new Set((publicConfiguration.providers ?? []).filter((provider) => provider.configured).map((provider) => provider.id));
  if (process.env.DEEPSEEK_API_KEY && !configuredProviderIds.has("deepseek")) {
    throw new Error("Desktop smoke test failed: release agent.env contains DEEPSEEK_API_KEY but DeepSeek is not configured");
  }
  if (realSmokeTest) {
    const preferredProvider = process.env.DEEPSEEK_API_KEY ? "deepseek" : process.env.OPENAI_API_KEY ? "openai" : process.env.MODEL_API_KEY ? "custom" : "";
    const selectedModel = (modelCatalog.models ?? []).find((model) => model.provider === preferredProvider);
    if (!preferredProvider || !selectedModel) {
      throw new Error(`Real release smoke test requires a configured compatible provider; catalog errors: ${JSON.stringify(modelCatalog.errors ?? [])}`);
    }
    const realWorkspace = path.join(smokeDataDirectory, "real-workspace");
    fs.mkdirSync(realWorkspace, { recursive: true });
    smokeProgress(`creating real ${preferredProvider} task with ${selectedModel.model}`);
    const realCreated = await fetch(`${apiOrigin}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Extracted release runtime smoke",
        prompt: "这是已解压发布目录的真实运行验证。请只回复 RELEASE_RUNTIME_OK，不要调用工具。",
        runtime: "codex",
        provider: preferredProvider,
        model: selectedModel.model,
        reasoningEffort: "low",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        workspacePath: realWorkspace,
      }),
    });
    if (!realCreated.ok) throw new Error(`Real release smoke test failed to create task: ${await realCreated.text()}`);
    const realTaskId = String((await realCreated.json() as { task: { id: string } }).task.id);
    const realDeadline = Date.now() + 180_000;
    let realTask: { status: string; result?: string; error?: string } | undefined;
    while (Date.now() < realDeadline) {
      const detail = await fetch(`${apiOrigin}/api/tasks/${realTaskId}`).then((response) => response.json()) as { task: { status: string; result?: string; error?: string } };
      realTask = detail.task;
      if (["succeeded", "failed", "cancelled"].includes(realTask.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (realTask?.status !== "succeeded" || !realTask.result?.includes("RELEASE_RUNTIME_OK")) {
      throw new Error(`Real release smoke test failed (${realTask?.status ?? "timeout"}): ${realTask?.error ?? realTask?.result ?? "no result"}`);
    }
    smokeProgress(`real ${preferredProvider} task passed`);
  }
  const codexPath = process.env.CODEX_PATH;
  if (!codexPath || !fs.existsSync(codexPath)) {
    throw new Error(`Desktop smoke test failed: bundled Codex executable is missing (${codexPath ?? "unset"})`);
  }
  const codex = spawnSync(codexPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (codex.error || codex.status !== 0 || !codex.stdout.includes("codex-cli")) {
    throw new Error(`Desktop smoke test failed: Codex executable cannot run (${codex.error?.message ?? codex.stderr.trim()})`);
  }
  const appServer = spawnSync(codexPath, ["app-server", "--help"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (appServer.error || appServer.status !== 0 || !appServer.stdout.includes("app server")) {
    throw new Error(`Desktop smoke test failed: Codex App Server cannot run (${appServer.error?.message ?? appServer.stderr.trim()})`);
  }
  const workspacePath = path.join(smokeDataDirectory, "pty-workspace");
  smokeProgress("Codex executable passed; creating mock task");
  const created = await fetch(`${apiOrigin}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Packaged ConPTY smoke", prompt: "verify packaged desktop", runtime: "mock", workspacePath }) });
  if (!created.ok) throw new Error(`Desktop smoke test failed: cannot create task (${await created.text()})`);
  const taskId = String((await created.json() as { task: { id: string } }).task.id);
  const taskDeadline = Date.now() + 20_000;
  let taskStatus = "";
  while (Date.now() < taskDeadline) {
    const detail = await fetch(`${apiOrigin}/api/tasks/${taskId}`).then((response) => response.json()) as { task: { status: string } };
    taskStatus = detail.task.status;
    if (taskStatus === "succeeded" || taskStatus === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (taskStatus !== "succeeded") throw new Error(`Desktop smoke test failed: mock task ended as ${taskStatus || "timeout"}`);
  smokeProgress("mock task passed; opening packaged ConPTY");
  const opened = await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: 80, rows: 20 }) });
  if (!opened.ok) throw new Error(`Desktop smoke test failed: packaged ConPTY cannot open (${await opened.text()})`);
  const session = (await opened.json() as { session: { id: string; permissionProfile: string } }).session;
  const ptyDeadline = Date.now() + 20_000;
  let ptyOutput = "";
  let ptyStatus = "running";
  let ptyExitCode: number | null = null;
  let nextInputAt = 0;
  let inputError = "";
  while (Date.now() < ptyDeadline) {
    if (Date.now() >= nextInputAt) {
      const input = await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions/${session.id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "Write-Output 'PACKAGED_CONPTY_OK'\r" }) });
      inputError = input.ok ? "" : `${input.status} ${await input.text()}`;
      nextInputAt = Date.now() + 1_500;
    }
    const sessions = await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions`).then((response) => response.json()) as { sessions: Array<{ id: string; output: string; status: string; exitCode: number | null }> };
    const current = sessions.sessions.find((item) => item.id === session.id);
    ptyOutput = current?.output ?? "";
    ptyStatus = current?.status ?? "missing";
    ptyExitCode = current?.exitCode ?? null;
    if (ptyOutput.includes("PACKAGED_CONPTY_OK")) break;
    if (ptyStatus !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ptyOutput.includes("PACKAGED_CONPTY_OK")) {
    const diagnostic = ptyOutput.replaceAll("\r", "").slice(-800).trim() || "no terminal output";
    throw new Error(`Desktop smoke test failed: packaged ConPTY produced no interactive output (status=${ptyStatus}, exit=${String(ptyExitCode)}, input=${inputError || "accepted"}, output=${diagnostic})`);
  }
  await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions/${session.id}`, { method: "DELETE" });
  console.log(`Desktop smoke test passed (${siteOrigin}, ${apiOrigin}, ${codex.stdout.trim()}, ConPTY ${session.permissionProfile})`);
  smokeProgress(`passed with ConPTY ${session.permissionProfile}`);
}

function browserWindowPreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(app.getAppPath(), "dist-desktop", "preload.cjs"),
  };
}

function configureBrowserWindow(window: BrowserWindow, siteOrigin: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    Menu.buildFromTemplate([
      { role: "undo", label: "撤销", enabled: params.editFlags.canUndo }, { role: "redo", label: "重做", enabled: params.editFlags.canRedo },
      { type: "separator" }, { role: "cut", label: "剪切", enabled: params.editFlags.canCut }, { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
      { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste }, { role: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll },
      ...(params.linkURL ? [{ type: "separator" as const }, { label: "在浏览器中打开链接", click: () => void shell.openExternal(params.linkURL) }] : []),
    ]).popup({ window });
  });
  const keepLocalNavigation = (event: Electron.Event, url: string) => {
    try {
      if (new URL(url).origin !== siteOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", keepLocalNavigation);
  window.webContents.on("will-redirect", keepLocalNavigation);
}

async function openDetachedConversation(siteOrigin: string, apiOrigin: string, taskId: string, point?: ScreenPoint): Promise<{ detached: true; existing: boolean }> {
  const current = detachedWindows.get(taskId);
  if (current && !current.isDestroyed()) {
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    return { detached: true, existing: true };
  }

  const size = { width: 1000, height: 760 };
  const cursor = point ?? screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const position = clampDetachedWindowPosition(cursor, display.workArea, size);
  const window = new BrowserWindow({
    ...position,
    ...size,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: "#f4f1ea",
    title: "独立对话 · Agent Foundry",
    webPreferences: browserWindowPreferences(),
  });
  detachedWindows.set(taskId, window);
  configureBrowserWindow(window, siteOrigin);
  window.once("ready-to-show", () => { window.show(); window.focus(); });
  window.on("closed", () => {
    if (detachedWindows.get(taskId) === window) detachedWindows.delete(taskId);
  });
  try {
    await window.loadURL(conversationWindowUrl(siteOrigin, apiOrigin, taskId));
  } catch (error) {
    detachedWindows.delete(taskId);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return { detached: true, existing: false };
}

async function runConversationWindowSmokeTest(siteOrigin: string, apiOrigin: string): Promise<void> {
  const createTask = async (title: string): Promise<string> => {
    const response = await fetch(`${apiOrigin}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, prompt: `${title} 的多窗口验收`, runtime: "mock", provider: "openai", model: "mock" }),
    });
    if (!response.ok) throw new Error(`Window smoke task creation failed: ${response.status}`);
    return (await response.json() as { task: { id: string } }).task.id;
  };
  const [firstTaskId, secondTaskId] = await Promise.all([createTask("窗口验收 A"), createTask("窗口验收 B")]);
  const automationCreated = await fetch(`${apiOrigin}/api/automations`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: "窗口确认框验收", prompt: "验证非阻塞确认框", runtime: "mock", provider: "openai", model: "mock",
      reasoningEffort: "medium", sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
      scheduleKind: "once", onceAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  if (!automationCreated.ok) throw new Error(`Unable to seed automation dialog smoke: ${await automationCreated.text()}`);
  await createWindow(siteOrigin, apiOrigin);
  if (!mainWindow) throw new Error("Window smoke main window was not created");
  const activityDeadline = Date.now() + 20_000;
  let activityUi = { activityTab: false, slashMenu: false, commandCount: 0, taskFilters: false, href: "", body: "" };
  while (Date.now() < activityDeadline) {
    activityUi = await mainWindow.webContents.executeJavaScript(`(() => {
      const activityTab = [...document.querySelectorAll('.sidebar-filter button')].some((button) => button.textContent?.includes('活动'));
      const filterToggle = document.querySelector('.task-filter-toggle');
      if (filterToggle && !document.querySelector('.task-filter-panel')) filterToggle.click();
      const taskFilters = document.querySelectorAll('.task-filter-panel select').length === 4;
      const input = document.querySelector('.message-composer textarea');
      if (input && !document.querySelector('.slash-command-menu')) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, '/');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const commands = [...document.querySelectorAll('.slash-command-menu code')].map((node) => node.textContent || '');
      return { activityTab, slashMenu: commands.includes('/status'), commandCount: commands.length, taskFilters, href: location.href, body: (document.body?.innerText || '').slice(0, 500) };
    })()`) as typeof activityUi;
    if (activityUi.activityTab && activityUi.slashMenu && activityUi.commandCount > 3 && activityUi.taskFilters) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!activityUi.activityTab || !activityUi.slashMenu || activityUi.commandCount <= 3 || !activityUi.taskFilters) {
    throw new Error(`Activity/slash command UI smoke failed: ${JSON.stringify(activityUi)}`);
  }
  const filterUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    const status = document.querySelector('.task-filter-panel select');
    if (!status) return { applied: false, badge: false, note: '' };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(status, 'completed');
    status.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 80 && !document.querySelector('.history-note')?.textContent?.includes('数据库全量筛选'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const note = document.querySelector('.history-note')?.textContent || '';
    const badge = document.querySelector('.task-filter-toggle i')?.textContent === '1';
    document.querySelector('.task-filter-panel footer button')?.click();
    return { applied: note.includes('数据库全量筛选'), badge, note };
  })()`) as { applied: boolean; badge: boolean; note: string };
  if (!filterUi.applied || !filterUi.badge) throw new Error(`Task filter interaction smoke failed: ${JSON.stringify(filterUi)}`);
  const commandUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    const openPalette = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      for (let index = 0; index < 30 && !document.querySelector('.command-search input'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      return document.querySelector('.command-search input');
    };
    let input = await openPalette();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '窗口验收 A');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    for (let index = 0; index < 50 && ![...document.querySelectorAll('.command-task strong')].some((node) => node.textContent === '窗口验收 A'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const foundTask = [...document.querySelectorAll('.command-task strong')].some((node) => node.textContent === '窗口验收 A');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let index = 0; index < 40 && document.querySelector('.command-palette'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    for (let index = 0; index < 40 && document.querySelector('.task-title')?.textContent !== '窗口验收 A'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const paletteClosedAfterSwitch = !document.querySelector('.command-palette');
    const selectedTitle = document.querySelector('.task-title')?.textContent || '';
    const switched = paletteClosedAfterSwitch && selectedTitle === '窗口验收 A';
    input = await openPalette();
    setter?.call(input, 'settings');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const foundAction = [...document.querySelectorAll('.command-results button span')].some((node) => node.textContent?.includes('平台设置与诊断'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { foundTask, switched, paletteClosedAfterSwitch, selectedTitle, foundAction, closed: !document.querySelector('.command-palette') };
  })()`) as { foundTask: boolean; switched: boolean; paletteClosedAfterSwitch: boolean; selectedTitle: string; foundAction: boolean; closed: boolean };
  if (!commandUi.foundTask || !commandUi.switched || !commandUi.foundAction || !commandUi.closed) throw new Error(`Command palette task switch smoke failed: ${JSON.stringify(commandUi)}`);
  const automationUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('.automation-nav-button')?.click();
    for (let index = 0; index < 40 && !document.querySelector('.automations-page'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const page = document.querySelector('.automations-page');
    const create = [...(page?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('新建自动化') || button.textContent?.includes('创建第一个自动化'));
    create?.click();
    for (let index = 0; index < 20 && !document.querySelector('.automation-modal'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const modal = document.querySelector('.automation-modal');
    const result = {
      page: Boolean(page), modal: Boolean(modal),
      frequency: [...(modal?.querySelectorAll('option') || [])].some((option) => option.textContent?.includes('固定间隔')),
      workspace: [...(modal?.querySelectorAll('button') || [])].some((button) => button.textContent?.includes('选择文件夹')),
      model: [...(modal?.querySelectorAll('label') || [])].some((label) => label.textContent?.includes('模型'))
    };
    modal?.querySelector('header button')?.click();
    for (let index = 0; index < 60 && ![...page.querySelectorAll('.automation-card')].some((card) => card.textContent?.includes('窗口确认框验收')); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const automationCard = [...(page?.querySelectorAll('.automation-card') || [])].find((card) => card.textContent?.includes('窗口确认框验收'));
    [...(automationCard?.querySelectorAll('button') || [])].find((button) => button.textContent === '删除')?.click();
    for (let index = 0; index < 20 && !document.querySelector('.app-dialog[role="alertdialog"]'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const dialogOpened = document.querySelector('.app-dialog')?.textContent?.includes('删除自动化') ?? false;
    const confirmFocused = document.activeElement?.textContent?.includes('删除自动化') ?? false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const escapeClosed = !document.querySelector('.app-dialog') && Boolean([...page.querySelectorAll('.automation-card')].find((card) => card.textContent?.includes('窗口确认框验收')));
    [...(automationCard?.querySelectorAll('button') || [])].find((button) => button.textContent === '删除')?.click();
    for (let index = 0; index < 20 && !document.querySelector('.app-dialog'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    [...(document.querySelector('.app-dialog')?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('删除自动化'))?.click();
    for (let index = 0; index < 40 && [...page.querySelectorAll('.automation-card')].some((card) => card.textContent?.includes('窗口确认框验收')); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const confirmedDelete = ![...page.querySelectorAll('.automation-card')].some((card) => card.textContent?.includes('窗口确认框验收')) && !document.querySelector('.app-dialog');
    [...(page?.querySelectorAll('button') || [])].find((button) => button.textContent?.includes('返回对话'))?.click();
    return { ...result, dialogOpened, confirmFocused, escapeClosed, confirmedDelete };
  })()`) as { page: boolean; modal: boolean; frequency: boolean; workspace: boolean; model: boolean; dialogOpened: boolean; confirmFocused: boolean; escapeClosed: boolean; confirmedDelete: boolean };
  if (!automationUi.page || !automationUi.modal || !automationUi.frequency || !automationUi.workspace || !automationUi.model || !automationUi.dialogOpened || !automationUi.confirmFocused || !automationUi.escapeClosed || !automationUi.confirmedDelete) {
    throw new Error(`Automation UI smoke failed: ${JSON.stringify(automationUi)}`);
  }
  const goalsUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('.goal-nav-button')?.click();
    for (let index = 0; index < 40 && !document.querySelector('.goals-page'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    for (let index = 0; index < 80 && document.querySelector('.goals-page .panel-loading'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const page = document.querySelector('.goals-page');
    const result = {
      page: Boolean(page),
      summaries: page?.querySelectorAll('.automation-summary > div').length === 4,
      empty: Boolean(page?.querySelector('.automation-empty')),
      completedToggle: Boolean(page?.querySelector('.goal-completed-toggle input')),
    };
    [...(page?.querySelectorAll('.conversation-header button') || [])].find((button) => button.textContent?.includes('返回对话'))?.click();
    return result;
  })()`) as { page: boolean; summaries: boolean; empty: boolean; completedToggle: boolean };
  if (!goalsUi.page || !goalsUi.summaries || !goalsUi.empty || !goalsUi.completedToggle) {
    throw new Error(`Persistent goal dashboard UI smoke failed: ${JSON.stringify(goalsUi)}`);
  }
  const capabilityUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('.settings-button')?.click();
    for (let index = 0; index < 400 && (!document.querySelector('.capability-center') || document.querySelector('.capability-loading')); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const center = document.querySelector('.capability-center');
    const result = {
      center: Boolean(center),
      plugins: [...(center?.querySelectorAll('summary') || [])].some((item) => item.textContent?.includes('插件')),
      pluginSearch: Boolean(center?.querySelector('.plugin-toolbar input')),
      marketplaceAdd: [...(center?.querySelectorAll('.marketplace-add button') || [])].some((button) => button.textContent?.includes('添加市场')),
      skills: [...(center?.querySelectorAll('summary') || [])].some((item) => item.textContent?.includes('Skills')),
      mcp: [...(center?.querySelectorAll('summary') || [])].some((item) => item.textContent?.includes('MCP 连接')),
      refresh: [...(center?.querySelectorAll('button') || [])].some((button) => button.textContent?.includes('重新检测')),
      settled: !center?.querySelector('.capability-loading'),
      update: [...document.querySelectorAll('.app-update-settings button')].some((button) => button.textContent?.includes('检查更新') || button.textContent?.includes('开发模式')),
      version: document.querySelector('.app-update-settings')?.textContent?.includes(${JSON.stringify(app.getVersion())}) ?? false,
      codexVersion: /Codex\\s+\\d+\\.\\d+\\.\\d+/.test(document.querySelector('.app-update-settings')?.textContent || ''),
      storage: [...document.querySelectorAll('.platform-status h3')].some((heading) => heading.textContent?.includes('本机数据')),
      tokenUsage: [...document.querySelectorAll('.platform-status h3')].some((heading) => heading.textContent?.includes('已验证回合 Token')),
      dataPath: Boolean(document.querySelector('.platform-status .storage-path')?.textContent?.includes('保存位置')),
      backup: [...document.querySelectorAll('.support-settings h3')].some((heading) => heading.textContent?.includes('对话数据库备份')),
      bridge: typeof window.agentDesktop?.getAppInfo === 'function' && typeof window.agentDesktop?.checkForUpdates === 'function'
    };
    document.querySelector('.settings-modal > header button')?.click();
    return result;
  })()`) as { center: boolean; plugins: boolean; pluginSearch: boolean; marketplaceAdd: boolean; skills: boolean; mcp: boolean; refresh: boolean; settled: boolean; update: boolean; version: boolean; codexVersion: boolean; storage: boolean; tokenUsage: boolean; dataPath: boolean; backup: boolean; bridge: boolean };
  if (!capabilityUi.center || !capabilityUi.plugins || !capabilityUi.pluginSearch || !capabilityUi.marketplaceAdd || !capabilityUi.skills || !capabilityUi.mcp || !capabilityUi.refresh || !capabilityUi.settled || !capabilityUi.update || !capabilityUi.version || !capabilityUi.codexVersion || !capabilityUi.storage || !capabilityUi.tokenUsage || !capabilityUi.dataPath || !capabilityUi.backup || !capabilityUi.bridge) {
    throw new Error(`Capability center UI smoke failed: ${JSON.stringify(capabilityUi)}`);
  }
  const draftUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    const openDraft = async () => {
      document.querySelector('.new-task-button')?.click();
      for (let index = 0; index < 20 && !document.querySelector('.draft-message-composer textarea'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      return document.querySelector('.draft-message-composer textarea');
    };
    let textarea = await openDraft();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(textarea, '这是一条尚未发送的桌面草稿');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const stored = await window.agentDesktop.loadNewTaskDraft();
    const encrypted = stored.encrypted === true;
    const persisted = stored.draft?.prompt === '这是一条尚未发送的桌面草稿';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hidden = !document.querySelector('.draft-message-composer');
    textarea = await openDraft();
    const restored = textarea?.value === '这是一条尚未发送的桌面草稿';
    const protectedLabel = document.querySelector('.draft-conversation-header')?.textContent?.includes('已自动保存在本机') ?? false;
    [...document.querySelectorAll('.draft-conversation-header button')].find((button) => button.textContent?.includes('丢弃草稿'))?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const clearedOnDisk = (await window.agentDesktop.loadNewTaskDraft()).draft === null;
    textarea = await openDraft();
    const discarded = textarea?.value === '';
    [...document.querySelectorAll('.draft-conversation-header button')].find((button) => button.textContent?.includes('丢弃草稿'))?.click();
    return { hidden, restored, encrypted, persisted, protectedLabel, clearedOnDisk, discarded };
  })()`) as { hidden: boolean; restored: boolean; encrypted: boolean; persisted: boolean; protectedLabel: boolean; clearedOnDisk: boolean; discarded: boolean };
  if (!draftUi.hidden || !draftUi.restored || !draftUi.encrypted || !draftUi.persisted || !draftUi.protectedLabel || !draftUi.clearedOnDisk || !draftUi.discarded) throw new Error(`Draft protection UI smoke failed: ${JSON.stringify(draftUi)}`);
  const draftPreparedForReload = await mainWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('.new-task-button')?.click();
    for (let index = 0; index < 20 && !document.querySelector('.draft-message-composer textarea'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const textarea = document.querySelector('.draft-message-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '跨窗口重载恢复草稿');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    return (await window.agentDesktop.loadNewTaskDraft()).draft?.prompt === '跨窗口重载恢复草稿';
  })()`) as boolean;
  if (!draftPreparedForReload) throw new Error("Encrypted draft was not ready before renderer reload");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Renderer reload timed out during draft recovery smoke")), 12_000);
    mainWindow!.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
    mainWindow!.webContents.reload();
  });
  const draftReloadUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    for (let index = 0; index < 80 && !document.querySelector('.draft-message-composer textarea'); index += 1) {
      document.querySelector('.new-task-button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let index = 0; index < 80 && document.querySelector('.draft-message-composer textarea')?.value !== '跨窗口重载恢复草稿'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const restored = document.querySelector('.draft-message-composer textarea')?.value === '跨窗口重载恢复草稿';
    [...document.querySelectorAll('.draft-conversation-header button')].find((button) => button.textContent?.includes('丢弃草稿'))?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { restored, cleared: (await window.agentDesktop.loadNewTaskDraft()).draft === null };
  })()`) as { restored: boolean; cleared: boolean };
  if (!draftReloadUi.restored || !draftReloadUi.cleared) throw new Error(`Encrypted draft reload smoke failed: ${JSON.stringify(draftReloadUi)}`);
  const followUpDraftUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    const selectTask = async (title) => {
      for (let index = 0; index < 60 && document.querySelector('.task-title')?.textContent !== title; index += 1) {
        [...document.querySelectorAll('.thread-row')].find((button) => button.textContent?.includes(title))?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (let index = 0; index < 40 && !document.querySelector('.composer-dock .message-composer:not(.draft-message-composer) textarea'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      return document.querySelector('.composer-dock .message-composer:not(.draft-message-composer) textarea');
    };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    let textarea = await selectTask('窗口验收 B');
    setter?.call(textarea, '');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    textarea = await selectTask('窗口验收 A');
    setter?.call(textarea, 'A 对话的未发送追问');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const firstPersisted = (await window.agentDesktop.loadFollowUpDraft(${JSON.stringify(firstTaskId)})).draft?.content === 'A 对话的未发送追问';
    textarea = await selectTask('窗口验收 B');
    const secondInitiallyEmpty = textarea?.value === '';
    setter?.call(textarea, 'B 对话的独立草稿');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    textarea = await selectTask('窗口验收 A');
    for (let index = 0; index < 40 && textarea?.value !== 'A 对话的未发送追问'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      textarea = document.querySelector('.composer-dock .message-composer:not(.draft-message-composer) textarea');
    }
    const firstRestored = textarea?.value === 'A 对话的未发送追问';
    const secondPersisted = (await window.agentDesktop.loadFollowUpDraft(${JSON.stringify(secondTaskId)})).draft?.content === 'B 对话的独立草稿';
    return { firstPersisted, secondInitiallyEmpty, firstRestored, secondPersisted };
  })()`) as { firstPersisted: boolean; secondInitiallyEmpty: boolean; firstRestored: boolean; secondPersisted: boolean };
  if (!followUpDraftUi.firstPersisted || !followUpDraftUi.secondInitiallyEmpty || !followUpDraftUi.firstRestored || !followUpDraftUi.secondPersisted) throw new Error(`Per-conversation draft isolation smoke failed: ${JSON.stringify(followUpDraftUi)}`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Renderer reload timed out during follow-up draft recovery smoke")), 12_000);
    mainWindow!.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
    mainWindow!.webContents.reload();
  });
  const followUpReloadUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    for (let index = 0; index < 80 && document.querySelector('.task-title')?.textContent !== '窗口验收 A'; index += 1) {
      [...document.querySelectorAll('.thread-row')].find((button) => button.textContent?.includes('窗口验收 A'))?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let index = 0; index < 80 && document.querySelector('.composer-dock .message-composer:not(.draft-message-composer) textarea')?.value !== 'A 对话的未发送追问'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const textarea = document.querySelector('.composer-dock .message-composer:not(.draft-message-composer) textarea');
    const restored = textarea?.value === 'A 对话的未发送追问';
    const protectedLabel = document.querySelector('.composer-hint')?.textContent?.includes('草稿已加密保存') ?? false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '');
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await window.agentDesktop.saveFollowUpDraft(${JSON.stringify(secondTaskId)}, null);
    return { restored, protectedLabel, cleared: (await window.agentDesktop.loadFollowUpDraft(${JSON.stringify(firstTaskId)})).draft === null };
  })()`) as { restored: boolean; protectedLabel: boolean; cleared: boolean };
  if (!followUpReloadUi.restored || !followUpReloadUi.protectedLabel || !followUpReloadUi.cleared) throw new Error(`Follow-up draft reload smoke failed: ${JSON.stringify(followUpReloadUi)}`);
  const goalUi = await mainWindow.webContents.executeJavaScript(`(async () => {
    document.querySelector('.new-task-button')?.click();
    for (let index = 0; index < 20 && !document.querySelector('.draft-message-composer'); index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const composer = document.querySelector('.draft-message-composer');
    const label = [...(composer?.querySelectorAll('label') || [])].find((item) => item.textContent?.includes('持续目标'));
    const checkbox = label?.querySelector('input[type=checkbox]');
    checkbox?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = { composer: Boolean(composer), goalToggle: Boolean(checkbox), maxTurns: [...(composer?.querySelectorAll('label') || [])].some((item) => item.textContent?.includes('最多轮次')), deadline: [...(composer?.querySelectorAll('label') || [])].some((item) => item.textContent?.includes('截止时间')), tokenBudget: [...(composer?.querySelectorAll('label') || [])].some((item) => item.textContent?.includes('Token 预算')) };
    [...document.querySelectorAll('.draft-conversation-header button')].find((button) => button.textContent?.includes('丢弃草稿'))?.click();
    return result;
  })()`) as { composer: boolean; goalToggle: boolean; maxTurns: boolean; deadline: boolean; tokenBudget: boolean };
  if (!goalUi.composer || !goalUi.goalToggle || !goalUi.maxTurns || !goalUi.deadline || !goalUi.tokenBudget) throw new Error(`Persistent goal UI smoke failed: ${JSON.stringify(goalUi)}`);
  await Promise.all([
    mainWindow.webContents.executeJavaScript(`window.agentDesktop.detachConversation(${JSON.stringify(firstTaskId)}, undefined, true)`),
    mainWindow.webContents.executeJavaScript(`window.agentDesktop.detachConversation(${JSON.stringify(secondTaskId)}, undefined, true)`),
  ]);
  if (detachedWindows.size !== 2) throw new Error(`Window smoke expected 2 detached conversations, got ${detachedWindows.size}`);
  for (const [taskId, window] of detachedWindows) {
    let state = { detached: false, sidebarCount: -1, composerCount: 0, selectedTask: "" };
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      state = await window.webContents.executeJavaScript(`({
        detached: document.querySelector('.app-shell.detached') !== null,
        sidebarCount: document.querySelectorAll('.sidebar').length,
        composerCount: document.querySelectorAll('.message-composer textarea').length,
        selectedTask: new URLSearchParams(location.search).get('task') || ''
      })`) as typeof state;
      if (state.detached && state.sidebarCount === 0 && state.composerCount === 1 && state.selectedTask === taskId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!state.detached || state.sidebarCount !== 0 || state.composerCount !== 1 || state.selectedTask !== taskId) {
      throw new Error(`Detached window smoke failed for ${taskId}: ${JSON.stringify(state)}`);
    }
    if (taskId === secondTaskId) {
      window.setSize(720, 560);
      window.webContents.setZoomFactor(1.5);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const compactLayout = await window.webContents.executeJavaScript(`(() => {
        const composer = document.querySelector('.message-composer');
        const runtimeBar = composer?.querySelector('.composer-runtime-bar');
        if (!composer || !runtimeBar) return { error: 'composer unavailable' };
        const tray = document.createElement('div');
        tray.className = 'attachment-previews smoke-attachment-previews';
        for (let index = 0; index < 20; index += 1) {
          const card = document.createElement('div');
          card.className = 'attachment-preview-card file';
          card.textContent = '附件 ' + (index + 1);
          tray.appendChild(card);
        }
        composer.insertBefore(tray, runtimeBar);
        const sendButton = composer.querySelector('.send-button');
        const send = sendButton?.getBoundingClientRect();
        const toolbar = composer.querySelector('.composer-toolbar')?.getBoundingClientRect();
        const dock = composer.closest('.composer-dock')?.getBoundingClientRect();
        const hitTarget = send ? document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2) : null;
        const sendClickable = Boolean(sendButton && hitTarget && (hitTarget === sendButton || sendButton.contains(hitTarget)));
        tray.remove();
        return {
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          sendLeft: send?.left ?? -1,
          sendRight: send?.right ?? -1,
          sendTop: send?.top ?? -1,
          sendBottom: send?.bottom ?? -1,
          sendClickable,
          hitTarget: hitTarget ? [hitTarget.tagName, hitTarget.className].join('.') : 'none',
          toolbarBottom: toolbar?.bottom ?? -1,
          dockBottom: dock?.bottom ?? -1
        };
      })()`) as { error?: string; viewportHeight?: number; viewportWidth?: number; sendLeft?: number; sendRight?: number; sendTop?: number; sendBottom?: number; sendClickable?: boolean; hitTarget?: string; toolbarBottom?: number; dockBottom?: number };
      const viewportHeight = compactLayout.viewportHeight ?? 0;
      if (compactLayout.error || !compactLayout.sendClickable || (compactLayout.sendTop ?? -1) < 0 || (compactLayout.sendBottom ?? Infinity) > viewportHeight + 1) {
        throw new Error(`Compact composer fell outside the viewport: ${JSON.stringify(compactLayout)}`);
      }
      window.webContents.setZoomFactor(1);
    }
  }
  const duplicate = await mainWindow.webContents.executeJavaScript(`window.agentDesktop.detachConversation(${JSON.stringify(firstTaskId)}, undefined, true)`) as { existing: boolean };
  if (!duplicate.existing || detachedWindows.size !== 2) throw new Error("Duplicate detached conversation created another window");
  const secondWindow = detachedWindows.get(secondTaskId);
  if (!secondWindow) throw new Error("Second detached conversation disappeared before reattach test");
  await secondWindow.webContents.executeJavaScript(`void window.agentDesktop.reattachConversation(${JSON.stringify(secondTaskId)}); true`);
  const reattachDeadline = Date.now() + 4_000;
  while (!secondWindow.isDestroyed() && Date.now() < reattachDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!secondWindow.isDestroyed() || detachedWindows.has(secondTaskId)) throw new Error("Reattached conversation window did not close");
  console.log("Conversation window smoke test passed (2 independent conversation windows)");
}

async function createWindow(siteOrigin: string, apiOrigin: string): Promise<void> {
  ipcMain.removeHandler("agent:get-app-info");
  ipcMain.handle("agent:get-app-info", () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, codexVersion: bundledCodexVersion() }));
  ipcMain.removeHandler("agent:check-for-updates");
  ipcMain.handle("agent:check-for-updates", () => checkForUpdates());
  ipcMain.removeHandler("agent:load-new-task-draft");
  ipcMain.handle("agent:load-new-task-draft", () => {
    if (!safeStorage.isEncryptionAvailable()) return { encrypted: false, draft: null };
    return { encrypted: true, draft: readEncryptedDraft(pendingDraftPath(), (value) => safeStorage.decryptString(value)) };
  });
  ipcMain.removeHandler("agent:save-new-task-draft");
  ipcMain.handle("agent:save-new-task-draft", (_event, draft: unknown) => {
    if (draft === null) { clearEncryptedDraft(pendingDraftPath()); return true; }
    if (!safeStorage.isEncryptionAvailable()) return false;
    writeEncryptedDraft(pendingDraftPath(), draft, (value) => safeStorage.encryptString(value));
    return true;
  });
  ipcMain.removeHandler("agent:load-follow-up-draft");
  ipcMain.handle("agent:load-follow-up-draft", (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || !safeStorage.isEncryptionAvailable()) return { encrypted: false, draft: null };
    return { encrypted: true, draft: readEncryptedFollowUpDraft(pendingFollowUpDraftsPath(), taskId, (value) => safeStorage.decryptString(value)) };
  });
  ipcMain.removeHandler("agent:save-follow-up-draft");
  ipcMain.handle("agent:save-follow-up-draft", (_event, taskId: unknown, draft: unknown) => {
    if (typeof taskId !== "string") throw new Error("对话标识无效");
    if (draft === null) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      writeEncryptedFollowUpDraft(pendingFollowUpDraftsPath(), taskId, null, (value) => safeStorage.encryptString(value), (value) => safeStorage.decryptString(value));
      return true;
    }
    if (!safeStorage.isEncryptionAvailable()) return false;
    writeEncryptedFollowUpDraft(pendingFollowUpDraftsPath(), taskId, draft, (value) => safeStorage.encryptString(value), (value) => safeStorage.decryptString(value));
    return true;
  });
  ipcMain.removeHandler("agent:detach-conversation");
  ipcMain.handle("agent:detach-conversation", async (event, requestedTaskId: unknown, requestedPoint: unknown, force: unknown) => {
    if (typeof requestedTaskId !== "string" || !/^[a-z0-9-]{8,80}$/i.test(requestedTaskId)) {
      throw new Error("对话标识无效");
    }
    if (!agentApplication?.store.getTask(requestedTaskId)) throw new Error("对话不存在或已删除");
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    const point = isScreenPoint(requestedPoint) ? requestedPoint : undefined;
    if (force !== true) {
      if (!sourceWindow || !point || !isPointOutsideWindow(point, sourceWindow.getBounds())) {
        return { detached: false, existing: false };
      }
    }
    return openDetachedConversation(siteOrigin, apiOrigin, requestedTaskId, point);
  });
  ipcMain.removeHandler("agent:reattach-conversation");
  ipcMain.handle("agent:reattach-conversation", async (event, requestedTaskId: unknown) => {
    if (typeof requestedTaskId !== "string" || !/^[a-z0-9-]{8,80}$/i.test(requestedTaskId)) return false;
    if (!agentApplication?.store.getTask(requestedTaskId)) return false;
    showMainWindow();
    mainWindow?.webContents.send("agent:focus-conversation", requestedTaskId);
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow && sourceWindow !== mainWindow && !sourceWindow.isDestroyed()) sourceWindow.close();
    return true;
  });
  ipcMain.removeHandler("agent:select-workspace");
  ipcMain.handle("agent:select-workspace", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "选择 Agent 工作区",
      buttonLabel: "选择此文件夹",
      properties: ["openDirectory", "createDirectory"],
    };
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.removeHandler("agent:select-files");
  ipcMain.handle("agent:select-files", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "选择要交给 Agent 的图片或附件", buttonLabel: "添加附件", properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.removeHandler("agent:open-workspace");
  ipcMain.handle("agent:open-workspace", async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) {
      return "工作区路径无效";
    }
    const resolvedPath = path.resolve(requestedPath);
    try {
      if (!fs.statSync(resolvedPath).isDirectory()) return "工作区不是文件夹";
    } catch {
      return "工作区不存在";
    }
    return (await shell.openPath(resolvedPath)) || null;
  });
  ipcMain.removeHandler("agent:browse-directory");
  ipcMain.handle("agent:browse-directory", async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) throw new Error("目录路径无效");
    const directory = path.resolve(requestedPath);
    if (!fs.statSync(directory).isDirectory()) throw new Error("路径不是文件夹");
    const parent = path.dirname(directory);
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name, "zh-CN"))
      .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name), type: entry.isDirectory() ? "directory" : "file" }));
    return { path: directory, parent: parent === directory ? null : parent, entries };
  });
  ipcMain.removeHandler("agent:read-local-file");
  ipcMain.handle("agent:read-local-file", async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) throw new Error("文件路径无效");
    const filePath = path.resolve(requestedPath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("路径不是文件");
    const extension = path.extname(filePath).toLowerCase();
    const mediaTypes: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
    const mime = mediaTypes[extension];
    if (mime) {
      if (stat.size > 30_000_000) return { path: filePath, kind: "external", size: stat.size, reason: "文件超过 30 MB，请使用系统应用打开" };
      const buffer = fs.readFileSync(filePath);
      return { path: filePath, kind: extension === ".pdf" ? "pdf" : "image", mime, size: stat.size, dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
    }
    if (stat.size > 2_000_000) return { path: filePath, kind: "external", size: stat.size, reason: "文件超过 2 MB 文本编辑上限，请使用系统应用打开" };
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return { path: filePath, kind: "external", size: stat.size, reason: "此二进制格式不支持内嵌编辑，请使用系统应用打开" };
    return { path: filePath, kind: "text", size: stat.size, content: buffer.toString("utf8") };
  });
  ipcMain.removeHandler("agent:write-local-text-file");
  ipcMain.handle("agent:write-local-text-file", async (_event, requestedPath: unknown, content: unknown) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath) || typeof content !== "string") return "文件内容或路径无效";
    if (Buffer.byteLength(content, "utf8") > 2_000_000) return "文件超过 2 MB 文本编辑上限";
    try { if (!fs.statSync(requestedPath).isFile()) return "路径不是文件"; fs.writeFileSync(path.resolve(requestedPath), content, "utf8"); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  ipcMain.removeHandler("agent:open-path");
  ipcMain.handle("agent:open-path", async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) return "路径无效";
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) return "路径不存在";
    return (await shell.openPath(resolvedPath)) || null;
  });

  ipcMain.removeHandler("agent:save-clipboard-image");
  ipcMain.handle("agent:save-clipboard-image", async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const directory = path.join(process.env.AGENT_DATA_DIR!, "clipboard");
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `clipboard-${Date.now()}.png`);
    fs.writeFileSync(target, image.toPNG());
    return target;
  });
  ipcMain.removeHandler("agent:set-theme");
  ipcMain.handle("agent:set-theme", (_event, theme: unknown) => {
    nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system";
    return nativeTheme.shouldUseDarkColors;
  });
  ipcMain.removeHandler("agent:show-notification");
  ipcMain.handle("agent:show-notification", (_event, taskId: unknown, title: unknown, body: unknown) => {
    if (typeof taskId !== "string" || !/^[a-z0-9-]{8,80}$/i.test(taskId) || !agentApplication?.store.getTask(taskId)) return false;
    if (typeof title !== "string" || typeof body !== "string") return false;
    return notify(title.slice(0, 80), body.slice(0, 280), taskId);
  });
  ipcMain.removeHandler("agent:prepare-feedback-bundle");
  ipcMain.handle("agent:prepare-feedback-bundle", async () => prepareSupportBundle(true));

  const windowState = readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(typeof windowState.x === "number" && typeof windowState.y === "number" ? { x: windowState.x, y: windowState.y } : {}),
    minWidth: 1050,
    minHeight: 680,
    show: false,
    backgroundColor: "#f4f1ea",
    title: "Agent Foundry",
    webPreferences: browserWindowPreferences(),
  });
  configureBrowserWindow(mainWindow, siteOrigin);
  mainWindow.once("ready-to-show", () => { if (windowState.maximized) mainWindow?.maximize(); mainWindow?.show(); });
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (mainWindow) writeWindowState(mainWindow); }, 250); };
  mainWindow.on("move", scheduleSave); mainWindow.on("resize", scheduleSave); mainWindow.on("maximize", scheduleSave); mainWindow.on("unmaximize", scheduleSave);
  mainWindow.on("close", (event) => { if (!isQuitting && !smokeTest) { event.preventDefault(); mainWindow?.hide(); } });
  mainWindow.on("closed", () => { if (saveTimer) clearTimeout(saveTimer); mainWindow = null; });
  await mainWindow.loadURL(`${siteOrigin}/?api=${encodeURIComponent(apiOrigin)}`);
}

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  void shutdownAndQuit();
});

app.on("window-all-closed", () => { if (smokeTest || isQuitting) void shutdownAndQuit(); });

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    try {
      smokeProgress("app ready; starting services");
      const { apiOrigin, siteOrigin } = await startServices();
      smokeProgress("services started");
      if (windowSmokeTest) {
        await runConversationWindowSmokeTest(siteOrigin, apiOrigin);
        smokeProgress("window smoke passed; shutting down");
        await shutdownAndQuit();
        return;
      }
      if (smokeTest) {
        await runSmokeTest(apiOrigin, siteOrigin);
        smokeProgress("shutting down after pass");
        await shutdownAndQuit();
        return;
      }
      installMenu();
      await createWindow(siteOrigin, apiOrigin);
      installTray();
      startTaskMonitor();
      initializeUpdater();
      watchConfigFile();
    } catch (error) {
      console.error(error);
      appendCrashLog("startup", error);
      if (!smokeTest) {
        await dialog.showMessageBox({
          type: "error",
          title: "Agent Foundry 启动失败",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await shutdownAndQuit(1);
    }
  });
}
