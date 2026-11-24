// Preload for the Coach panel view (sandboxed): a narrow bridge to the main process.
import { contextBridge, ipcRenderer } from 'electron';
import type { CoachState, PracticeStatus } from '../shared/types';

export type CoachAction =
  | { type: 'start-session' }
  | { type: 'quick' }
  | { type: 'continue' }
  | { type: 'end-session' }
  | { type: 'retest' }
  | { type: 'benchmark' }
  | { type: 'set-benchmark'; key: string }
  | { type: 'reset-period' }
  | { type: 'start-baseline'; key: string }
  | { type: 'set-setting'; key: 'hints' | 'warmup'; value: boolean };

const on = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  getState: (): Promise<CoachState> => ipcRenderer.invoke('wwc:get-state'),
  act: (action: CoachAction): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('wwc:act', action),
  /** The panel finished its closing animation: hide the view and give the keyboard back to the test. */
  closed: (): void => ipcRenderer.send('wwc:panel-closed'),
  /** Asks to close (the main process replies with onClose so the panel can animate out). */
  requestClose: (): void => ipcRenderer.send('wwc:panel-request-close'),
  onStateChanged: (cb: () => void) => on('wwc:state-changed', cb),
  onPracticeStatus: (cb: (s: PracticeStatus) => void) => on('wwc:practice-status', cb),
  onOpen: (cb: () => void) => on('wwc:panel-open', cb),
  onClose: (cb: () => void) => on('wwc:panel-close', cb),
};

export type CoachApi = typeof api;
contextBridge.exposeInMainWorld('coach', api);
