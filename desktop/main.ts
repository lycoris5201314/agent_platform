import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, shell, Tray } from "electron";
import updater from "electron-updater";
import { createAgentApplication, type AgentApplication } from "../server/app.js";
import { loadConfig } from "../server/core/config.js";
import { startDesktopSite, type DesktopSite } from "./site-server.js";
import { writeSupportBundle, type SupportBundleResult } from "./support-bundle.js";

const { autoUpdater } = updater;

const realSmokeTest = process.argv.includes("--real-smoke-test");
const smokeTest = process.argv.includes("--smoke-test") || realSmokeTest;
const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
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

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", showMainWindow);
  notification.show();
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
    if (!agentApplication) return;
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
  };
  tick(); taskMonitor = setInterval(tick, 4_000);
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

async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) { await dialog.showMessageBox({ type: "info", title: "检查更新", message: "开发模式不检查更新。" }); return; }
  try {
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    const nextVersion = result?.updateInfo.version;
    if (!nextVersion || nextVersion === app.getVersion()) {
      await dialog.showMessageBox({ type: "info", title: "检查更新", message: `当前已是最新版 ${app.getVersion()}。` });
      return;
    }
    const choice = await dialog.showMessageBox({ type: "info", title: "发现新版本", message: `Agent Foundry ${nextVersion} 可以下载。`, detail: "更新下载失败时会保留当前可运行版本。", buttons: ["下载并安装", "稍后"], defaultId: 0, cancelId: 1 });
    if (choice.response === 0) await autoUpdater.downloadUpdate();
  } catch (error) {
    const choice = await dialog.showMessageBox({ type: "warning", title: "无法自动检查更新", message: error instanceof Error ? error.message : String(error), detail: "如果仓库是私有的，自动更新需要访问凭据；也可以打开 GitHub Release 手动下载。", buttons: ["打开 Release 页面", "关闭"], cancelId: 1 });
    if (choice.response === 0) void shell.openExternal("https://github.com/lycoris5201314/agent_platform/releases");
  }
}

function initializeUpdater(): void {
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
  try { await prepareSupportBundle(false); } catch (error) { appendCrashLog("initial support bundle", error); }
  const apiOrigin = await agentApplication.app.listen({ host: "127.0.0.1", port: 0 });
  desktopSite = await startDesktopSite(path.join(app.getAppPath(), "dist"));
  return { apiOrigin, siteOrigin: desktopSite.origin };
}

async function stopServices(): Promise<void> {
  smokeProgress("stopServices begin");
  if (configPath) fs.unwatchFile(configPath);
  if (configReloadTimer) clearTimeout(configReloadTimer);
  configReloadTimer = null;
  if (taskMonitor) clearInterval(taskMonitor);
  taskMonitor = null;
  if (sleepBlockerId !== null) powerSaveBlocker.stop(sleepBlockerId);
  sleepBlockerId = null;
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
  await new Promise((resolve) => setTimeout(resolve, 600));
  await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions/${session.id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "Write-Output 'PACKAGED_CONPTY_OK'\r" }) });
  const ptyDeadline = Date.now() + 6_000;
  let ptyOutput = "";
  while (Date.now() < ptyDeadline) {
    const sessions = await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions`).then((response) => response.json()) as { sessions: Array<{ id: string; output: string }> };
    ptyOutput = sessions.sessions.find((item) => item.id === session.id)?.output ?? "";
    if (ptyOutput.includes("PACKAGED_CONPTY_OK")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ptyOutput.includes("PACKAGED_CONPTY_OK")) throw new Error("Desktop smoke test failed: packaged ConPTY produced no interactive output");
  await fetch(`${apiOrigin}/api/tasks/${taskId}/terminal/sessions/${session.id}`, { method: "DELETE" });
  console.log(`Desktop smoke test passed (${siteOrigin}, ${apiOrigin}, ${codex.stdout.trim()}, ConPTY ${session.permissionProfile})`);
  smokeProgress(`passed with ConPTY ${session.permissionProfile}`);
}

async function createWindow(siteOrigin: string, apiOrigin: string): Promise<void> {
  ipcMain.removeHandler("agent:select-workspace");
  ipcMain.handle("agent:select-workspace", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择 Agent 工作区",
      buttonLabel: "选择此文件夹",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.removeHandler("agent:select-files");
  ipcMain.handle("agent:select-files", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择要交给 Agent 的图片或附件", buttonLabel: "添加附件", properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), "dist-desktop", "preload.cjs"),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    Menu.buildFromTemplate([
      { role: "undo", label: "撤销", enabled: params.editFlags.canUndo }, { role: "redo", label: "重做", enabled: params.editFlags.canRedo },
      { type: "separator" }, { role: "cut", label: "剪切", enabled: params.editFlags.canCut }, { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
      { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste }, { role: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll },
      ...(params.linkURL ? [{ type: "separator" as const }, { label: "在浏览器中打开链接", click: () => void shell.openExternal(params.linkURL) }] : []),
    ]).popup({ window: mainWindow ?? undefined });
  });
  const keepLocalNavigation = (event: Electron.Event, url: string) => {
    try {
      if (new URL(url).origin !== siteOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on("will-navigate", keepLocalNavigation);
  mainWindow.webContents.on("will-redirect", keepLocalNavigation);
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
