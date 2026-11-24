// Preload for the coach window (sandboxed): a narrow bridge to the main process.
import { contextBridge, ipcRenderer } from 'electron';
import type { CoachData } from '../shared/types';

const api = {
  getData: (): Promise<CoachData> => ipcRenderer.invoke('wwc:get-coach-data'),
  /** Calls back after each stored test. Returns an unsubscribe function. */
  onDataChanged(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on('wwc:data-changed', listener);
    return () => ipcRenderer.removeListener('wwc:data-changed', listener);
  },
  /** Calls back as a practice run starts, finishes or fails (also when started by the hotkey). */
  onPracticeStatus(cb: (status: { state: 'running' | 'done' | 'error'; error?: string }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, status: Parameters<typeof cb>[0]) => cb(status);
    ipcRenderer.on('wwc:practice-status', listener);
    return () => ipcRenderer.removeListener('wwc:practice-status', listener);
  },
  startPractice: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('wwc:start-practice'),
};

export type CoachApi = typeof api;
contextBridge.exposeInMainWorld('coach', api);
