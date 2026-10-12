import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('cuhk', {
  load: (days: number) => ipcRenderer.invoke('cuhk:load', days),
  status: () => ipcRenderer.invoke('cuhk:status'),
  cancel: () => ipcRenderer.invoke('cuhk:cancel'),
  close: () => ipcRenderer.invoke('cuhk:close'),
  restore: () => ipcRenderer.invoke('cuhk:restore'),
  complete: (key: string, value: boolean | null) => ipcRenderer.invoke('cuhk:complete', key, value),
  setDueOverride: (target: { courseId: string; id: string }, value: string | null) => ipcRenderer.invoke('cuhk:due-override', target, value),
  markAnnouncementSeen: (target: { courseId: string; id: string }, value: boolean) => ipcRenderer.invoke('cuhk:announcement-seen', target, value),
  login: (action: 'begin' | 'complete' = 'begin') => ipcRenderer.invoke('cuhk:login', action),
  detail: (target: { courseId: string; id: string }) => ipcRenderer.invoke('cuhk:detail', target),
  readResource: (resourceId: string, kind: 'image' = 'image') => ipcRenderer.invoke('cuhk:resource-read', resourceId, kind),
  openSource: (target: { kind: 'course' | 'announcement' | 'assignment' | 'file' | 'attachment'; id: string; courseId?: string }) => ipcRenderer.invoke('cuhk:open-source', target),
  course: (id: string, resource: string) => ipcRenderer.invoke('cuhk:course', id, resource),
  migrationPreview: () => ipcRenderer.invoke('cuhk:migration-preview'),
  migrationConfirm: (migrationId: string, confirmAccount: boolean, selections: Array<{ legacyKey: string; newKey: string }> = []) => ipcRenderer.invoke('cuhk:migration-confirm', migrationId, confirmAccount, selections),
  debugEvent: (eventName: string, details?: unknown) => ipcRenderer.invoke('cuhk:debug-event', eventName, details ?? {}),
  debugInfo: () => ipcRenderer.invoke('cuhk:debug-info'),
  openDiagnostics: () => ipcRenderer.invoke('cuhk:open-diagnostics'),
  copyDiagnostics: () => ipcRenderer.invoke('cuhk:copy-diagnostics'),
});
try {
  void ipcRenderer.invoke('cuhk:debug-event', 'renderer.bridge-ready', { marker: 'CUHK_DASHBOARD_BRIDGE_READY' }).catch(() => undefined);
} catch {
  // The renderer has a fixed console marker even if the diagnostic bridge is unavailable.
}
