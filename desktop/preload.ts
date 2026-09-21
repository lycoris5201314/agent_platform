import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("agentDesktop", {
  getAppInfo: (): Promise<{ version: string; packaged: boolean; platform: string; arch: string }> => ipcRenderer.invoke("agent:get-app-info"),
  checkForUpdates: (): Promise<{ status: string; currentVersion: string; availableVersion?: string; error?: string }> => ipcRenderer.invoke("agent:check-for-updates"),
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("agent:select-workspace"),
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke("agent:select-files"),
  openWorkspace: (workspacePath: string): Promise<string | null> =>
    ipcRenderer.invoke("agent:open-workspace", workspacePath),
  browseDirectory: (directoryPath: string): Promise<unknown> => ipcRenderer.invoke("agent:browse-directory", directoryPath),
  readLocalFile: (filePath: string): Promise<unknown> => ipcRenderer.invoke("agent:read-local-file", filePath),
  writeLocalTextFile: (filePath: string, content: string): Promise<string | null> => ipcRenderer.invoke("agent:write-local-text-file", filePath, content),
  openPath: (filePath: string): Promise<string | null> => ipcRenderer.invoke("agent:open-path", filePath),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveClipboardImage: (): Promise<string | null> => ipcRenderer.invoke("agent:save-clipboard-image"),
  prepareFeedbackBundle: (): Promise<{ directory: string; generatedAt: string; taskCount: number }> => ipcRenderer.invoke("agent:prepare-feedback-bundle"),
  setTheme: (theme: "system" | "light" | "dark"): Promise<boolean> => ipcRenderer.invoke("agent:set-theme", theme),
  showNotification: (taskId: string, title: string, body: string): Promise<boolean> => ipcRenderer.invoke("agent:show-notification", taskId, title, body),
  detachConversation: (taskId: string, point?: { x: number; y: number }, force = false): Promise<{ detached: boolean; existing: boolean }> => ipcRenderer.invoke("agent:detach-conversation", taskId, point, force),
  reattachConversation: (taskId: string): Promise<boolean> => ipcRenderer.invoke("agent:reattach-conversation", taskId),
  onFocusConversation: (callback: (taskId: string) => void): void => {
    ipcRenderer.removeAllListeners("agent:focus-conversation");
    ipcRenderer.on("agent:focus-conversation", (_event, taskId: string) => callback(taskId));
  },
});
