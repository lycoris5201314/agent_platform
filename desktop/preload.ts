import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentDesktop", {
  selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("agent:select-workspace"),
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke("agent:select-files"),
  openWorkspace: (workspacePath: string): Promise<string | null> =>
    ipcRenderer.invoke("agent:open-workspace", workspacePath),
  browseDirectory: (directoryPath: string): Promise<unknown> => ipcRenderer.invoke("agent:browse-directory", directoryPath),
  readLocalFile: (filePath: string): Promise<unknown> => ipcRenderer.invoke("agent:read-local-file", filePath),
  writeLocalTextFile: (filePath: string, content: string): Promise<string | null> => ipcRenderer.invoke("agent:write-local-text-file", filePath, content),
  openPath: (filePath: string): Promise<string | null> => ipcRenderer.invoke("agent:open-path", filePath),
});
