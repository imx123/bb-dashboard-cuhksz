import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('cuhk', {
  load: (days: number) => ipcRenderer.invoke('cuhk:load', days),
  complete: (key: string, value: boolean | null) => ipcRenderer.invoke('cuhk:complete', key, value),
  login: (action: 'begin' | 'complete' = 'begin') => ipcRenderer.invoke('cuhk:login', action),
  course: (id: string, resource: string) => ipcRenderer.invoke('cuhk:course', id, resource),
  resource: (id: string) => ipcRenderer.invoke('cuhk:resource', id),
  open: (url: string) => ipcRenderer.invoke('cuhk:open', url),
  debugEvent: (eventName: string, details?: unknown) => ipcRenderer.invoke('cuhk:debug-event', eventName, details ?? {}),
  debugInfo: () => ipcRenderer.invoke('cuhk:debug-info'),
  openDiagnostics: () => ipcRenderer.invoke('cuhk:open-diagnostics'),
  copyDiagnostics: () => ipcRenderer.invoke('cuhk:copy-diagnostics'),
});
