import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("agentDesktop", {
  getAppInfo: (): Promise<{ version: string; packaged: boolean; platform: string; arch: string; codexVersion: string }> => ipcRenderer.invoke("agent:get-app-info"),
  checkForUpdates: (): Promise<{ status: string; currentVersion: string; availableVersion?: string; error?: string }> => ipcRenderer.invoke("agent:check-for-updates"),
  getUpdateAccessStatus: (): Promise<{ configured: boolean; encrypted: boolean; source: "environment" | "encrypted" | "none" }> => ipcRenderer.invoke("agent:get-update-access-status"),
  saveUpdateAccessToken: (token: string | null): Promise<{ configured: boolean; encrypted: boolean; source: "environment" | "encrypted" | "none" }> => ipcRenderer.invoke("agent:save-update-access-token", token),
  openUpdateTokenPage: (): Promise<void> => ipcRenderer.invoke("agent:open-update-token-page"),
  loadNewTaskDraft: (): Promise<{ encrypted: boolean; draft: unknown | null }> => ipcRenderer.invoke("agent:load-new-task-draft"),
  saveNewTaskDraft: (draft: unknown | null): Promise<boolean> => ipcRenderer.invoke("agent:save-new-task-draft", draft),
  loadFollowUpDraft: (taskId: string): Promise<{ encrypted: boolean; draft: unknown | null }> => ipcRenderer.invoke("agent:load-follow-up-draft", taskId),
  saveFollowUpDraft: (taskId: string, draft: unknown | null): Promise<boolean> => ipcRenderer.invoke("agent:save-follow-up-draft", taskId, draft),
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
  restoreConversationDatabase: (): Promise<{ status: "cancelled" | "restarting"; source?: string; safetyBackup?: string }> => ipcRenderer.invoke("agent:restore-conversation-database"),
  setTheme: (theme: "system" | "light" | "dark"): Promise<boolean> => ipcRenderer.invoke("agent:set-theme", theme),
  showNotification: (taskId: string, title: string, body: string): Promise<boolean> => ipcRenderer.invoke("agent:show-notification", taskId, title, body),
  detachConversation: (taskId: string, point?: { x: number; y: number }, force = false): Promise<{ detached: boolean; existing: boolean }> => ipcRenderer.invoke("agent:detach-conversation", taskId, point, force),
  reattachConversation: (taskId: string): Promise<boolean> => ipcRenderer.invoke("agent:reattach-conversation", taskId),
  onFocusConversation: (callback: (taskId: string) => void): (() => void) => {
    ipcRenderer.removeAllListeners("agent:focus-conversation");
    const listener = (_event: Electron.IpcRendererEvent, taskId: string) => callback(taskId);
    ipcRenderer.on("agent:focus-conversation", listener);
    return () => ipcRenderer.removeListener("agent:focus-conversation", listener);
  },
});
