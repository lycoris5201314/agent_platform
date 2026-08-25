import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { createAgentApplication, type AgentApplication } from "../server/app.js";
import { startDesktopSite, type DesktopSite } from "./site-server.js";

const smokeTest = process.argv.includes("--smoke-test");
const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let agentApplication: AgentApplication | null = null;
let desktopSite: DesktopSite | null = null;
let configPath = "";
let stopping = false;
let smokeDataDirectory = "";

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
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
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
      // A portable EXE may live in a read-only folder; userData is the safe fallback.
    }
  }
  if (!selected) throw new Error("无法创建 agent.env 配置文件");
  process.loadEnvFile(selected);
  if (smokeTest) {
    smokeDataDirectory = path.join(app.getPath("temp"), `agent-foundry-smoke-${process.pid}`);
    fs.mkdirSync(smokeDataDirectory, { recursive: true });
    process.env.AGENT_DATA_DIR = smokeDataDirectory;
    process.env.AGENT_RUNTIME = "mock";
    process.env.AGENT_SANDBOX = "wsl2";
  } else {
    process.env.AGENT_DATA_DIR ??= path.join(app.getPath("userData"), "data");
  }
  configureCodexExecutable();
  configureDockerExecutable();
  Object.assign(process.env, { NODE_ENV: "production" });
  return selected;
}

async function openConfig(): Promise<void> {
  const error = await shell.openPath(configPath);
  if (error) await dialog.showMessageBox({ type: "error", title: "无法打开配置", message: error });
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Agent Foundry",
      submenu: [
        { label: "编辑 API Key 配置", click: () => void openConfig() },
        { label: "打开数据目录", click: () => void shell.openPath(process.env.AGENT_DATA_DIR!) },
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
  const site = desktopSite;
  const agent = agentApplication;
  desktopSite = null;
  agentApplication = null;
  await Promise.allSettled([site?.close(), agent?.close()]);
}

async function shutdownAndQuit(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stopServices();
  if (smokeDataDirectory) {
    try { fs.rmSync(smokeDataDirectory, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
    smokeDataDirectory = "";
  }
  app.exit(exitCode);
}

async function runSmokeTest(apiOrigin: string, siteOrigin: string): Promise<void> {
  const [health, page] = await Promise.all([
    fetch(`${apiOrigin}/api/health`),
    fetch(`${siteOrigin}/`),
  ]);
  if (!health.ok || !page.ok || !(await page.text()).includes("Agent Foundry")) {
    throw new Error(`Desktop smoke test failed: API ${health.status}, Web ${page.status}`);
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
  console.log(`Desktop smoke test passed (${siteOrigin}, ${apiOrigin}, ${codex.stdout.trim()})`);
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
      title: "选择要交给 Agent 的附件", buttonLabel: "添加附件", properties: ["openFile", "multiSelections"],
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
    const mediaTypes: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
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

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
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
  const keepLocalNavigation = (event: Electron.Event, url: string) => {
    try {
      if (new URL(url).origin !== siteOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on("will-navigate", keepLocalNavigation);
  mainWindow.webContents.on("will-redirect", keepLocalNavigation);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(`${siteOrigin}/?api=${encodeURIComponent(apiOrigin)}`);
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  void shutdownAndQuit();
});

app.on("window-all-closed", () => void shutdownAndQuit());

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    try {
      const { apiOrigin, siteOrigin } = await startServices();
      if (smokeTest) {
        await runSmokeTest(apiOrigin, siteOrigin);
        await shutdownAndQuit();
        return;
      }
      installMenu();
      await createWindow(siteOrigin, apiOrigin);
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
